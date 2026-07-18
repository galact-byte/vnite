import { configLocalDocs } from '@appTypes/models'
import path from 'path'
import { ConfigDBManager, baseDBManager } from '~/core/database'
import { ipcManager } from '~/core/ipc'
import { WebDAVAdapter } from './sync-adapter/webdav-adapter'
import {
  uploadSnapshot,
  downloadSnapshot,
  syncBidirectional,
  getConflictVersions,
  resolveConflict,
  approveSaveDeletion,
  forceRestoreGameFromRemote,
  ConflictInfo,
  ForceRestoreResult,
  Manifest,
  PendingSaveDeletion,
  SyncProgress,
  SyncProgressCallback,
  SyncResult
} from './sync-engine'
import log from 'electron-log/main'
import { decryptStoredPassword } from './password-crypto'

type WebDAVConfig = configLocalDocs['sync']['webdavConfig']

/**
 * The password is stored encrypted (safeStorage) in config-local; decrypt it
 * just before handing the config to the WebDAV adapter. A failed decryption
 * yields an empty password, surfacing as an incomplete-config error.
 */
function withDecryptedPassword(config: WebDAVConfig): WebDAVConfig {
  return {
    ...config,
    auth: { ...config.auth, password: decryptStoredPassword(config.auth.password) }
  }
}

export interface WebDAVSyncOptions {
  /** Suppress renderer progress events (background/auto sync) */
  silent?: boolean
}

const CONFLICTS_DOC_ID = 'webdav-sync-conflicts'
const PENDING_SAVE_DELETIONS_DOC_ID = 'webdav-pending-save-deletions'
const PROGRESS_THROTTLE_DOCS = 10

/**
 * Persist the conflict list to config-local (covering app restarts) and
 * notify the renderer. Each sync overwrites the previous list; an empty
 * result clears it without emitting an event.
 */
async function recordSyncConflicts(conflicts: ConflictInfo[]): Promise<void> {
  const detectedAt = new Date().toISOString()
  const items = conflicts.map((c) => ({ dbName: c.dbName, docId: c.docId, detectedAt }))
  await baseDBManager.setValue('config-local', CONFLICTS_DOC_ID, '#all', {
    items,
    updatedAt: detectedAt
  })
  if (conflicts.length > 0) {
    ipcManager.send('db:sync-conflicts', conflicts)
  }
}

/**
 * Persist the held-back save deletions (config-local, surviving restarts)
 * and notify the renderer. Each upload-capable sync overwrites the list; an
 * empty result clears it without emitting an event.
 */
async function recordPendingSaveDeletions(pending: PendingSaveDeletion[]): Promise<void> {
  const detectedAt = new Date().toISOString()
  const items = pending.map((p) => ({
    gameId: p.gameId,
    removedCount: p.removedCount,
    remoteSaveCount: p.remoteSaveCount,
    clearsHistory: p.clearsHistory,
    detectedAt
  }))
  await baseDBManager.setValue('config-local', PENDING_SAVE_DELETIONS_DOC_ID, '#all', {
    items,
    updatedAt: detectedAt
  })
  if (pending.length > 0) {
    ipcManager.send('db:sync-pending-save-deletions', items)
  }
}

/** Throttled bridge from engine progress callbacks to renderer IPC events. */
function createProgressReporter(): SyncProgressCallback {
  let lastPhase: string | null = null
  let lastDatabase: string | null = null
  let sinceLastSend = 0
  return (progress: SyncProgress): void => {
    sinceLastSend++
    const boundary =
      progress.phase !== lastPhase ||
      progress.database !== lastDatabase ||
      progress.current === progress.total
    if (!boundary && sinceLastSend < PROGRESS_THROTTLE_DOCS) return
    lastPhase = progress.phase
    lastDatabase = progress.database
    sinceLastSend = 0
    ipcManager.send('db:sync-progress', progress)
  }
}

async function writeWebdavStatus(
  attemptAt: string,
  result: SyncResult | null,
  error?: unknown
): Promise<void> {
  try {
    const previous = await ConfigDBManager.getConfigLocalValue('sync.webdavStatus')
    const finishedAt = new Date().toISOString()
    let lastResult: configLocalDocs['sync']['webdavStatus']['lastResult']
    let lastError = ''
    if (result) {
      if (result.errors.length > 0) {
        lastResult = 'error'
        lastError = result.errors.slice(0, 3).join('; ')
      } else if (result.conflicts.length > 0) {
        lastResult = 'conflict'
      } else {
        lastResult = 'success'
      }
    } else {
      lastResult = 'error'
      lastError = error instanceof Error ? error.message : String(error)
    }
    await ConfigDBManager.setConfigLocalValue('sync.webdavStatus', {
      lastAttemptAt: attemptAt,
      lastSuccessAt: lastResult === 'success' ? finishedAt : (previous?.lastSuccessAt ?? ''),
      lastResult,
      lastError,
      lastConflictCount: result?.conflicts.length ?? 0
    })
  } catch (statusError) {
    log.warn('[WebDAV] Failed to persist sync status:', statusError)
  }
}

