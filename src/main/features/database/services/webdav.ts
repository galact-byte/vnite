import { configLocalDocs } from '@appTypes/models'
import path from 'path'
import { WebDAVAdapter } from './sync-adapter/webdav-adapter'
import {
  uploadSnapshot,
  downloadSnapshot,
  syncBidirectional,
  Manifest,
  SyncResult
} from './sync-engine'
import log from 'electron-log/main'

type WebDAVConfig = configLocalDocs['sync']['webdavConfig']

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
export async function getRemoteSnapshotInfo(
  config: WebDAVConfig
): Promise<{
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
  direction: 'upload' | 'download' | 'auto'
): Promise<SyncResult> {
  if (!config.url || !config.auth.username) {
    throw new Error('Incomplete WebDAV config')
  }

  const adapter = new WebDAVAdapter(config)
  const remotePath = config.remotePath || '/vnite-sync/'

  let result: SyncResult

  if (direction === 'upload') {
    log.info('[WebDAV] Starting incremental upload...')
    result = await uploadSnapshot(adapter, remotePath)
    log.info(
      `[WebDAV] Upload complete: ${result.uploaded} docs, ${result.attachmentsUploaded} attachments, ${result.conflicts.length} conflicts`
    )
  } else if (direction === 'download') {
    log.info('[WebDAV] Starting incremental download...')
    result = await downloadSnapshot(adapter, remotePath)
    log.info(
      `[WebDAV] Download complete: ${result.downloaded} docs, ${result.attachmentsDownloaded} attachments, ${result.conflicts.length} conflicts`
    )
  } else {
    // auto: bidirectional sync
    log.info('[WebDAV] Starting bidirectional sync...')
    result = await syncBidirectional(adapter, remotePath)
    log.info(
      `[WebDAV] Bidirectional sync complete: +${result.uploaded}/-${result.downloaded} docs, ${result.conflicts.length} conflicts`
    )
  }

  return result
}
