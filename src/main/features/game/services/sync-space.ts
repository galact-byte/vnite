import log from 'electron-log/main'
import fse from 'fs-extra'
import path from 'path'
import os from 'os'
import { ConfigDBManager, GameDBManager } from '~/core/database'
import { walkFs } from '~/utils'
import fs from 'fs'
import type { SaveSyncSideMeta, SaveSyncProbeResult, SaveSyncResolution } from '@appTypes/sync'

/** Folder inside the sync space that holds all game save entries (new structure). */
const SYNC_SAVES_DIR = 'Vnitesaves'
/** Marker file written into each game directory to record which game owns it. */
const GAME_ID_MARKER_FILE = '.vnite-game-id'
/** 计算目录元数据时的文件数上限:超过后停扫,避免超大存档目录卡 UI。 */
const META_FILE_CAP = 5000
/** 计算目录元数据时的递归深度上限。 */
const META_MAX_DEPTH = 50
/**
 * 元数据遍历的软截止时间。walkFs / fs.stat 不支持取消已开始的 I/O，故这
 * 只能阻止后续条目继续扫描，不能虚假承诺硬性的 probe 总超时。
 */
const META_TRAVERSAL_DEADLINE_MS = 2_000
/** 命中云端条目却未携带用户决策时抛出的错误码。 */
export const SAVE_SYNC_NEEDS_RESOLUTION = 'SAVE_SYNC_NEEDS_RESOLUTION'

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

/**
 * 采集一个存档路径(目录或单文件)的客观元数据,供 R1 冲突弹窗"摆事实"。
 *
 * 目录基于现有 walkFs 递归累加大小/文件数/取最新 mtime;一旦文件数触到
 * META_FILE_CAP 或遍历软截止时间,后续条目直接跳过并标记 truncated,
 * 避免超大目录阻塞 UI。
 */
export async function collectPathMeta(targetPath: string): Promise<SaveSyncSideMeta> {
  const stat = await fse.stat(targetPath)
  if (!stat.isDirectory()) {
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, fileCount: 1 }
  }

  let sizeBytes = 0
  let fileCount = 0
  let mtimeMs = stat.mtimeMs
  let truncated = false
  const traversalDeadline = Date.now() + META_TRAVERSAL_DEADLINE_MS

  await walkFs(targetPath, {
    maxDepth: META_MAX_DEPTH,
    // 触顶或超时后让后续条目全部被过滤掉,迫使扫描尽快收束。
    filter: () => {
      if (truncated) return false
      if (Date.now() >= traversalDeadline) {
        truncated = true
        return false
      }
      return true
    },
    onFile: async (fullPath) => {
      const fileStat = await fse.stat(fullPath).catch(() => null)
      if (!fileStat) return
      sizeBytes += fileStat.size
      fileCount += 1
      if (fileStat.mtimeMs > mtimeMs) mtimeMs = fileStat.mtimeMs
      if (fileCount >= META_FILE_CAP) truncated = true
    }
  })

  if (Date.now() >= traversalDeadline) truncated = true
  return { sizeBytes, mtimeMs, fileCount, truncated }
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
 * Probe whether a save path can be converted to the sync space, without
 * mutating anything. Drives the renderer's two-step flow (probe → optional
 * conflict dialog → commit): when the cloud already holds an entry for this
 * game, both sides' objective metadata is returned so the user can pick.
 */
export async function probeSaveSyncConversion(
  gameId: string,
  savePath: string
): Promise<SaveSyncProbeResult> {
  if (await checkSaveInSyncSpace(gameId, savePath)) {
    return { status: 'already-in-sync' }
  }

  const syncSpacePath = await getSyncSpacePath()
  const basename = path.basename(savePath)
  const existing = await findExistingSyncTarget(syncSpacePath, gameId, basename)
  if (!existing) {
    return { status: 'fresh' }
  }

  const [local, cloud] = await Promise.all([
    collectPathMeta(savePath),
    collectPathMeta(existing.targetPath)
  ])
  return { status: 'conflict', local, cloud }
}

/**
 * use-cloud: 丢弃本地存档、链向云端条目。
 *
 * 先把本地存档移到系统临时目录暂存(而非 .backup),link 成功后再删;
 * link 失败则把本地存档从临时目录复原,保证失败可回滚且不产生任何 .backup。
 */