/** Decrypt + validate the config and build an adapter for one-off operations. */
function createAdapter(rawConfig: WebDAVConfig): { adapter: WebDAVAdapter; remotePath: string } {
  const config = withDecryptedPassword(rawConfig)
  if (!config.url || !config.auth.username) {
    throw new Error('Incomplete WebDAV config')
  }
  return {
    adapter: new WebDAVAdapter(config),
    remotePath: config.remotePath || '/vnite-sync/'
  }
}

/** Remove a single resolved entry from the persisted conflict list. */
async function removeSyncConflict(dbName: string, docId: string): Promise<void> {
  const items = await baseDBManager.getValue<
    Array<{ dbName: string; docId: string; detectedAt: string }>
  >('config-local', CONFLICTS_DOC_ID, 'items', [])
  const remaining = items.filter((item) => !(item.dbName === dbName && item.docId === docId))
  if (remaining.length === items.length) return
  await baseDBManager.setValue('config-local', CONFLICTS_DOC_ID, '#all', {
    items: remaining,
    updatedAt: new Date().toISOString()
  })
}

/**
 * Load both sides of a conflict for the renderer's diff view.
 */
export async function getWebdavConflictDetail(
  rawConfig: WebDAVConfig,
  dbName: string,
  docId: string
): Promise<{
  success: boolean
  message?: string
  local?: Record<string, unknown> | null
  remote?: Record<string, unknown> | null
  remoteDeleted?: boolean
}> {
  try {
    const { adapter, remotePath } = createAdapter(rawConfig)
    const versions = await getConflictVersions(adapter, remotePath, dbName, docId)
    return { success: true, ...versions }
  } catch (error: any) {
    log.error(`[WebDAV] Failed to load conflict detail for ${dbName}/${docId}:`, error)
    return { success: false, message: error?.message || 'Failed to load conflict detail' }
  }
}

/**
 * Resolve a single conflict (keep local / use remote) and drop it from the
 * persisted conflict list on success.
 */
export async function resolveWebdavConflict(
  rawConfig: WebDAVConfig,
  dbName: string,
  docId: string,
  choice: 'local' | 'remote'
): Promise<{ success: boolean; message?: string }> {
  try {
    const { adapter, remotePath } = createAdapter(rawConfig)
    await resolveConflict(adapter, remotePath, dbName, docId, choice)
  } catch (error: any) {
    log.error(`[WebDAV] Failed to resolve conflict ${dbName}/${docId} (${choice}):`, error)
    return { success: false, message: error?.message || 'Failed to resolve conflict' }
  }
  try {
    await removeSyncConflict(dbName, docId)
  } catch (error) {
    // Resolution itself succeeded; a stale list entry is cleared by the next sync
    log.warn('[WebDAV] Failed to update conflict list after resolution:', error)
  }
  return { success: true }
}

/**
 * User confirmed propagating an abnormal save deletion for one game:
 * record a one-shot approval and re-run the upload phase so the held-back
 * doc (and the deletion) reaches the remote. The refreshed pending list is
 * persisted from the upload result.
 */
export async function confirmWebdavSaveDeletion(
  rawConfig: WebDAVConfig,
  gameId: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const { adapter, remotePath } = createAdapter(rawConfig)
    await approveSaveDeletion(gameId)
    const result = await uploadSnapshot(adapter, remotePath)
    await recordPendingSaveDeletions(result.pendingSaveDeletions)
    return { success: true }
  } catch (error: any) {
    log.error(`[WebDAV] Failed to confirm save deletion for ${gameId}:`, error)
    return { success: false, message: error?.message || 'Failed to confirm save deletion' }
  }
}

/**
 * User chose to keep the cloud saves: drop the entry from the pending list.
 * Nothing is uploaded — the remote keeps its saves, and as long as the local
 * doc still lacks them the next sync holds the doc back and re-prompts.
 */
export async function dismissWebdavSaveDeletion(
  gameId: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const items = await baseDBManager.getValue<
      Array<{ gameId: string; removedCount: number; detectedAt: string }>
    >('config-local', PENDING_SAVE_DELETIONS_DOC_ID, 'items', [])
    const remaining = items.filter((item) => item.gameId !== gameId)
    if (remaining.length !== items.length) {
      await baseDBManager.setValue('config-local', PENDING_SAVE_DELETIONS_DOC_ID, '#all', {
        items: remaining,
        updatedAt: new Date().toISOString()
      })
    }
    return { success: true }
  } catch (error: any) {
    log.error(`[WebDAV] Failed to dismiss save deletion for ${gameId}:`, error)
    return { success: false, message: error?.message || 'Failed to dismiss save deletion' }
  }
}

/**
 * R2: force-restore one game's doc + save attachments from the remote,
 * bypassing the three-way merge for that doc. Destructive for the local
 * copy; the renderer gates it behind a double confirmation and re-invokes
 * with `confirmedOlder` when the engine reports 'remote-older'.
 */
