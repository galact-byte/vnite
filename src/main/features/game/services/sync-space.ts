import log from 'electron-log/main'
import fse from 'fs-extra'
import path from 'path'
import { ConfigDBManager, GameDBManager } from '~/core/database'
import fs from 'fs'

/** Folder inside the sync space that holds all game save entries (new structure). */
const SYNC_SAVES_DIR = 'Vnitesaves'
/** Marker file written into each game directory to record which game owns it. */
const GAME_ID_MARKER_FILE = '.vnite-game-id'

async function getSyncSpacePath(): Promise<string> {
  const syncSpacePath = await ConfigDBManager.getConfigLocalValue('sync.syncSpacePath')
  if (!syncSpacePath) {
    throw new Error('Sync space path is not configured.')
  }
  return syncSpacePath
}

/**
 * Create a link at `linkPath` pointing to `target`.
 *
 * On Windows, directories use a junction (no Developer Mode / admin rights
 * required; targets must be absolute paths, which they are here), while
 * single files use a `file` symlink (which may still require privileges).
 * On macOS/Linux, a standard symlink is used for both.
 */
async function createLink(target: string, linkPath: string, isDirectory: boolean): Promise<void> {
  if (process.platform === 'win32') {
    if (isDirectory) {
      await fs.promises.symlink(target, linkPath, 'junction')
    } else {
      await fs.promises.symlink(target, linkPath, 'file')
    }
  } else {
    await fs.promises.symlink(target, linkPath)
  }
}

function backupTimestamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Check if a save path is currently inside the sync space (via symlink).
 * Uses gameId only for matching — NOT the game name — to ensure
 * cross-device compatibility.
 */
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
    const normalizedTarget = path.normalize(target)
    const normalizedSyncSpace = path.normalize(syncSpacePath)
    const relative = path.relative(normalizedSyncSpace, normalizedTarget)

    // Must be a subdirectory/file inside sync space, not outside
    return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  } catch {
    return false
  }
}

/**
 * Strip characters that are invalid in Windows directory names, plus
 * trailing dots/spaces (which Windows silently rejects). Legal Unicode
 * (e.g. Japanese) is preserved. Returns '' when nothing usable remains.
 */
function sanitizeGameDirName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/[. ]+$/, '')
      .trim()
  )
}

async function readGameIdMarker(gameDirPath: string): Promise<string | null> {
  try {
    const content = await fse.readFile(path.join(gameDirPath, GAME_ID_MARKER_FILE), 'utf8')
    return content.trim() || null
  } catch {
    return null
  }
}

/**
 * Decide which directory under `Vnitesaves/` this game's saves belong to.
 * Prefers the sanitized game name for readability; falls back to the gameId
 * when the name is empty after sanitization, or when the name directory is
 * already owned by a different game (ownership tracked via the
 * `.vnite-game-id` marker file inside the directory).
 */
async function resolveGameSyncDir(syncSpacePath: string, gameId: string): Promise<string> {
  const savesRoot = path.join(syncSpacePath, SYNC_SAVES_DIR)

  let gameName = ''
  try {
    gameName = (await GameDBManager.getGameValue(gameId, 'metadata.name')) ?? ''
  } catch (error) {
    log.warn(`[SyncSpace] Failed to read game name for ${gameId}, falling back to id:`, error)
  }

  const sanitized = sanitizeGameDirName(gameName)
  if (sanitized) {
    const nameDirPath = path.join(savesRoot, sanitized)
    if (!(await fse.pathExists(nameDirPath))) {
      return nameDirPath
    }
    const owner = await readGameIdMarker(nameDirPath)
    if (owner === gameId) {
      return nameDirPath
    }
    log.warn(
      `[SyncSpace] Directory ${nameDirPath} is owned by ${owner ?? 'unknown'}, ` +
        `falling back to gameId directory for ${gameId}`
    )
  }

  return path.join(savesRoot, gameId)
}

/** Create the game directory (if needed) and stamp it with the owner gameId. */
async function ensureGameSyncDir(gameDirPath: string, gameId: string): Promise<void> {
  await fse.ensureDir(gameDirPath)
  const markerPath = path.join(gameDirPath, GAME_ID_MARKER_FILE)
  if (!(await fse.pathExists(markerPath))) {
    await fse.writeFile(markerPath, gameId, 'utf8')
  }
}

/**
 * Find an existing sync space entry (folder or single-file save) for a game.
 *
 * Checks the new structure first (`Vnitesaves/<gameDir>/<basename>`, where the
 * game directory is matched by gameId — either via its `.vnite-game-id` marker
 * or by being literally named after the gameId), then falls back to the legacy
 * flat structure (`<syncSpacePath>/<gameId>_<basename>`). Matching is always
 * keyed on gameId + basename, never on the display name alone, so entries stay
 * resolvable across devices and after renames.
 */