async function adoptCloudSave(
  savePath: string,
  existing: { targetPath: string; isDirectory: boolean }
): Promise<void> {
  const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'vnite-save-'))
  const stashPath = path.join(tmpDir, path.basename(savePath))

  log.info(`[SyncSpace] Adopting cloud save ${existing.targetPath}; stashing local at ${stashPath}`)
  await fse.move(savePath, stashPath, { overwrite: false })

  try {
    await createLink(existing.targetPath, savePath, existing.isDirectory)
  } catch (symlinkError: any) {
    // 回滚:把本地存档从临时目录移回原处;复原失败时保留暂存目录,绝不删掉唯一副本
    log.error('[SyncSpace] Link creation failed, restoring local save:', symlinkError)
    try {
      await fse.move(stashPath, savePath, { overwrite: true })
      await fse.remove(tmpDir).catch(() => {})
    } catch (restoreError) {
      log.error(`[SyncSpace] Rollback failed; local save preserved at ${stashPath}:`, restoreError)
    }
    throw symlinkPermissionError(symlinkError)
  }

  // link 成功,用户已选用云端,丢弃本地旧存档(保险由 vnite 既有存档历史兜底)
  await fse.remove(tmpDir).catch(() => {})
  log.info(`[SyncSpace] Adopted cloud save for link at ${savePath}`)
}

/**
 * use-local: 用本地存档覆盖云端条目,再建链。
 *
 * 先把云端条目移到临时目录暂存,任一步失败都能把云端+本地复原到操作前状态
 * (本地在、云端在、无半链接),避免半状态丢数据。
 */
async function adoptLocalSave(
  savePath: string,
  existing: { targetPath: string; isDirectory: boolean }
): Promise<void> {
  const localStat = await fse.stat(savePath)
  const isDirectory = localStat.isDirectory()
  const targetPath = existing.targetPath

  const tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'vnite-save-'))
  const cloudStash = path.join(tmpDir, path.basename(targetPath))

  log.info(`[SyncSpace] Adopting local save; stashing cloud ${targetPath} at ${cloudStash}`)
  await fse.move(targetPath, cloudStash, { overwrite: false })

  try {
    await fse.move(savePath, targetPath, { overwrite: false })
  } catch (moveError) {
    // 回滚:云端复原,本地保持不动;复原失败时保留暂存目录
    log.error('[SyncSpace] Move to sync space failed, restoring cloud:', moveError)
    try {
      await fse.move(cloudStash, targetPath, { overwrite: true })
      await fse.remove(tmpDir).catch(() => {})
    } catch (restoreError) {
      log.error(
        `[SyncSpace] Rollback failed; cloud entry preserved at ${cloudStash}:`,
        restoreError
      )
    }
    throw moveError
  }

  try {
    await createLink(targetPath, savePath, isDirectory)
  } catch (symlinkError: any) {
    // 回滚:先把本地移回原处,成功后才复原云端——若本地移回失败,
    // 本地内容仍在 targetPath,绝不能用云端暂存覆盖它
    log.error('[SyncSpace] Link creation failed, restoring local and cloud:', symlinkError)
    try {
      await fse.move(targetPath, savePath, { overwrite: true })
      await fse.move(cloudStash, targetPath, { overwrite: true })
      await fse.remove(tmpDir).catch(() => {})
    } catch (restoreError) {
      log.error(
        `[SyncSpace] Rollback incomplete; cloud entry preserved at ${cloudStash}:`,
        restoreError
      )
    }
    throw symlinkPermissionError(symlinkError)
  }

  // 成功:本地已覆盖云端并建链,丢弃暂存的旧云端内容
  await fse.remove(tmpDir).catch(() => {})
  log.info(`[SyncSpace] Adopted local save into ${targetPath}`)
}

/**
 * Convert a save path to cloud sync by moving it into the sync space
 * and creating a link at the original location.
 *
 * When the sync space already contains an entry for this game/basename
 * (e.g. synced from another device via a cloud client), the caller MUST first
 * call `probeSaveSyncConversion` and pass the user's `resolution`:
 * - `use-cloud`: discard the local save, link to the cloud target.
 * - `use-local`: overwrite the cloud target with the local save, then link.
 *
 * Neither branch produces any `.backup` artifact; both roll back to the
 * pre-operation state on failure. Hitting an existing entry without a
 * `resolution` throws `SAVE_SYNC_NEEDS_RESOLUTION` (defensive guard).
 */
export async function convertSaveToSyncSpace(
  gameId: string,
  savePath: string,
  resolution?: SaveSyncResolution
): Promise<void> {
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
      if (!resolution) {
        // 命中云端却没带用户决策 → 防御性报错,渲染端应先 probe 再 commit
        throw Object.assign(
          new Error(`Sync space already has an entry for ${gameId}; user resolution required.`),
          { code: SAVE_SYNC_NEEDS_RESOLUTION }
        )
      }
      if (resolution === 'use-cloud') {
        await adoptCloudSave(savePath, existing)
      } else if (resolution === 'use-local') {
        await adoptLocalSave(savePath, existing)
      } else {
        // IPC 入参来自渲染端，运行时不能依赖 TypeScript 联合类型；未知值
        // 绝不能降级为破坏性的“用本地覆盖云端”。
        throw new Error(`Invalid save sync resolution: ${String(resolution)}`)
      }
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