export async function forceRestoreWebdavGame(
  rawConfig: WebDAVConfig,
  gameId: string,
  confirmedOlder?: boolean
): Promise<{ success: boolean; message?: string } & Partial<ForceRestoreResult>> {
  try {
    const { adapter, remotePath } = createAdapter(rawConfig)
    const result = await forceRestoreGameFromRemote(adapter, remotePath, gameId, {
      confirmedOlder
    })
    return { success: true, ...result }
  } catch (error: any) {
    log.error(`[WebDAV] Force restore of game/${gameId} failed:`, error)
    return { success: false, message: error?.message || 'Force restore failed' }
  }
}

/**
 * Test WebDAV connection by attempting to list the root directory.
 */
export async function testWebDAVConnection(
  rawConfig: WebDAVConfig
): Promise<{ success: boolean; message: string }> {
  try {
    const config = withDecryptedPassword(rawConfig)
    if (!config.url || !config.auth.username || !config.auth.password) {
      return {
        success: false,
        message: 'cloudSync.errors.webdavIncompleteConfig'
      }
    }
    const adapter = new WebDAVAdapter(config)
    // Try to list the configured remote path (or root)
    const testPath = config.remotePath || '/'
    await adapter.list(testPath)
    return { success: true, message: 'cloudSync.webdav.testSuccess' }
  } catch (error: any) {
    log.error('[WebDAV] Connection test failed:', error)
    return {
      success: false,
      message: error.message || 'cloudSync.webdav.testFailed'
    }
  }
}

/**
 * Get remote snapshot metadata.
 */
export async function getRemoteSnapshotInfo(rawConfig: WebDAVConfig): Promise<{
  exists: boolean
  lastModified?: string
  size?: number
} | null> {
  try {
    const config = withDecryptedPassword(rawConfig)
    const adapter = new WebDAVAdapter(config)
    const remotePath = config.remotePath || '/vnite-sync/'
    const manifestPath = path.posix.join(remotePath, 'manifest.json')

    if (!(await adapter.exists(manifestPath))) {
      return { exists: false }
    }

    const manifestStat = await adapter.stat(manifestPath)
    const manifestContent = await adapter.readFile(manifestPath, 'text')
    const manifest = JSON.parse(manifestContent as string) as Manifest

    return {
      exists: true,
      lastModified: manifest.lastSync,
      size: manifestStat?.size ?? undefined
    }
  } catch (error) {
    log.error('[WebDAV] Failed to get remote snapshot info:', error)
    return null
  }
}

/**
 * Execute a WebDAV sync operation.
 *
 * - 'upload': Push local changes to remote (incremental, three-way merge)
 * - 'download': Pull remote changes to local (incremental, three-way merge)
 * - 'auto': Bidirectional sync — download first, then upload
 */
export async function syncViaWebDAV(
  rawConfig: WebDAVConfig,
  direction: 'upload' | 'download' | 'auto',
  options: WebDAVSyncOptions = {}
): Promise<SyncResult> {
  const config = withDecryptedPassword(rawConfig)
  if (!config.url || !config.auth.username) {
    throw new Error('Incomplete WebDAV config')
  }

  const adapter = new WebDAVAdapter(config)
  const remotePath = config.remotePath || '/vnite-sync/'
  const onProgress = options.silent ? undefined : createProgressReporter()
  const attemptAt = new Date().toISOString()

  let result: SyncResult

  try {
    if (direction === 'upload') {
      log.info('[WebDAV] Starting incremental upload...')
      result = await uploadSnapshot(adapter, remotePath, onProgress)
      log.info(
        `[WebDAV] Upload complete: ${result.uploaded} docs, ${result.attachmentsUploaded} attachments, ${result.conflicts.length} conflicts`
      )
    } else if (direction === 'download') {
      log.info('[WebDAV] Starting incremental download...')
      result = await downloadSnapshot(adapter, remotePath, onProgress)
      log.info(
        `[WebDAV] Download complete: ${result.downloaded} docs, ${result.attachmentsDownloaded} attachments, ${result.conflicts.length} conflicts`
      )
    } else {
      // auto: bidirectional sync
      log.info('[WebDAV] Starting bidirectional sync...')
      result = await syncBidirectional(adapter, remotePath, onProgress)
      log.info(
        `[WebDAV] Bidirectional sync complete: +${result.uploaded}/-${result.downloaded} docs, ${result.conflicts.length} conflicts`
      )
    }
  } catch (error) {
    // A concurrent sync holds the mutex — nothing actually ran, so leave
    // status and conflict list untouched.
    if (error instanceof Error && error.message === 'Sync already in progress') {
      throw error
    }
    await writeWebdavStatus(attemptAt, null, error)
    throw error
  }

  try {
    await recordSyncConflicts(result.conflicts)
  } catch (conflictError) {
    log.warn('[WebDAV] Failed to persist conflict list:', conflictError)
  }
  if (direction !== 'download') {
    try {
      await recordPendingSaveDeletions(result.pendingSaveDeletions)
    } catch (pendingError) {
      log.warn('[WebDAV] Failed to persist pending save deletions:', pendingError)
    }
  }
  await writeWebdavStatus(attemptAt, result)

  return result
}