async function findExistingSyncTarget(
  syncSpacePath: string,
  gameId: string,
  basename: string
): Promise<{ targetPath: string; isDirectory: boolean } | null> {
  // New structure: Vnitesaves/<gameDir>/<basename>
  try {
    const savesRoot = path.join(syncSpacePath, SYNC_SAVES_DIR)
    const gameDirs = await fse.readdir(savesRoot, { withFileTypes: true })
    for (const gameDir of gameDirs) {
      if (!gameDir.isDirectory()) continue
      const gameDirPath = path.join(savesRoot, gameDir.name)
      const owner = gameDir.name === gameId ? gameId : await readGameIdMarker(gameDirPath)
      if (owner !== gameId) continue
      const candidatePath = path.join(gameDirPath, basename)
      const stat = await fse.stat(candidatePath).catch(() => null)
      if (stat) {
        return { targetPath: candidatePath, isDirectory: stat.isDirectory() }
      }
    }
  } catch {
    // Vnitesaves/ missing or unreadable — fall through to the legacy lookup
  }

  // Legacy structure: <syncSpacePath>/<gameId>_<basename>
  const legacyPath = path.join(syncSpacePath, `${gameId}_${basename}`)
  const legacyStat = await fse.stat(legacyPath).catch(() => null)
  if (legacyStat) {
    return { targetPath: legacyPath, isDirectory: legacyStat.isDirectory() }
  }

  return null
}

function symlinkPermissionError(symlinkError: any): Error {
  if (
    process.platform === 'win32' &&
    (symlinkError.code === 'EPERM' || symlinkError.code === 'EACCES')
  ) {
    return new Error(
      'Insufficient permissions to create symbolic link. ' +
        'On Windows, please enable Developer Mode (Settings → Privacy & Security → For Developers) ' +
        'or run the application as Administrator.'
    )
  }
  return symlinkError
}

/**
 * Convert a save path to cloud sync by moving it into the sync space
 * and creating a link at the original location.
 *
 * If the sync space already contains an entry for this game/basename
 * (e.g. synced from another device via a cloud client), the cloud version
 * is adopted: the local save is renamed to a `.backup-<timestamp>` copy and
 * the link points at the existing sync space entry.
 */
export async function convertSaveToSyncSpace(gameId: string, savePath: string): Promise<void> {
  try {
    if (await checkSaveInSyncSpace(gameId, savePath)) {
      log.info(`[SyncSpace] ${savePath} is already in sync space.`)
      return
    }

    const syncSpacePath = await getSyncSpacePath()
    const stat = await fse.stat(savePath)
    const basename = path.basename(savePath)
    const isDirectory = stat.isDirectory()

    const existing = await findExistingSyncTarget(syncSpacePath, gameId, basename)

    if (existing) {
      // Cross-device reuse: adopt the cloud version. Keep the local save as a
      // backup next to the original location, then link to the cloud target.
      // The link type follows the cloud target's type, not the local save's.
      const backupPath = `${savePath}.backup-${backupTimestamp()}`
      log.info(
        `[SyncSpace] Sync space already has ${existing.targetPath}; adopting cloud version. ` +
          `Backing up local save to ${backupPath}`
      )
      await fse.move(savePath, backupPath, { overwrite: false })

      try {
        await createLink(existing.targetPath, savePath, existing.isDirectory)
      } catch (symlinkError: any) {
        // Roll back: restore the local save from the backup
        log.error('[SyncSpace] Link creation failed, restoring local save:', symlinkError)
        await fse.move(backupPath, savePath, { overwrite: true }).catch(() => {})
        throw symlinkPermissionError(symlinkError)
      }

      log.info(
        `[SyncSpace] Adopted cloud save for ${gameId}; local version backed up at ${backupPath}`
      )
      return
    }

    // No existing entry — move the local save into the sync space
    const gameDirPath = await resolveGameSyncDir(syncSpacePath, gameId)
    const targetPath = path.join(gameDirPath, basename)

    if (await fse.pathExists(targetPath)) {
      throw new Error(`Target path ${targetPath} already exists in sync space.`)
    }

    await ensureGameSyncDir(gameDirPath, gameId)

    log.info(`[SyncSpace] Moving ${savePath} to ${targetPath}`)
    await fse.move(savePath, targetPath, { overwrite: false })

    log.info(`[SyncSpace] Creating link at ${savePath} -> ${targetPath}`)
    try {
      await createLink(targetPath, savePath, isDirectory)
    } catch (symlinkError: any) {
      // Roll back: move the files back to the original location
      log.error('[SyncSpace] Link creation failed, rolling back move:', symlinkError)
      await fse.move(targetPath, savePath, { overwrite: true }).catch(() => {})
      throw symlinkPermissionError(symlinkError)
    }
  } catch (error) {
    log.error(`[SyncSpace] Error converting ${savePath} to sync space:`, error)
    throw error
  }
}

/**
 * Restore a save path from sync space back to local.
 * Removes the link and moves the actual files back. If the move fails, the
 * link is re-created so the save stays reachable at its original location.
 */
export async function restoreSaveFromSyncSpace(gameId: string, savePath: string): Promise<void> {
  try {
    if (!(await checkSaveInSyncSpace(gameId, savePath))) {
      log.info(`[SyncSpace] ${savePath} is not in sync space.`)
      return
    }

    const targetPath = await fse.realpath(savePath)
    const targetStat = await fse.stat(targetPath)
    const isDirectory = targetStat.isDirectory()

    log.info(`[SyncSpace] Removing link at ${savePath}`)
    await fse.remove(savePath)

    log.info(`[SyncSpace] Moving ${targetPath} back to ${savePath}`)
    try {
      await fse.move(targetPath, savePath, { overwrite: false })
    } catch (moveError) {
      // Roll back: re-create the link so the save stays reachable
      log.error('[SyncSpace] Move failed, re-creating link:', moveError)
      await createLink(targetPath, savePath, isDirectory).catch((linkError) => {
        log.error('[SyncSpace] Failed to re-create link during rollback:', linkError)
      })
      throw moveError
    }
  } catch (error) {
    log.error(`[SyncSpace] Error restoring ${savePath} from sync space:`, error)
    throw error
  }
}
