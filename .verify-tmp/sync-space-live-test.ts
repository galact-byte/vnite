/**
 * Live verification harness for the sync-space (存档同步空间) feature.
 *
 * Exercises the real sync-space.ts against a temp directory acting as the
 * cloud-synced folder:
 *
 *  1. Directory save → convert: moved into `Vnitesaves/<游戏名>/<basename>`,
 *     link left behind, `.vnite-game-id` marker written
 *  2. Writes through the link land in the sync space
 *  3. Convert is idempotent
 *  4. Restore: link replaced with an independent local copy; cloud original remains
 *  5. R1 probe (fresh/conflict/already-in-sync) + informed two-choice:
 *     use-cloud / use-local, defensive guard, and no .backup residue
 *  6. Single-file save convert/restore (Windows: may need Developer Mode → clear error)
 *  7. Japanese game name kept as-is
 *  8. Illegal characters stripped from the directory name
 *  9. Name empty after sanitization → fallback to gameId directory
 * 10. Name conflict with another game's directory → fallback to gameId directory
 * 11. Legacy flat entry (`<gameId>_<basename>`) still recognized: adopt + restore
 * 12. backupGameSave on a converted (linked) save path: zip contains real content
 *     (fse.copy dereference — regression test for the empty-backup bug)
 * 13. backupGameSave throws when every save path fails to copy (no empty backup stored)
 *
 * Run: npx tsx --tsconfig .verify-tmp/tsconfig.json .verify-tmp/sync-space-live-test.ts
 */
import path from 'path'
import fs from 'fs'
import fse from 'fs-extra'
import os from 'os'
import AdmZip from 'adm-zip'
import { setDeviceDir, ConfigDBManager, GameDBManager, storedSaves } from './shim-core-database'
import {
  checkSaveInSyncSpace,
  convertSaveToSyncSpace,
  probeSaveSyncConversion,
  collectPathMeta,
  restoreSaveFromSyncSpace,
  SAVE_SYNC_NEEDS_RESOLUTION
} from '../src/main/features/game/services/sync-space'

