import { configLocalDocs } from '@appTypes/models'
import path from 'path'
import { WebDAVAdapter } from './sync-adapter/webdav-adapter'
import { uploadIncrementalSnapshot, downloadIncrementalSnapshot, Manifest } from './sync-engine'

type WebDAVConfig = configLocalDocs['sync']['webdavConfig']

/**
 * 测试 WebDAV 连接
 */
export async function testWebDAVConnection(config: WebDAVConfig): Promise<{ success: boolean; message: string }> {
  try {
    if (!config.url || !config.auth.username || !config.auth.password) {
      return { success: false, message: 'cloudSync.errors.webdavIncompleteConfig' }
    }
    const adapter = new WebDAVAdapter(config)
    await adapter.list('/')
    return { success: true, message: 'cloudSync.webdav.testSuccess' }
  } catch (error: any) {
    console.error('WebDAV connection error:', error)
    return { success: false, message: error.message || 'cloudSync.webdav.testFailed' }
  }
}

/**
 * 获取远程快照信息
 */
export async function getRemoteSnapshotInfo(config: WebDAVConfig): Promise<{ exists: boolean; lastModified?: string; size?: number } | null> {
  try {
    const adapter = new WebDAVAdapter(config)
    const remotePath = config.remotePath || '/vnite-sync/'
    const manifestPath = path.posix.join(remotePath, 'manifest.json')
    
    if (!(await adapter.exists(manifestPath))) {
      return { exists: false }
    }

    const manifestContent = await adapter.readFile(manifestPath, 'text')
    const manifest = JSON.parse(manifestContent as string) as Manifest

    return {
      exists: true,
      lastModified: manifest.lastSync,
      size: 0 // Size is no longer easily available, returning 0
    }
  } catch (error) {
    console.error('Failed to get remote snapshot info:', error)
    return null
  }
}

/**
 * 同步入口
 */
export async function syncViaWebDAV(config: WebDAVConfig, direction: 'upload' | 'download' | 'auto'): Promise<void> {
  if (!config.url || !config.auth.username) {
    throw new Error('Incomplete WebDAV config')
  }

  const adapter = new WebDAVAdapter(config)
  const remotePath = config.remotePath || '/vnite-sync/'

  if (direction === 'upload') {
    await uploadIncrementalSnapshot(adapter, remotePath)
  } else if (direction === 'download') {
    await downloadIncrementalSnapshot(adapter, remotePath)
  } else if (direction === 'auto') {
    // 简单实现：如果有远程数据就下载，否则上传
    const remoteInfo = await getRemoteSnapshotInfo(config)
    if (remoteInfo?.exists) {
      await downloadIncrementalSnapshot(adapter, remotePath)
    } else {
      await uploadIncrementalSnapshot(adapter, remotePath)
    }
  }
}
