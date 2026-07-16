import { configLocalDocs } from '@appTypes/models'
import path from 'path'
import { ConfigDBManager, baseDBManager } from '~/core/database'
import { ipcManager } from '~/core/ipc'
import { WebDAVAdapter } from './sync-adapter/webdav-adapter'
import {
  uploadSnapshot,
  downloadSnapshot,
  syncBidirectional,
  ConflictInfo,
  Manifest,
  SyncProgress,
  SyncProgressCallback,
  SyncResult
} from './sync-engine'
import log from 'electron-log/main'

type WebDAVConfig = configLocalDocs['sync']['webdavConfig']

export interface WebDAVSyncOptions {
  /** Suppress renderer progress events (background/auto sync) */
  silent?: boolean
}

const CONFLICTS_DOC_ID = 'webdav-sync-conflicts'
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

/**
 * Test WebDAV connection by attempting to list the root directory.
 */
export async function testWebDAVConnection(
  config: WebDAVConfig
): Promise<{ success: boolean; message: string }> {
  try {
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
export async function getRemoteSnapshotInfo(config: WebDAVConfig): Promise<{
  exists: boolean
  lastModified?: string
  size?: number
} | null> {
  try {
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
  config: WebDAVConfig,
  direction: 'upload' | 'download' | 'auto',
  options: WebDAVSyncOptions = {}
): Promise<SyncResult> {
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
  await writeWebdavStatus(attemptAt, result)

  return result
}