/** 扫描目录无 .backup* 残留(R1 不得产生任何备份)。 */
function hasBackupResidue(dir: string): boolean {
  return fs.readdirSync(dir).some((n) => n.includes('.backup'))
}
import { backupGameSave } from '../src/main/features/game/services/save'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`, extra !== undefined ? String(extra) : '')
  }
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vnite-syncspace-test-'))
  const deviceDir = path.join(tmpRoot, 'device')
  const syncSpace = path.join(tmpRoot, 'syncspace') // stands in for the cloud-synced folder
  const savesRoot = path.join(tmpRoot, 'saves')
  const vniteSaves = path.join(syncSpace, 'Vnitesaves')
  fs.mkdirSync(deviceDir)
  fs.mkdirSync(syncSpace)
  fs.mkdirSync(savesRoot)

  setDeviceDir(deviceDir)
  await ConfigDBManager.setConfigLocalValue('sync.syncSpacePath', syncSpace)
  await GameDBManager.setGameValue('game-abc', 'metadata.name', 'My Game')

  // ── [0] R1 metadata deadline ──
  console.log('[0] R1 metadata scan deadline')
  const deadlineSave = path.join(savesRoot, 'DeadlineSave')
  fs.mkdirSync(deadlineSave)
  fs.writeFileSync(path.join(deadlineSave, 'late.sav'), 'deadline-content')
  const originalDateNow = Date.now
  let dateNowCalls = 0
  Date.now = () => (dateNowCalls++ === 0 ? 0 : 2_001)
  try {
    const deadlineMeta = await collectPathMeta(deadlineSave)
    check(
      'metadata scan truncates when its deadline expires before the first file',
      deadlineMeta.truncated === true && deadlineMeta.fileCount === 0,
      deadlineMeta
    )
  } finally {
    Date.now = originalDateNow
  }

  // ── [1] Directory save convert (new structure) ──
  console.log('[1] directory save → Vnitesaves/<游戏名>/<basename>')
  const dirSave = path.join(savesRoot, 'SaveData')
  fs.mkdirSync(dirSave)
  fs.writeFileSync(path.join(dirSave, 'slot1.sav'), 'slot1-content')

  await convertSaveToSyncSpace('game-abc', dirSave)
  const gameDir = path.join(vniteSaves, 'My Game')
  const target = path.join(gameDir, 'SaveData')
  check('files moved into Vnitesaves/My Game/', fs.existsSync(path.join(target, 'slot1.sav')))
  check(
    'game-id marker written',
    fs.existsSync(path.join(gameDir, '.vnite-game-id')) &&
      fs.readFileSync(path.join(gameDir, '.vnite-game-id'), 'utf8').trim() === 'game-abc'
  )
  check('original path is now a link', fs.lstatSync(dirSave).isSymbolicLink())
  check('checkSaveInSyncSpace → true', await checkSaveInSyncSpace('game-abc', dirSave))
  check(
    'content readable through link',
    fs.readFileSync(path.join(dirSave, 'slot1.sav'), 'utf8') === 'slot1-content'
  )

  // ── [2] Game writes through the link ──
  console.log('[2] writes through the link')
  fs.writeFileSync(path.join(dirSave, 'slot2.sav'), 'slot2-content')
  check(
    'new file appears inside sync space',
    fs.readFileSync(path.join(target, 'slot2.sav'), 'utf8') === 'slot2-content'
  )

  // ── [3] Convert is idempotent ──
  console.log('[3] idempotency')
  await convertSaveToSyncSpace('game-abc', dirSave) // should be a no-op
  check('second convert is a no-op', fs.lstatSync(dirSave).isSymbolicLink())

  // ── [4] Copy to local and stop linking ──
  console.log('[4] copy to local and stop linking')
  await restoreSaveFromSyncSpace('game-abc', dirSave)
  check(
    'link replaced by real directory',
    fs.lstatSync(dirSave).isDirectory() && !fs.lstatSync(dirSave).isSymbolicLink()
  )
  check(
    'local copy retains original content',
    fs.readFileSync(path.join(dirSave, 'slot2.sav'), 'utf8') === 'slot2-content'
  )
  check('sync space original remains intact', fs.existsSync(path.join(target, 'slot2.sav')))
  fs.writeFileSync(path.join(dirSave, 'local-only.sav'), 'local-only')
  fs.writeFileSync(path.join(target, 'cloud-only.sav'), 'cloud-only')
  check(
    'later local writes do not appear in sync space',
    !fs.existsSync(path.join(target, 'local-only.sav'))
  )
  check(
    'later sync-space writes do not appear in local copy',
    !fs.existsSync(path.join(dirSave, 'cloud-only.sav'))
  )
  check('checkSaveInSyncSpace → false', !(await checkSaveInSyncSpace('game-abc', dirSave)))
  await restoreSaveFromSyncSpace('game-abc', dirSave) // no-op on plain dir
  check('restore of non-synced path is a no-op', fs.existsSync(path.join(dirSave, 'slot1.sav')))

  // [5] must start with a deliberately recreated cloud fixture, because [4]
  // now correctly retains it instead of relying on the old move side effect.
  fs.rmSync(target, { recursive: true, force: true })

  // ── [5] R1: probe states + informed two-choice (no .backup produced) ──
  console.log('[5] R1 probe states + use-cloud / use-local (no backup)')

  // fresh: cloud has no entry for this game yet (dirSave restored to local in [4])
  const freshProbe = await probeSaveSyncConversion('game-abc', dirSave)
  check('probe → fresh when cloud empty', freshProbe.status === 'fresh', freshProbe.status)

  // Recreate a cloud entry to force a conflict
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'slot1.sav'), 'CLOUD-content')

  const conflictProbe = await probeSaveSyncConversion('game-abc', dirSave)
  check('probe → conflict when cloud has entry', conflictProbe.status === 'conflict')
  if (conflictProbe.status === 'conflict') {
    check(
      'probe returns local metadata (fileCount ≥ 1, size > 0)',
      conflictProbe.local.fileCount >= 1 && conflictProbe.local.sizeBytes > 0,
      JSON.stringify(conflictProbe.local)
    )
    check(
      'probe returns cloud metadata (fileCount = 1)',
      conflictProbe.cloud.fileCount === 1,
      JSON.stringify(conflictProbe.cloud)
    )
  }

  // Hitting an existing entry without a resolution must throw (defensive guard)
  let guardThrew = false
  try {
    await convertSaveToSyncSpace('game-abc', dirSave)
  } catch (e: any) {
    guardThrew = e?.code === SAVE_SYNC_NEEDS_RESOLUTION
  }
  check('convert without resolution throws SAVE_SYNC_NEEDS_RESOLUTION', guardThrew)
  check('guard left local intact (still a real dir)', fs.lstatSync(dirSave).isDirectory())
  check('guard left cloud intact', fs.existsSync(path.join(target, 'slot1.sav')))
  check('guard produced no .backup residue', !hasBackupResidue(savesRoot))

  // IPC values are runtime input: an unexpected resolution must never fall
  // through to the destructive use-local branch.
  let invalidResolutionThrew = false
  try {
    await convertSaveToSyncSpace('game-abc', dirSave, 'unexpected-choice' as any)
  } catch {
    invalidResolutionThrew = true
  }
  check('invalid resolution is rejected without changing either side', invalidResolutionThrew)
  check(
    'invalid resolution leaves local + cloud intact',
    fs.existsSync(dirSave) && fs.existsSync(target)
  )

  // use-cloud: adopt cloud, discard local, NO .backup
  await convertSaveToSyncSpace('game-abc', dirSave, 'use-cloud')
  check('use-cloud: link points at cloud entry', await checkSaveInSyncSpace('game-abc', dirSave))
  check(
    'use-cloud: cloud content adopted',
    fs.readFileSync(path.join(dirSave, 'slot1.sav'), 'utf8') === 'CLOUD-content'
  )
  check('use-cloud: no .backup residue', !hasBackupResidue(savesRoot))

  // already-in-sync: probing a linked path short-circuits
  const linkedProbe = await probeSaveSyncConversion('game-abc', dirSave)
  check('probe → already-in-sync on linked path', linkedProbe.status === 'already-in-sync')

  await restoreSaveFromSyncSpace('game-abc', dirSave) // clean up for later sections

  // ── [5a] Restore failures keep the cloud original and recover the link ──
  console.log('[5a] restore copy/commit failures preserve recoverability')
  const copyFailSave = path.join(savesRoot, 'CopyFailSave')
  fs.mkdirSync(copyFailSave)
  fs.writeFileSync(path.join(copyFailSave, 'data.sav'), 'copy-fail-content')
  await convertSaveToSyncSpace('game-abc', copyFailSave)
  const copyFailTarget = path.join(gameDir, 'CopyFailSave')
  const originalCopy = fse.copy
  let copyFailureThrown = false
  ;(fse as typeof fse & { copy: typeof fse.copy }).copy = async () => {
    throw new Error('injected staging copy failure')
  }
  try {
    await restoreSaveFromSyncSpace('game-abc', copyFailSave)
  } catch {
    copyFailureThrown = true
  } finally {
    ;(fse as typeof fse & { copy: typeof fse.copy }).copy = originalCopy
  }
  check('staging copy failure is reported', copyFailureThrown)
  check(
    'staging copy failure leaves the original link reachable',
    fs.lstatSync(copyFailSave).isSymbolicLink() &&
      fs.readFileSync(path.join(copyFailSave, 'data.sav'), 'utf8') === 'copy-fail-content'
  )
  check('staging copy failure leaves cloud original intact', fs.existsSync(copyFailTarget))

  const unlinkFailSave = path.join(savesRoot, 'UnlinkFailSave')
  fs.mkdirSync(unlinkFailSave)
  fs.writeFileSync(path.join(unlinkFailSave, 'data.sav'), 'unlink-fail-content')
  await convertSaveToSyncSpace('game-abc', unlinkFailSave)
  const unlinkFailTarget = path.join(gameDir, 'UnlinkFailSave')
  const originalRemove = fse.remove
  let unlinkFailureThrown = false
  ;(fse as typeof fse & { remove: typeof fse.remove }).remove = async (
    ...args: Parameters<typeof fse.remove>
  ) => {
    if (path.resolve(String(args[0])) === path.resolve(unlinkFailSave)) {
      throw new Error('injected link removal failure')
    }
    return originalRemove(...args)
  }
  try {
    await restoreSaveFromSyncSpace('game-abc', unlinkFailSave)
  } catch {
    unlinkFailureThrown = true
  } finally {
    ;(fse as typeof fse & { remove: typeof fse.remove }).remove = originalRemove
  }
  check('link removal failure is reported', unlinkFailureThrown)
  check(
    'link removal failure leaves the original link reachable',
    fs.lstatSync(unlinkFailSave).isSymbolicLink() &&
      fs.readFileSync(path.join(unlinkFailSave, 'data.sav'), 'utf8') === 'unlink-fail-content'
  )
  check('link removal failure leaves cloud original intact', fs.existsSync(unlinkFailTarget))
  check(
    'link removal failure cleans up the local staging copy',
    !fs.readdirSync(savesRoot).some((name) => name.startsWith('.vnite-restore-UnlinkFailSave-'))
  )

  const commitFailSave = path.join(savesRoot, 'CommitFailSave')
  fs.mkdirSync(commitFailSave)
  fs.writeFileSync(path.join(commitFailSave, 'data.sav'), 'commit-fail-content')
  await convertSaveToSyncSpace('game-abc', commitFailSave)
  const commitFailTarget = path.join(gameDir, 'CommitFailSave')
  const originalMove = fse.move
  let commitFailureThrown = false
  ;(fse as typeof fse & { move: typeof fse.move }).move = async (source, destination, options) => {
    if (path.basename(source).startsWith('.vnite-restore-')) {
      throw new Error('injected staging commit failure')
    }
    return originalMove(source, destination, options)
  }
  try {
    await restoreSaveFromSyncSpace('game-abc', commitFailSave)
  } catch {
    commitFailureThrown = true
  } finally {
    ;(fse as typeof fse & { move: typeof fse.move }).move = originalMove
  }
  check('staging commit failure is reported', commitFailureThrown)
  check(
    'staging commit failure restores the original link',
    fs.lstatSync(commitFailSave).isSymbolicLink() &&
      fs.readFileSync(path.join(commitFailSave, 'data.sav'), 'utf8') === 'commit-fail-content'
  )
  check('staging commit failure leaves cloud original intact', fs.existsSync(commitFailTarget))

  // ── [5b] R1 use-local: local overwrites cloud, then link ──
  console.log('[5b] R1 use-local branch (local overwrites cloud)')
  await GameDBManager.setGameValue('game-ul', 'metadata.name', 'UL Game')
  const ulSave = path.join(savesRoot, 'UlSave')
  fs.mkdirSync(ulSave)
  fs.writeFileSync(path.join(ulSave, 'data.sav'), 'LOCAL-fresh')
  const ulTarget = path.join(vniteSaves, 'UL Game', 'UlSave')
  fs.mkdirSync(ulTarget, { recursive: true })
  // A real cloud entry carries the ownership marker (written by ensureGameSyncDir
  // on the originating device and synced along with the save files).
  fs.writeFileSync(path.join(vniteSaves, 'UL Game', '.vnite-game-id'), 'game-ul')
  fs.writeFileSync(path.join(ulTarget, 'data.sav'), 'CLOUD-stale')

  await convertSaveToSyncSpace('game-ul', ulSave, 'use-local')
  check('use-local: link created', await checkSaveInSyncSpace('game-ul', ulSave))
  check(
    'use-local: cloud overwritten by local content',
    fs.readFileSync(path.join(ulTarget, 'data.sav'), 'utf8') === 'LOCAL-fresh'
  )
  check(
    'use-local: content readable through link',
    fs.readFileSync(path.join(ulSave, 'data.sav'), 'utf8') === 'LOCAL-fresh'
  )
  check('use-local: no .backup residue', !hasBackupResidue(savesRoot))

  // ── [6] Single-file save ──
  console.log('[6] single-file save (Windows may require Developer Mode)')
  await GameDBManager.setGameValue('game-xyz', 'metadata.name', 'File Game')
  const fileSave = path.join(savesRoot, 'progress.dat')
  fs.writeFileSync(fileSave, 'file-save-content')
  try {
    await convertSaveToSyncSpace('game-xyz', fileSave)
    check(
      'file moved into Vnitesaves/File Game/',
      fs.existsSync(path.join(vniteSaves, 'File Game', 'progress.dat'))
    )
    check('file link readable', fs.readFileSync(fileSave, 'utf8') === 'file-save-content')
    check('checkSaveInSyncSpace(file) → true', await checkSaveInSyncSpace('game-xyz', fileSave))
    await restoreSaveFromSyncSpace('game-xyz', fileSave)
    const fileTarget = path.join(vniteSaves, 'File Game', 'progress.dat')
    check(
      'file copied to local as a real file',
      !fs.lstatSync(fileSave).isSymbolicLink() &&
        fs.readFileSync(fileSave, 'utf8') === 'file-save-content'
    )
    check(
      'file sync-space original remains after copy to local',
      fs.existsSync(fileTarget) && fs.readFileSync(fileTarget, 'utf8') === 'file-save-content'
    )
  } catch (e: any) {
    if (/Insufficient permissions|Developer Mode/i.test(e.message)) {
      check('file symlink denied → mapped to actionable Developer Mode error', true)
      check(
        'rollback left local file intact',
        fs.existsSync(fileSave) && fs.readFileSync(fileSave, 'utf8') === 'file-save-content'
      )
    } else {
      check('single-file save flow', false, e.message)
    }
  }

  // ── [7] Japanese game name preserved ──
  console.log('[7] Japanese game name')
  await GameDBManager.setGameValue('game-jp', 'metadata.name', 'ゲーム名テスト')
  const jpSave = path.join(savesRoot, 'JpSave')
  fs.mkdirSync(jpSave)
  fs.writeFileSync(path.join(jpSave, 'data.sav'), 'jp-content')
  await convertSaveToSyncSpace('game-jp', jpSave)
  check(
    'Japanese directory created',
    fs.existsSync(path.join(vniteSaves, 'ゲーム名テスト', 'JpSave', 'data.sav'))
  )
  check('checkSaveInSyncSpace → true', await checkSaveInSyncSpace('game-jp', jpSave))

  // ── [8] Illegal characters stripped ──
  console.log('[8] illegal characters in game name')
  await GameDBManager.setGameValue('game-bad', 'metadata.name', 'Game: <Test>?* ...')
  const badSave = path.join(savesRoot, 'BadSave')
  fs.mkdirSync(badSave)
  fs.writeFileSync(path.join(badSave, 'data.sav'), 'bad-content')
  await convertSaveToSyncSpace('game-bad', badSave)
  check(
    'sanitized directory created (no illegal chars, no trailing dots/spaces)',
    fs.existsSync(path.join(vniteSaves, 'Game Test', 'BadSave', 'data.sav')),
    fs.readdirSync(vniteSaves).join(',')
  )

  // ── [9] Name empty after sanitization → gameId fallback ──
  console.log('[9] name sanitizes to empty → gameId directory')
  await GameDBManager.setGameValue('game-empty', 'metadata.name', '???***')
  const emptySave = path.join(savesRoot, 'EmptySave')
  fs.mkdirSync(emptySave)
  fs.writeFileSync(path.join(emptySave, 'data.sav'), 'empty-content')
  await convertSaveToSyncSpace('game-empty', emptySave)
  check(
    'gameId directory used',
    fs.existsSync(path.join(vniteSaves, 'game-empty', 'EmptySave', 'data.sav'))
  )

  // ── [10] Name conflict with another game → gameId fallback ──
  console.log('[10] name conflict → gameId directory')
  await GameDBManager.setGameValue('game-dup', 'metadata.name', 'My Game') // same as game-abc
  const dupSave = path.join(savesRoot, 'DupSave')
  fs.mkdirSync(dupSave)
  fs.writeFileSync(path.join(dupSave, 'data.sav'), 'dup-content')
  // Ensure "My Game" exists and is owned by game-abc (link to its retained cloud entry)
  await convertSaveToSyncSpace('game-abc', dirSave, 'use-cloud')
  await convertSaveToSyncSpace('game-dup', dupSave)
  check(
    'conflicting game fell back to gameId directory',
    fs.existsSync(path.join(vniteSaves, 'game-dup', 'DupSave', 'data.sav'))
  )
  check(
    '"My Game" still owned by game-abc',
    fs.readFileSync(path.join(vniteSaves, 'My Game', '.vnite-game-id'), 'utf8').trim() ===
      'game-abc'
  )

  // ── [11] Legacy flat entry still recognized ──
  console.log('[11] legacy structure compatibility')
  const legacyEntry = path.join(syncSpace, 'game-legacy_OldSave')
  fs.mkdirSync(legacyEntry)
  fs.writeFileSync(path.join(legacyEntry, 'old.sav'), 'LEGACY-content')
  const legacySave = path.join(savesRoot, 'OldSave')
  fs.mkdirSync(legacySave)
  fs.writeFileSync(path.join(legacySave, 'old.sav'), 'local-old-content')

  const legacyProbe = await probeSaveSyncConversion('game-legacy', legacySave)
  check('legacy structure recognized → conflict', legacyProbe.status === 'conflict')
  await convertSaveToSyncSpace('game-legacy', legacySave, 'use-cloud') // adopt the legacy entry
  check('legacy entry adopted (cloud wins)', await checkSaveInSyncSpace('game-legacy', legacySave))
  check(
    'legacy cloud content readable through link',
    fs.readFileSync(path.join(legacySave, 'old.sav'), 'utf8') === 'LEGACY-content'
  )
  await restoreSaveFromSyncSpace('game-legacy', legacySave)
  check(
    'legacy entry copied to local',
    fs.lstatSync(legacySave).isDirectory() &&
      !fs.lstatSync(legacySave).isSymbolicLink() &&
      fs.readFileSync(path.join(legacySave, 'old.sav'), 'utf8') === 'LEGACY-content'
  )
  check(
    'legacy sync space entry remains after copy to local',
    fs.existsSync(legacyEntry) &&
      fs.readFileSync(path.join(legacyEntry, 'old.sav'), 'utf8') === 'LEGACY-content'
  )

  // ── [12] Backup of a converted save follows the link (empty-backup regression) ──
  console.log('[12] backupGameSave on converted save → zip has real content')
  // dirSave was re-converted in [10]; it is a link into the sync space again
  check('precondition: dirSave is a link', fs.lstatSync(dirSave).isSymbolicLink())
  await GameDBManager.setGameLocalValue('game-abc', 'path.savePaths', [dirSave])
  await GameDBManager.setGameValue('game-abc', 'save.maxBackups', 7)
  await GameDBManager.setGameValue('game-abc', 'save.saveList', {})

  const backupId = await backupGameSave('game-abc')
  const zipBuf = storedSaves.get(`game-abc:${backupId}`)
  check('backup zip stored', zipBuf !== undefined)
  check('backup zip is not empty (>22 bytes)', (zipBuf?.length ?? 0) > 22, zipBuf?.length)
  if (zipBuf) {
    const entries = new AdmZip(zipBuf).getEntries()
    const slotEntry = entries.find((e) => e.entryName.endsWith('slot1.sav'))
    check('zip contains slot1.sav with content', (slotEntry?.getData().length ?? 0) > 0)
  }
  const savedList = await GameDBManager.getGameValue('game-abc', 'save.saveList')
  check('saveList records the backup', backupId in savedList)

  // ── [13] All save paths fail to copy → backup throws, nothing stored ──
  console.log('[13] all copy failures → backup throws (no silent empty backup)')
  await GameDBManager.setGameLocalValue('game-fail', 'path.savePaths', [
    path.join(savesRoot, 'DoesNotExist')
  ])
  await GameDBManager.setGameValue('game-fail', 'save.maxBackups', 7)
  await GameDBManager.setGameValue('game-fail', 'save.saveList', {})
  let backupThrew = false
  try {
    await backupGameSave('game-fail')
  } catch {
    backupThrew = true
  }
  check('backupGameSave rejected', backupThrew)
  check(
    'no backup stored for failed game',
    ![...storedSaves.keys()].some((k) => k.startsWith('game-fail:'))
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err)
  process.exit(2)
})
