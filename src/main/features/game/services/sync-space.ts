import log from 'electron-log/main'
import fse from 'fs-extra'
import path from 'path'
import { ConfigDBManager, GameDBManager } from '~/core/database'
import { sanitizeFilename } from '~/utils'
import fs from 'fs'

async function getSyncSpacePath(): Promise<string> {
  const syncSpacePath = await ConfigDBManager.getConfigLocalValue('sync.syncSpacePath')
  if (!syncSpacePath) {
    throw new Error('Sync space path is not configured.')
  }
  return syncSpacePath
}

export async function checkSaveInSyncSpace(_gameId: string, savePath: string): Promise<boolean> {
  try {
    const syncSpacePath = await getSyncSpacePath()
    const stat = await fse.lstat(savePath).catch(() => null)
    
    if (!stat || !stat.isSymbolicLink()) {
      return false
    }

    const target = await fse.realpath(savePath).catch(() => null)
    if (!target) {
      return false
    }

    // Check if the target path is inside the sync space
    const relative = path.relative(syncSpacePath, target)
    return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  } catch (error) {
    return false
  }
}

export async function convertSaveToSyncSpace(gameId: string, savePath: string): Promise<void> {
  try {
    if (await checkSaveInSyncSpace(gameId, savePath)) {
      log.info(`[SyncSpace] ${savePath} is already in sync space.`)
      return
    }

    const syncSpacePath = await getSyncSpacePath()
    const gameName = await GameDBManager.getGameValue(gameId, 'metadata.name')
    const safeGameName = sanitizeFilename(gameName)
    
    // Check if original savePath is a file or a folder
    const stat = await fse.stat(savePath)
    if (!stat.isDirectory()) {
      throw new Error('Only directory save paths can be converted to sync space.')
    }

    const basename = path.basename(savePath)
    const targetFolderName = `${safeGameName}_${gameId}_${basename}`
    const targetPath = path.join(syncSpacePath, targetFolderName)

    // Ensure target path does not already exist
    if (await fse.pathExists(targetPath)) {
      throw new Error(`Target path ${targetPath} already exists in sync space.`)
    }

    log.info(`[SyncSpace] Moving ${savePath} to ${targetPath}`)
    await fse.move(savePath, targetPath)

    log.info(`[SyncSpace] Creating junction at ${savePath} -> ${targetPath}`)
    await fs.promises.symlink(targetPath, savePath, 'junction')

  } catch (error) {
    log.error(`[SyncSpace] Error converting ${savePath} to sync space:`, error)
    throw error
  }
}

export async function restoreSaveFromSyncSpace(gameId: string, savePath: string): Promise<void> {
  try {
    if (!(await checkSaveInSyncSpace(gameId, savePath))) {
      log.info(`[SyncSpace] ${savePath} is not in sync space.`)
      return
    }

    const targetPath = await fse.realpath(savePath)
    
    log.info(`[SyncSpace] Removing junction at ${savePath}`)
    await fse.remove(savePath)

    log.info(`[SyncSpace] Moving ${targetPath} back to ${savePath}`)
    await fse.move(targetPath, savePath)

  } catch (error) {
    log.error(`[SyncSpace] Error restoring ${savePath} from sync space:`, error)
    throw error
  }
}
