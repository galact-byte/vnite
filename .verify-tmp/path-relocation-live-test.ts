import { strict as assert } from 'node:assert'
import { DEFAULT_GAME_LOCAL_VALUES, type gameLocalDoc } from '../src/types/models/game'
import { normalizePath, relocateGameLocalPaths } from '../src/main/utils/pathUtils'

function createGameLocalDoc(): gameLocalDoc {
  return JSON.parse(JSON.stringify(DEFAULT_GAME_LOCAL_VALUES)) as gameLocalDoc
}

function assertPathEqual(actual: string, expected: string): void {
  assert.equal(normalizePath(actual), normalizePath(expected))
}

function main(): void {
  const oldGamePath = 'G:\\Game\\bin\\win64\\game.exe'
  const newGamePath = 'F:\\NewGame\\bin\\win64\\game.exe'
  const doc = createGameLocalDoc()

  doc.path.gamePath = newGamePath
  doc.launcher.fileConfig.path = 'G:\\Game\\bin\\win64\\launcher.exe'
  doc.launcher.fileConfig.monitorPath = 'G:\\Game\\bin\\win64'
  doc.launcher.urlConfig.url = 'https://example.com/launch?path=G:\\Game'
  doc.launcher.urlConfig.browserPath = 'C:\\Program Files\\Browser\\browser.exe'
  doc.launcher.urlConfig.monitorPath = 'G:\\Game\\game.exe'
  doc.launcher.scriptConfig.workingDirectory = 'G:\\Game\\tools'
  doc.launcher.scriptConfig.command = ['"G:\\Game\\tools\\run.cmd" --keep-old-path']
  doc.launcher.scriptConfig.monitorPath = 'G:\\Game\\bin\\win64\\game.exe'

  const relocated = relocateGameLocalPaths(oldGamePath, newGamePath, doc)

  assert.equal(relocated.relocatedFieldCount, 5)
  assert.notEqual(relocated.doc, doc)
  assertPathEqual(doc.launcher.fileConfig.path, 'G:\\Game\\bin\\win64\\launcher.exe')
  assertPathEqual(relocated.doc.launcher.fileConfig.path, 'F:\\NewGame\\bin\\win64\\launcher.exe')
  assertPathEqual(relocated.doc.launcher.fileConfig.monitorPath, 'F:\\NewGame\\bin\\win64')
  assertPathEqual(relocated.doc.launcher.urlConfig.monitorPath, 'F:\\NewGame\\game.exe')
  assertPathEqual(relocated.doc.launcher.scriptConfig.workingDirectory, 'F:\\NewGame\\tools')
  assertPathEqual(
    relocated.doc.launcher.scriptConfig.monitorPath,
    'F:\\NewGame\\bin\\win64\\game.exe'
  )
  assert.equal(relocated.doc.launcher.urlConfig.url, 'https://example.com/launch?path=G:\\Game')
  assert.equal(
    relocated.doc.launcher.urlConfig.browserPath,
    'C:\\Program Files\\Browser\\browser.exe'
  )
  assert.deepEqual(relocated.doc.launcher.scriptConfig.command, [
    '"G:\\Game\\tools\\run.cmd" --keep-old-path'
  ])

  const dataRoot = createGameLocalDoc()
  dataRoot.path.gamePath = 'F:\\NewData\\bin\\win64\\game.exe'
  dataRoot.launcher.fileConfig.path = 'G:\\Data\\launcher.exe'
  dataRoot.launcher.fileConfig.monitorPath = 'G:\\Data\\game.exe'

  const dataRootRelocated = relocateGameLocalPaths(
    'G:\\Data\\bin\\win64\\game.exe',
    'F:\\NewData\\bin\\win64\\game.exe',
    dataRoot
  )

  assert.equal(dataRootRelocated.relocatedFieldCount, 2)
  assertPathEqual(dataRootRelocated.doc.launcher.fileConfig.path, 'F:\\NewData\\launcher.exe')
  assertPathEqual(dataRootRelocated.doc.launcher.fileConfig.monitorPath, 'F:\\NewData\\game.exe')

  const outsideRoot = createGameLocalDoc()
  outsideRoot.path.gamePath = newGamePath
  outsideRoot.launcher.fileConfig.path = 'G:\\Game2\\launcher.exe'
  outsideRoot.launcher.fileConfig.monitorPath = 'D:\\Monitor\\game.exe'
  outsideRoot.launcher.urlConfig.monitorPath = 'game.exe'
  outsideRoot.launcher.scriptConfig.workingDirectory = ''
  outsideRoot.launcher.scriptConfig.monitorPath = 'G:\\Games\\game.exe'

  const unchanged = relocateGameLocalPaths(oldGamePath, newGamePath, outsideRoot)

  assert.equal(unchanged.relocatedFieldCount, 0)
  assert.equal(unchanged.doc.launcher.fileConfig.path, 'G:\\Game2\\launcher.exe')
  assert.equal(unchanged.doc.launcher.fileConfig.monitorPath, 'D:\\Monitor\\game.exe')
  assert.equal(unchanged.doc.launcher.urlConfig.monitorPath, 'game.exe')
  assert.equal(unchanged.doc.launcher.scriptConfig.workingDirectory, '')
  assert.equal(unchanged.doc.launcher.scriptConfig.monitorPath, 'G:\\Games\\game.exe')

  const caseAndSlash = createGameLocalDoc()
  caseAndSlash.path.gamePath = 'f:/NewGame/bin/win64/game.exe'
  caseAndSlash.launcher.fileConfig.path = 'g:/GAME/Bin/Win64/launcher.exe'

  const caseRelocated = relocateGameLocalPaths(
    'G:/Game/bin/win64/game.exe',
    'f:/NewGame/bin/win64/game.exe',
    caseAndSlash
  )

  assert.equal(caseRelocated.relocatedFieldCount, 1)
  assertPathEqual(caseRelocated.doc.launcher.fileConfig.path, 'f:/NewGame/Bin/Win64/launcher.exe')

  const samePath = createGameLocalDoc()
  samePath.launcher.fileConfig.path = 'G:\\Game\\launcher.exe'
  const noOp = relocateGameLocalPaths('G:\\Game\\game.exe', 'g:/game/game.exe', samePath)

  assert.equal(noOp.relocatedFieldCount, 0)
  assert.equal(noOp.doc, samePath)

  console.log('path relocation contract passed')
}

main()
