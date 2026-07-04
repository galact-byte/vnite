import { ArrayTextarea } from '@ui/array-textarea'
import { Button } from '@ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@ui/card'
import { Checkbox } from '@ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@ui/alert-dialog'
import { Input } from '@ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@ui/select'
import { Separator } from '@ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui/tooltip'
import React, { useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ipcManager } from '~/app/ipc'
import { Switch } from '~/components/ui/switch'
import { useGameLocalState, useGameState } from '~/hooks'
import { cn } from '~/utils'

import { Cloud, HardDrive, DownloadCloud, UploadCloud } from 'lucide-react'

export interface PathHandle {
  save: () => Promise<void>
}

function SavePathSyncStatus({ gameId, savePath }: { gameId: string, savePath: string }) {
  const { t } = useTranslation('game')
  const [isCloud, setIsCloud] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const checkStatus = useCallback(() => {
    ipcManager.invoke('game:check-save-in-sync-space', gameId, savePath).then(setIsCloud).catch(() => setIsCloud(false))
  }, [gameId, savePath])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  const confirmConvert = () => {
    setShowConfirm(false)
    setLoading(true)
    const p = ipcManager.invoke('game:convert-save-to-sync-space', gameId, savePath)
    toast.promise(p, {
      loading: t('detail.properties.path.syncSpace.converting'),
      success: () => {
        checkStatus()
        return t('detail.properties.path.syncSpace.convertSuccess')
      },
      error: (err) => {
        checkStatus()
        return `${t('detail.properties.path.syncSpace.convertError')}: ${err.message}`
      }
    })
    p.finally(() => setLoading(false))
  }

  const handleConvert = () => {
    setShowConfirm(true)
  }

  const handleRestore = () => {
    setLoading(true)
    const p = ipcManager.invoke('game:restore-save-from-sync-space', gameId, savePath)
    toast.promise(p, {
      loading: t('detail.properties.path.syncSpace.restoring'),
      success: () => {
        checkStatus()
        return t('detail.properties.path.syncSpace.restoreSuccess')
      },
      error: (err) => {
        checkStatus()
        return `${t('detail.properties.path.syncSpace.restoreError')}: ${err.message}`
      }
    })
    p.finally(() => setLoading(false))
  }

  if (isCloud === null) return null

  return (
    <>
      <div className="flex flex-row items-center justify-between p-2 mt-2 border rounded-md text-sm bg-muted/20">
        <div className="flex flex-col gap-1 overflow-hidden pr-2">
          <div className="flex items-center gap-2">
            {isCloud ? <Cloud className="w-4 h-4 text-primary" /> : <HardDrive className="w-4 h-4 text-muted-foreground" />}
            <span className="font-medium">{isCloud ? t('detail.properties.path.syncSpace.cloudStatus') : t('detail.properties.path.syncSpace.localStatus')}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate" title={savePath}>{savePath}</div>
        </div>
        <div>
          {isCloud ? (
            <Button variant="outline" size="sm" onClick={handleRestore} disabled={loading}>
              <DownloadCloud className="w-3.5 h-3.5 mr-1" />
              {t('detail.properties.path.syncSpace.restoreBtn')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={handleConvert} disabled={loading}>
              <UploadCloud className="w-3.5 h-3.5 mr-1" />
              {t('detail.properties.path.syncSpace.convertBtn')}
            </Button>
          )}
        </div>
      </div>
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.properties.path.syncSpace.convertConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('detail.properties.path.syncSpace.convertConfirmDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('utils:common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmConvert}>{t('utils:common.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function PathComponent(
  { gameId }: { gameId: string },
  ref: React.Ref<PathHandle>
): React.JSX.Element {
  const { t } = useTranslation('game')
  const [monitorPath] = useGameLocalState(gameId, 'launcher.fileConfig.monitorPath')
  const [gamePath, setGamePath, saveGamePath, setGamePathAndSave] = useGameLocalState(
    gameId,
    'path.gamePath',
    true
  )
  const [savePaths, setSavePaths, saveSavePaths, setSavePathsAndSave] = useGameLocalState(
    gameId,
    'path.savePaths',
    true
  )
  const [markerPath] = useGameLocalState(gameId, 'utils.markPath')
  const [rootPath, setRootPath, saveRootPath, setRootPathAndSave] = useGameLocalState(
    gameId,
    'utils.rootPath',
    true
  )
  const [maxSaveBackups, setMaxSaveBackups] = useGameState(gameId, 'save.maxBackups')
  const [savePathSize, setSavePathSize] = useState(0)
  const [isGamePathValid, setIsGamePathValid] = useState(true)
  const [isScreenshotPathValid, setIsScreenshotPathValid] = useState(true)
  const [screenshotPath, setScreenshotPath, saveScreenshotPath, setScreenshotPathAndSave] =
    useGameLocalState(gameId, 'path.screenshotPath', true)
  const [autoRestoreSave, setAutoRestoreSave] = useGameState(gameId, 'save.autoRestoreSave')

  const [showSearchDialog, setShowSearchDialog] = useState(false)
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [selectedSearchResults, setSelectedSearchResults] = useState<Record<string, boolean>>({})

  const openSearchDialog = async (): Promise<void> => {
    const promise = ipcManager.invoke('game:search-save-paths', gameId)

    toast.promise(promise, {
      loading: t('detail.properties.path.search.loading'),
      error: (err) => t('detail.properties.path.search.error', { message: err.message })
    })

    promise.then((results) => {
      setSearchResults(results ?? [])

      const map: Record<string, boolean> = {}
      ;(results ?? []).forEach((p) => (map[p] = false))

      setSelectedSearchResults(map)
      setShowSearchDialog(true)
    })
  }

  const confirmSearchSelection = async (): Promise<void> => {
    const picked = Object.keys(selectedSearchResults).filter((p) => selectedSearchResults[p])
    if (picked.length === 0) {
      setShowSearchDialog(false)
      return
    }
    const combined = savePaths.concat(picked)
    const newSavePaths = Array.from(new Set(combined))
    await setSavePathsAndSave(newSavePaths.filter(Boolean))
    setShowSearchDialog(false)
  }

  const saveAll = useCallback(async () => {
    await Promise.all([saveGamePath(), saveRootPath(), saveSavePaths(), saveScreenshotPath()])
  }, [saveGamePath, saveRootPath, saveSavePaths, saveScreenshotPath])
  useImperativeHandle(ref, () => ({ save: saveAll }), [saveAll])

  useEffect(() => {
    if (!gamePath) {
      setIsGamePathValid(true)
      return
    }
    ipcManager
      .invoke('system:check-if-path-exist', [gamePath])
      .then((res: boolean[]) => setIsGamePathValid(res[0]))
      .catch(() => setIsGamePathValid(false))
  }, [gamePath])

  useEffect(() => {
    if (!screenshotPath) {
      setIsScreenshotPathValid(true)
      return
    }
    ipcManager
      .invoke('system:check-if-path-exist', [screenshotPath])
      .then((res: boolean[]) => setIsScreenshotPathValid(res[0]))
      .catch(() => setIsScreenshotPathValid(false))
  }, [screenshotPath])

  useEffect(() => {
    if (!savePaths.some(Boolean)) {
      setSavePathSize(-1)
      return
    }
    ipcManager
      .invoke('system:get-path-size', savePaths)
      .then((size: number) => setSavePathSize(size))
      .catch(() => setSavePathSize(NaN))
  }, [savePaths])

  async function selectScreenshotFolderPath(): Promise<void> {
    const folderPath = await ipcManager.invoke(
      'system:select-path-dialog',
      ['openDirectory'],
      undefined,
      rootPath
    )
    if (!folderPath) {
      return
    }
    await setScreenshotPathAndSave(folderPath)
  }

  function formatSize(bytes: number): string {
    if (savePathSize === -1) return ''
    if (Number.isNaN(bytes)) return 'N/A'
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(2)} KiB`
    const mb = kb / 1024
    if (mb < 1024) return `${mb.toFixed(2)} MiB`
    const gb = mb / 1024
    return `${gb.toFixed(2)} GiB`
  }

  async function selectGamePath(): Promise<void> {
    const filePath = await ipcManager.invoke(
      'system:select-path-dialog',
      ['openFile'],
      undefined,
      gamePath || markerPath
    )
    if (!filePath) {
      return
    }
    await setGamePathAndSave(filePath)
    const isIconAccessible = await ipcManager.invoke(
      'db:check-attachment',
      'game',
      gameId,
      'images/icon.webp'
    )
    if (!isIconAccessible) {
      await ipcManager.invoke('utils:save-game-icon-by-file', gameId, filePath)
    }
    if (!monitorPath) {
      toast.promise(
        async () => {
          await ipcManager.invoke('launcher:select-preset', 'default', gameId)
        },
        {
          loading: t('detail.properties.path.notifications.configuring'),
          success: t('detail.properties.path.notifications.success'),
          error: (error) => `${error}`
        }
      )
    }
  }

  async function selectRootPath(): Promise<void> {
    const folderPath = await ipcManager.invoke(
      'system:select-path-dialog',
      ['openDirectory'],
      undefined,
      rootPath
    )
    if (!folderPath) {
      return
    }
    await setRootPathAndSave(folderPath)
  }

  async function selectSaveFolderPath(): Promise<void> {
    const folderPath = await ipcManager.invoke(
      'system:select-multiple-path-dialog',
      ['openDirectory'],
      undefined,
      rootPath
    )
    if (!folderPath) {
      return
    }
    const newSavePath = savePaths.concat(folderPath)
    await setSavePathsAndSave(newSavePath.filter(Boolean))
  }

  async function selectSaveFilePath(): Promise<void> {
    const filePath = await ipcManager.invoke(
      'system:select-multiple-path-dialog',
      ['openFile'],
      undefined,
      rootPath
    )
    if (!filePath) {
      return
    }
    const newSavePath = savePaths.concat(filePath)
    await setSavePathsAndSave(newSavePath.filter(Boolean))
  }

  return (
    <Card className={cn('group')}>
      <CardHeader>
        <CardTitle>{t('detail.properties.path.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('flex flex-col gap-5')}>
          {/* Path Setting */}
          <div className={cn('grid grid-cols-[auto_1fr] gap-x-5 gap-y-5 items-center')}>
            {/* Game Path */}
            <div className={cn('whitespace-nowrap select-none self-center')}>
              {t('detail.properties.path.gamePath')}
            </div>
            <div className={cn('flex flex-row gap-3 items-center')}>
              <Input
                aria-invalid={!isGamePathValid}
                className={cn('flex-1')}
                value={gamePath}
                onChange={(e) => setGamePath(e.target.value)}
                onBlur={saveGamePath}
              />
              <Button variant={'outline'} size={'icon'} onClick={selectGamePath}>
                <span className={cn('icon-[mdi--file-outline] w-5 h-5')}></span>
              </Button>
            </div>

            {/* Root Path */}
            <div className={cn('whitespace-nowrap select-none self-center')}>
              {t('detail.properties.path.rootPath')}
            </div>
            <div className={cn('flex flex-row gap-3 items-center')}>
              <Input
                className={cn('flex-1')}
                value={rootPath || ''}
                onChange={(e) => setRootPath(e.target.value)}
                onBlur={saveRootPath}
              />
              <Button variant={'outline'} size={'icon'} onClick={selectRootPath}>
                <span className={cn('icon-[mdi--folder-outline] w-5 h-5')}></span>
              </Button>
            </div>

            {/* Screenshot Path */}
            <div className={cn('whitespace-nowrap select-none self-center')}>
              {t('detail.properties.path.screenshotPath')}
            </div>
            <div className={cn('flex flex-row gap-3 items-center')}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Input
                    aria-invalid={!isScreenshotPathValid}
                    className={cn('flex-1')}
                    value={screenshotPath || ''}
                    onChange={(e) => setScreenshotPath(e.target.value)}
                    onBlur={saveScreenshotPath}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t('detail.properties.path.screenshotPathTooltip')}
                </TooltipContent>
              </Tooltip>
              <Button variant={'outline'} size={'icon'} onClick={selectScreenshotFolderPath}>
                <span className={cn('icon-[mdi--folder-outline] w-5 h-5')}></span>
              </Button>
            </div>

            {/* Save Path */}
            <div className={cn('whitespace-nowrap select-none self-start pt-2')}>
              <div>{t('detail.properties.path.savePath')}</div>
              <div
                className={cn('text-xs pt-2', {
                  'text-destructive': Number.isNaN(savePathSize) || savePathSize > 1024 * 1024 * 256
                })}
              >{`${formatSize(savePathSize)}`}</div>
            </div>

            <div className={cn('flex flex-row gap-3 items-start')}>
              <ArrayTextarea
                className={cn('flex-1 max-h-[400px] min-h-[130px] resize-none')}
                value={savePaths}
                onChange={setSavePaths}
                onBlur={saveSavePaths}
              />
              <div className={cn('flex flex-col gap-3')}>
                <Tooltip>
                  <TooltipTrigger>
                    <Button variant={'outline'} size={'icon'} onClick={openSearchDialog}>
                      <span className={cn('icon-[mdi--magnify] w-5 h-5')}></span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t('detail.properties.path.search.tooltip')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger>
                    <Button variant={'outline'} size={'icon'} onClick={selectSaveFolderPath}>
                      <span className={cn('icon-[mdi--folder-plus-outline] w-5 h-5')}></span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t('detail.properties.path.addFolder')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger>
                    <Button variant={'outline'} size={'icon'} onClick={selectSaveFilePath}>
                      <span className={cn('icon-[mdi--file-plus-outline] w-5 h-5')}></span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t('detail.properties.path.addFile')}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            
            {savePaths.filter(Boolean).length > 0 && (
              <div className="col-span-2 col-start-2 -mt-3 flex flex-col gap-1">
                {savePaths.filter(Boolean).map(savePath => (
                  <SavePathSyncStatus key={savePath} savePath={savePath} gameId={gameId} />
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Maximum Backup Settings */}
          <div className={cn('flex flex-row gap-5 items-center justify-start text-sm')}>
            <div className={cn('whitespace-nowrap select-none')}>
              {t('detail.properties.path.maxBackups')}
            </div>
            <div>
              <Select
                value={maxSaveBackups.toString()}
                onValueChange={(v) => setMaxSaveBackups(Number(v))}
              >
                <SelectTrigger className={cn('w-[120px]')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{t('detail.properties.path.maxBackups')}</SelectLabel>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="4">4</SelectItem>
                    <SelectItem value="5">5</SelectItem>
                    <SelectItem value="6">6</SelectItem>
                    <SelectItem value="7">7</SelectItem>
                    <SelectItem value="8">8</SelectItem>
                    <SelectItem value="9">9</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Auto restore newest backup save */}
          <div className={cn('flex flex-row gap-5 items-center justify-start text-sm')}>
            <div className={cn('whitespace-nowrap select-none')}>
              {t('detail.properties.path.autoRestoreSave')}
            </div>
            <div>
              <Switch checked={autoRestoreSave} onCheckedChange={setAutoRestoreSave} />
            </div>
          </div>
        </div>
      </CardContent>

      <Dialog open={showSearchDialog} onOpenChange={setShowSearchDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('detail.properties.path.search.results')}</DialogTitle>
          </DialogHeader>
          <div className={cn('flex items-center justify-between mb-3')}>
            <div className={cn('flex flex-col gap-2')}>
              {searchResults.length === 0 ? (
                <div className={cn('text-sm text-muted-foreground')}>
                  {t('detail.properties.path.search.noResults')}
                </div>
              ) : (
                searchResults.map((p, index) => (
                  <div key={p} className="flex flex-row items-center gap-2">
                    <Checkbox
                      id={`search-result-${index}`}
                      checked={!!selectedSearchResults[p]}
                      onCheckedChange={(val: boolean | 'indeterminate') =>
                        setSelectedSearchResults((prev) => ({ ...prev, [p]: !!val }))
                      }
                    />
                    <label htmlFor={`search-result-${index}`}>{p}</label>
                  </div>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant={'ghost'} onClick={() => setShowSearchDialog(false)}>
              {t('utils:common.cancel')}
            </Button>
            <Button className={cn('ml-2')} onClick={confirmSearchSelection}>
              {t('utils:common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export const Path = React.forwardRef(PathComponent)
