import log from 'electron-log/main'
import fse from 'fs-extra'
import path from 'path'
import { ConfigDBManager } from '~/core/database'
import fs from 'fs'

async function getSyncSpacePath(): Promise<string> {
  const syncSpacePath = await ConfigDBManager.getConfigLocalValue('sync.syncSpacePath')
  if (!syncSpacePath) {
    throw new Error('Sync space path is not configured.')
  }
  return syncSpacePath
}

/**
 * Check if a save path is currently inside the sync space (via symlink).
 * Uses gameId only for matching — NOT the game name — to ensure
 * cross-device compatibility.
 */
export async function checkSaveInSyncSpace(
  _gameId: string,
  savePath: string
): Promise<boolean> {
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
    const normalizedTarget = path.normalize(target)
    const normalizedSyncSpace = path.normalize(syncSpacePath)
    const relative = path.relative(normalizedSyncSpace, normalizedTarget)

    // Must be a subdirectory/file inside sync space, not outside
    return Boolean(
      relative &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative)
    )
  } catch (error) {
    return false
  }
}

/**
 * Find an existing sync space folder for a game by its ID.
 * This enables cross-device matching: even if the game is named
 * differently on different devices, the same gameId ensures the
 * same folder is used.
 */
async function findExistingGameFolder(
  syncSpacePath: string,
  gameId: string,
  basename: string
): Promise<string | null> {
  try {
    const entries = await fse.readdir(syncSpacePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Match folders named: <gameId>_<basename>
      if (entry.name.startsWith(`${gameId}_`)) {
        const suffix = entry.name.slice(gameId.length + 1)
        // If basename matches too, it's an exact match
        if (suffix === basename) {
          return path.join(syncSpacePath, entry.name)
        }
        // If basename differs but gameId matches, this is likely
        // the same game named differently on another device
        log.info(
          `[SyncSpace] Found existing folder for game ${gameId} with different basename: ${suffix} vs ${basename}`
        )
        return path.join(syncSpacePath, entry.name)
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Convert a save path to cloud sync by moving it into the sync space
 * and creating a symbolic link at the original location.
 *
 * Uses `dir` type symlink on Windows (equivalent to `mklink /D`)
 * which supports cross-volume linking. On macOS/Linux, uses native symlinks.
 */
export async function convertSaveToSyncSpace(
  gameId: string,
  savePath: string
): Promise<void> {
  try {
    if (await checkSaveInSyncSpace(gameId, savePath)) {
      log.info(`[SyncSpace] ${savePath} is already in sync space.`)
      return
    }

    const syncSpacePath = await getSyncSpacePath()
    const stat = await fse.stat(savePath)
    const basename = path.basename(savePath)

    // First, check if a folder for this game already exists in sync space
    // (e.g., synced from another device via OneDrive/cloud client)
    let targetPath = await findExistingGameFolder(syncSpacePath, gameId, basename)

    if (!targetPath) {
      // Create new folder using gameId (not game name) for cross-device matching
      const targetFolderName = `${gameId}_${basename}`
      targetPath = path.join(syncSpacePath, targetFolderName)

      if (await fse.pathExists(targetPath)) {
        throw new Error(`Target path ${targetPath} already exists in sync space.`)
      }
    }

    const isDirectory = stat.isDirectory()

    log.info(`[SyncSpace] Moving ${savePath} to ${targetPath}`)
    await fse.move(savePath, targetPath, { overwrite: false })

    // Create symlink at original location pointing to sync space
    log.info(`[SyncSpace] Creating symlink at ${savePath} -> ${targetPath}`)
    try {
      if (process.platform === 'win32') {
        if (isDirectory) {
          // 'dir' = directory symlink (mklink /D), supports cross-volume
          await fs.promises.symlink(targetPath, savePath, 'dir')
        } else {
          // 'file' = file symlink
          await fs.promises.symlink(targetPath, savePath, 'file')
        }
      } else {
        // macOS / Linux: standard symlink works for both files and dirs
        await fs.promises.symlink(targetPath, savePath)
      }
    } catch (symlinkError: any) {
      // If symlink creation fails (e.g., no admin/developer mode on Windows),
      // move the files back and throw a descriptive error
      log.error('[SyncSpace] Symlink creation failed, rolling back move:', symlinkError)
      await fse.move(targetPath, savePath, { overwrite: true }).catch(() => {})

      if (
        process.platform === 'win32' &&
        (symlinkError.code === 'EPERM' || symlinkError.code === 'EACCES')
      ) {
        throw new Error(
          'Insufficient permissions to create symbolic link. ' +
            'On Windows, please enable Developer Mode (Settings → Privacy & Security → For Developers) ' +
            'or run the application as Administrator.'
        )
      }
      throw symlinkError
    }
  } catch (error) {
    log.error(`[SyncSpace] Error converting ${savePath} to sync space:`, error)
    throw error
  }
}

/**
 * Restore a save path from sync space back to local.
 * Removes the symlink and moves the actual files back.
 */
export async function restoreSaveFromSyncSpace(
  gameId: string,
  savePath: string
): Promise<void> {
  try {
    if (!(await checkSaveInSyncSpace(gameId, savePath))) {
      log.info(`[SyncSpace] ${savePath} is not in sync space.`)
      return
    }

    const targetPath = await fse.realpath(savePath)

    log.info(`[SyncSpace] Removing symlink at ${savePath}`)
    await fse.remove(savePath)

    log.info(`[SyncSpace] Moving ${targetPath} back to ${savePath}`)
    await fse.move(targetPath, savePath, { overwrite: false })
  } catch (error) {
    log.error(
      `[SyncSpace] Error restoring ${savePath} from sync space:`,
      error
    )
    throw error
  }
}
