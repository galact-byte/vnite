import { cn } from '~/utils'
import { isEncryptedPassword } from '@appUtils'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { toast } from 'sonner'
import { ipcManager } from '~/app/ipc'
import { useConfigLocalState } from '~/hooks'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { Label } from '~/components/ui/label'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { useEffect, useMemo, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '~/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import {
  User,
  LogOut,
  Loader2,
  HardDrive,
  Cloud,
  Key,
  InfoIcon,
  FolderSync,
  Upload,
  Download,
  Server,
  AlertTriangle,
  Clock,
  ChevronDown,
  CheckCircle2,
  XCircle
} from 'lucide-react'
import { Link } from '~/components/ui/link'
import { useTranslation } from 'react-i18next'
import { useCloudSyncStore } from './store'
import { ROLE_QUOTAS } from '@appTypes/sync'
import { ConfigItem, ConfigItemPure } from '~/components/form'
import { Switch } from '~/components/ui/switch'
import { Badge } from '~/components/ui/badge'
import { useGameRegistry } from '~/stores/game'
import { Trans } from 'react-i18next'

const DIFF_IGNORED_KEYS = new Set(['_id', '_rev', '_attachments'])

/** Key-order-independent serialization so reordered-but-equal objects don't diff. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function computeChangedTopLevelKeys(
  local: Record<string, unknown> | null | undefined,
  remote: Record<string, unknown> | null | undefined
): string[] {
  const keys = new Set<string>([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])
  return [...keys]
    .filter(
      (key) =>
        !DIFF_IGNORED_KEYS.has(key) &&
        stableStringify((local ?? {})[key]) !== stableStringify((remote ?? {})[key])
    )
    .sort()
}

interface ConflictDiffState {
  dbName: string
  docId: string
  loading: boolean
  local?: Record<string, unknown> | null
  remote?: Record<string, unknown> | null
  remoteDeleted?: boolean
}

export function CloudSync(): React.JSX.Element {
  const { t } = useTranslation('config')
  const { status, usedQuota, setUsedQuota } = useCloudSyncStore()
  const [enabled, setEnabled] = useConfigLocalState('sync.enabled')
  const [syncMode, setSyncMode] = useConfigLocalState('sync.mode')
  const [_1, setOfficialUsername] = useConfigLocalState('sync.officialConfig.auth.username')
  const [_2, setOfficialPassword] = useConfigLocalState('sync.officialConfig.auth.password')
  const [selfHostedUrl, setSelfHostedUrl, saveSelfHostedUrl] = useConfigLocalState(
    'sync.selfHostedConfig.url',
    true
  )
  const [selfHostedUsername, setSelfHostedUsername, saveSelfHostedUsername] = useConfigLocalState(
    'sync.selfHostedConfig.auth.username',
    true
  )
  const [selfHostedPassword, setSelfHostedPassword, saveSelfHostedPassword] = useConfigLocalState(
    'sync.selfHostedConfig.auth.password',
    true
  )
  const [userName, setUserName] = useConfigLocalState('userInfo.name')
  const [_3, setUserAccessToken] = useConfigLocalState('userInfo.accessToken')
  const [userRole, setUserRole] = useConfigLocalState('userInfo.role')
  const [userEmail, setUserEmail] = useConfigLocalState('userInfo.email')

  const [webdavUrl, setWebdavUrl, saveWebdavUrl] = useConfigLocalState(
    'sync.webdavConfig.url',
    true
  )
  const [webdavRemotePath, setWebdavRemotePath, saveWebdavRemotePath] = useConfigLocalState(
    'sync.webdavConfig.remotePath',
    true
  )
  const [webdavUsername, setWebdavUsername, saveWebdavUsername] = useConfigLocalState(
    'sync.webdavConfig.auth.username',
    true
  )
  const [webdavPassword, setWebdavPassword, saveWebdavPassword] = useConfigLocalState(
    'sync.webdavConfig.auth.password',
    true
  )
  const [webdavAutoSync, setWebdavAutoSync] = useConfigLocalState('sync.webdavConfig.autoSync')
  const [webdavAutoSyncInterval, setWebdavAutoSyncInterval] = useConfigLocalState(
    'sync.webdavConfig.autoSyncInterval'
  )

  const [webdavRemoteInfo, setWebdavRemoteInfo] = useState<{
    exists: boolean
    lastModified?: string
    size?: number
  } | null>(null)
  const [webdavConflicts, setWebdavConflicts] = useConfigLocalState('webdav-sync-conflicts.items')
  const [pendingSaveDeletions] = useConfigLocalState('webdav-pending-save-deletions.items')
  const [processingSaveDeletions, setProcessingSaveDeletions] = useState<Set<string>>(new Set())
  const [conflictsExpanded, setConflictsExpanded] = useState(false)
  const [resolvingConflicts, setResolvingConflicts] = useState<Set<string>>(new Set())
  const [conflictDiff, setConflictDiff] = useState<ConflictDiffState | null>(null)
  const [webdavStatus] = useConfigLocalState('sync.webdavStatus')
  const [syncProgress, setSyncProgress] = useState<{
    phase: 'download' | 'upload'
    database: string
    current: number
    total: number
  } | null>(null)
  const [manualSyncing, setManualSyncing] = useState(false)
  const gameMetaIndex = useGameRegistry((state) => state.gameMetaIndex)

  const [syncSpacePath, setSyncSpacePath, saveSyncSpacePath, setSyncSpacePathAndSave] =
    useConfigLocalState('sync.syncSpacePath', true)

  const conflictDisplayName = (dbName: string, docId: string): string =>
    (dbName === 'game' && gameMetaIndex[docId]?.name) || docId

  const conflictChangedKeys = useMemo(
    () =>
      conflictDiff && !conflictDiff.loading
        ? computeChangedTopLevelKeys(conflictDiff.local, conflictDiff.remote)
        : [],
    [conflictDiff]
  )

  const handleResolveConflict = async (
    dbName: string,
    docId: string,
    choice: 'local' | 'remote'
  ): Promise<void> => {
    const key = `${dbName}/${docId}`
    setResolvingConflicts((prev) => new Set(prev).add(key))
    try {
      const result = await ipcManager.invoke('db:webdav-resolve-conflict', dbName, docId, choice)
      if (result.success && result.status === 'pending-save-deletion') {
        toast.warning(t('cloudSync.webdav.saveDeletions.detected', { count: 1 }))
      } else if (result.success) {
        toast.success(t('cloudSync.webdav.conflicts.resolved'))
        // The list entry itself is removed by main and arrives via the store
        setConflictDiff((prev) =>
          prev && prev.dbName === dbName && prev.docId === docId ? null : prev
        )
      } else {
        toast.error(
          t('cloudSync.webdav.conflicts.resolveFailed', { message: result.message ?? '' })
        )
      }
    } catch (error) {
      toast.error(
        t('cloudSync.webdav.conflicts.resolveFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setResolvingConflicts((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleSaveDeletionAction = async (
    pending: (typeof pendingSaveDeletions)[number],
    action: 'confirm' | 'dismiss'
  ): Promise<void> => {
    const { id } = pending
    setProcessingSaveDeletions((prev) => new Set(prev).add(id))
    try {
      const result =
        action === 'confirm'
          ? await ipcManager.invoke('db:webdav-confirm-save-deletion', id)
          : await ipcManager.invoke('db:webdav-dismiss-save-deletion', id)
      if (result.success) {
        // The list entry itself is removed by main and arrives via the store
        toast.success(
          action === 'confirm'
            ? t('cloudSync.webdav.saveDeletions.confirmed')
            : t('cloudSync.webdav.saveDeletions.dismissed')
        )
      } else {
        toast.error(
          t('cloudSync.webdav.saveDeletions.actionFailed', { message: result.message ?? '' })
        )
      }
    } catch (error) {
      toast.error(
        t('cloudSync.webdav.saveDeletions.actionFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setProcessingSaveDeletions((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleViewConflictDiff = async (dbName: string, docId: string): Promise<void> => {
    setConflictDiff({ dbName, docId, loading: true })
    try {
      const detail = await ipcManager.invoke('db:webdav-get-conflict-detail', dbName, docId)
      if (!detail.success) {
        toast.error(t('cloudSync.webdav.conflicts.detailFailed', { message: detail.message ?? '' }))
        setConflictDiff(null)
        return
      }
      setConflictDiff({
        dbName,
        docId,
        loading: false,
        local: detail.local ?? null,
        remote: detail.remote ?? null,
        remoteDeleted: detail.remoteDeleted
      })
    } catch (error) {
      toast.error(
        t('cloudSync.webdav.conflicts.detailFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      )
      setConflictDiff(null)
    }
  }

  useEffect(() => {
    if (enabled && syncMode === 'webdav' && webdavUrl && webdavUsername) {
      ipcManager
        .invoke('db:get-webdav-remote-info')
        .then((info) => {
          setWebdavRemoteInfo(info)
        })
        .catch(console.error)
    }
  }, [enabled, syncMode, webdavUrl, webdavUsername])

  const totalQuota = ROLE_QUOTAS[userRole].maxStorage

  const [storagePercentage, setStoragePercentage] = useState(0)

  // Getting Storage Usage
  useEffect(() => {
    if (enabled && userName) {
      const fetchStorageInfo = async (): Promise<void> => {
        try {
          const dbSize = await ipcManager.invoke('db:get-couchdb-size')
          if (dbSize) {
            setUsedQuota(dbSize)
          }
        } catch (error) {
          toast.error(t(`cloudSync.errors.fetchStorageFailed ${error}`))
        }
      }

      fetchStorageInfo()
    }
  }, [enabled, userName, t])

  // Calculate Storage Percentage
  useEffect(() => {
    if (totalQuota > 0) {
      setStoragePercentage((usedQuota / totalQuota) * 100)
    } else {
      setStoragePercentage(0)
    }
  }, [usedQuota, totalQuota])

  useEffect(() => {
    ipcManager.on('account:auth-success', async () => {
      toast.success(t('cloudSync.notifications.authSuccess'))
      await updateCloudSyncConfig()
    })
    ipcManager.on('account:auth-failed', (_event, message) => {
      toast.error(`${t('cloudSync.notifications.authError')}, ${message}`)
    })

    // Listen for sync conflicts (persisted list itself arrives via config-local store)
    const removeConflictListener = ipcManager.on('db:sync-conflicts', (_event, conflicts) => {
      if (conflicts.length > 0) {
        toast.warning(t('cloudSync.webdav.conflictsDetected', { count: conflicts.length }))
      }
    })

    // Abnormal save deletions held back by the upload guard (persisted list
    // itself arrives via the config-local store)
    const removePendingDeletionListener = ipcManager.on(
      'db:sync-pending-save-deletions',
      (_event, pending) => {
        if (pending.length > 0) {
          toast.warning(t('cloudSync.webdav.saveDeletions.detected', { count: pending.length }))
        }
      }
    )

    // Live sync progress (only rendered while a manual sync is running)
    const removeProgressListener = ipcManager.on('db:sync-progress', (_event, progress) => {
      setSyncProgress(progress)
    })

    return () => {
      removeConflictListener()
      removePendingDeletionListener()
      removeProgressListener()
    }
  }, [])

  const compactRemoteDatabase = async (): Promise<void> => {
    toast.promise(
      async () => {
        await ipcManager.invoke('db:compact-remote-database')
        const dbSize = await ipcManager.invoke('db:get-couchdb-size', true)
        setUsedQuota(dbSize)
      },
      {
        loading: t('cloudSync.notifications.compacting'),
        success: t('cloudSync.notifications.compactSuccess'),
        error: t('cloudSync.notifications.compactError')
      }
    )
  }

  // Formatted Storage Size
  const formatStorage = (bytes: number): string => {
    if (bytes === 0) return '0 B'

    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const validateWebdavConfig = (): boolean => {
    if (syncMode !== 'webdav') return true
    if (!webdavUrl) {
      toast.error(t('cloudSync.webdav.validation.urlRequired'))
      return false
    }
    if (!/^https?:\/\//.test(webdavUrl)) {
      toast.error(t('cloudSync.webdav.validation.urlInvalid'))
      return false
    }
    return true
  }

  const updateCloudSyncConfig = async (): Promise<void> => {
    if (enabled) {
      if (
        syncMode === 'selfHosted' &&
        (!selfHostedUrl || !selfHostedUsername || !selfHostedPassword)
      ) {
        toast.error(t('cloudSync.errors.incompleteConfig'))
        return
      }

      if (syncMode === 'official' && !userName) {
        toast.error(t('cloudSync.errors.loginRequired'))
        return
      }

      if (!validateWebdavConfig()) {
        return
      }
    }

    toast.promise(
      async () => {
        await ipcManager.invoke('db:restart-sync')
      },
      {
        loading: t('cloudSync.notifications.updating'),
        success: t('cloudSync.notifications.updateSuccess'),
        error: t('cloudSync.notifications.updateError')
      }
    )
  }

  const testWebdav = async (): Promise<void> => {
    toast.promise(ipcManager.invoke('db:test-webdav-connection'), {
      loading: t('cloudSync.webdav.testing'),
      success: (res: any) =>
        res.success
          ? t(res.message)
          : (() => {
              throw new Error(t(res.message))
            })(),
      error: (err: any) => t('cloudSync.webdav.testFailed') + ': ' + err.message
    })
  }

  const syncWebdav = async (direction: 'upload' | 'download' | 'auto'): Promise<void> => {
    if (!validateWebdavConfig()) return
    setManualSyncing(true)
    setSyncProgress(null)
    toast.promise(
      ipcManager
        .invoke('db:webdav-sync', direction)
        .then(() => {
          // Refresh remote info after sync; conflict toast + list arrive via
          // the 'db:sync-conflicts' event and the config-local store.
          ipcManager.invoke('db:get-webdav-remote-info').then((info) => {
            setWebdavRemoteInfo(info)
          })
        })
        .finally(() => {
          setManualSyncing(false)
          setSyncProgress(null)
        }),
      {
        loading: t('cloudSync.webdav.syncing'),
        success: t('cloudSync.webdav.syncSuccess'),
        error: (err: unknown) =>
          err instanceof Error && err.message.includes('Sync already in progress')
            ? t('cloudSync.webdav.syncBusy')
            : t('cloudSync.webdav.syncFailed')
      }
    )
  }

  const handleFullSync = async (): Promise<void> => {
    try {
      await ipcManager.invoke('db:full-sync')
    } catch (error) {
      console.error('Full sync error:', error)
    }
  }

  const handleOfficialSignin = async (): Promise<void> => {
    toast.promise(
      async () => {
        await ipcManager.invoke('account:auth-signin')
      },
      {
        loading: t('cloudSync.notifications.loggingIn'),
        success: t('cloudSync.notifications.loginSuccess'),
        error: t('cloudSync.notifications.loginError')
      }
    )
  }

  const handleOfficialSignup = async (): Promise<void> => {
    toast.promise(
      async () => {
        await ipcManager.invoke('account:auth-signup')
      },
      {
        loading: t('cloudSync.notifications.registering'),
        success: t('cloudSync.notifications.registerSuccess'),
        error: t('cloudSync.notifications.registerError')
      }
    )
  }

  const handleOfficialLogout = (): void => {
    setOfficialUsername('')
    setOfficialPassword('')
    setUserName('')
    setUserAccessToken('')
    setUserEmail('')
    setUserRole('community')
    setUsedQuota(0)
    return
  }

  // Get Initials for Avatar
  const getInitials = (name: string): string => {
    if (!name) return 'U'
    return name.charAt(0).toUpperCase()
  }

  const getEditionText = (): string => {
    if (userRole === 'community') {
      return t('cloudSync.official.communityEdition')
    } else if (userRole === 'developer') {
      return t('cloudSync.official.developerEdition')
    } else {
      return t('cloudSync.official.premiumEdition')
    }
  }

  const selectSyncSpacePath = async (): Promise<void> => {
    const folderPath = await ipcManager.invoke(
      'system:select-path-dialog',
      ['openDirectory'],
      undefined,
      syncSpacePath
    )
    if (folderPath) {
      await setSyncSpacePathAndSave(folderPath)
    }
  }

  return (
    <div className={cn('flex flex-col gap-2')}>
      {enabled && (
        <Card className={cn('group p-4 px-6')}>
          {/* Status */}
          {status ? (
            <div className={cn('flex flex-row gap-1 text-xs')}>
              <div className={cn('flex flex-row gap-2 items-center justify-between')}>
                <div className={cn('flex flex-row gap-2 items-center')}>
                  <div className={cn('flex flex-row')}>
                    {status.status === 'syncing' ? (
                      <div className={cn('flex flex-row gap-1 items-center')}>
                        <span
                          className={cn(
                            'inline-block w-2 h-2 mr-3 rounded-lg',
                            'bg-accent animate-pulse'
                          )}
                        ></span>
                        <div>{t('cloudSync.status.syncing')}</div>
                      </div>
                    ) : status.status === 'success' ? (
                      <div className={cn('flex flex-row items-center')}>
                        <span
                          className={cn(
                            'inline-block w-2 h-2 mr-3 rounded-lg text-center',
                            'bg-primary'
                          )}
                        ></span>
                        <div>{t('cloudSync.status.success')}</div>
                      </div>
                    ) : (
                      <div className={cn('flex flex-row gap-1 items-center')}>
                        <span
                          className={cn('inline-block w-2 h-2 mr-3 rounded-lg', 'bg-destructive')}
                        ></span>
                        <div>{t('cloudSync.status.error')}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div>|</div>
              <div className={cn('flex flex-row gap-2 items-center')}>
                <div className={cn('truncate')}>{status.message}</div>
              </div>
              <div>|</div>
              <div className={cn('flex flex-row gap-2 items-center')}>
                <div className={cn('')}>
                  {t('{{date, niceDateSeconds}}', { date: status.timestamp })}
                </div>
              </div>
            </div>
          ) : (
            <div className={cn('text-xs')}>{t('cloudSync.status.noInfo')}</div>
          )}
        </Card>
      )}
      <Card className={cn('group')}>
        <CardHeader>
          <CardTitle className={cn('relative')}>
            <div className={cn('flex flex-row justify-between items-center')}>
              <div className={cn('flex items-center')}>{t('cloudSync.title')}</div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className={cn('')}>
          <div className={cn('space-y-5')}>
            {/* Enable/Disable Switch */}
            <ConfigItem
              hookType="configLocal"
              path="sync.enabled"
              title={t('cloudSync.enable')}
              description={t('cloudSync.enableDescription')}
              controlType="switch"
              onChange={async (value) => {
                setEnabled(value)
                if (!value) {
                  await ipcManager.invoke('db:stop-sync')
                }
              }}
            ></ConfigItem>

            {/* Full Sync Button */}
            {enabled && (
              <ConfigItemPure
                title={t('cloudSync.syncFull')}
                description={t('cloudSync.syncFullDescription')}
              >
                <Button onClick={handleFullSync}>{t('cloudSync.syncFullButton')}</Button>
              </ConfigItemPure>
            )}

            {enabled && (
              <ConfigItemPure
                title={t('cloudSync.compact')}
                description={t('cloudSync.compactDescription')}
              >
                <Button onClick={compactRemoteDatabase}>{t('cloudSync.compact')}</Button>
              </ConfigItemPure>
            )}

            {enabled && (
              <>
                {/* Synchronization mode selection */}
                <div className={cn('grid grid-cols-[1fr_auto] gap-5 items-center')}>
                  <div className={cn('whitespace-nowrap select-none')}>
                    {t('cloudSync.syncMode')}
                  </div>
                  <RadioGroup
                    className="flex flex-row gap-4"
                    value={syncMode}
                    onValueChange={setSyncMode}
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="official" id="official" />
                      <Label htmlFor="official">{t('cloudSync.modes.official')}</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="selfHosted" id="selfHosted" />
                      <Label htmlFor="self-hosted">{t('cloudSync.modes.selfHosted')}</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="webdav" id="webdav" />
                      <Label htmlFor="webdav">WebDAV</Label>
                    </div>
                  </RadioGroup>
                </div>
              </>
            )}

            {/* Official Mode UI */}
            {enabled && syncMode === 'official' && (
              <div className={cn('flex flex-col gap-4')}>
                {!userName ? (
                  <div
                    className={cn('flex flex-col gap-3 items-center p-6 bg-muted/30 rounded-lg')}
                  >
                    <Cloud size={40} className="mb-2 text-primary" />
                    <h3 className="text-lg font-medium">{t('cloudSync.official.connectTitle')}</h3>
                    <p className="mb-2 text-sm text-center text-muted-foreground">
                      {t('cloudSync.official.connectDescription')}
                    </p>
                    <div className={cn('flex flex-row gap-3')}>
                      <Button onClick={handleOfficialSignin} className="mt-2">
                        {t('cloudSync.official.login')}
                      </Button>
                      <Button variant={'outline'} onClick={handleOfficialSignup} className="mt-2">
                        {t('cloudSync.official.register')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Card className="shadow-sm">
                    <CardContent className="">
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Avatar className="border-2 w-14 h-14 bg-gradient-to-br from-primary to-primary/70 text-primary-foreground border-background">
                              <AvatarImage email={userEmail} />
                              <AvatarFallback>{getInitials(userName)}</AvatarFallback>
                            </Avatar>
                            <div>
                              <DropdownMenu>
                                <DropdownMenuTrigger className="flex items-center gap-1 transition-colors outline-none hover:text-primary">
                                  <span className="font-medium">{userName}</span>
                                  <span className="icon-[mdi--keyboard-arrow-down] mt-1"></span>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                  <DropdownMenuItem onClick={handleOfficialLogout}>
                                    <LogOut className="w-4 h-4 mr-2" />
                                    <span>{t('cloudSync.official.logout')}</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <div className="flex items-center gap-3 mt-1">
                                <span className="bg-primary/20 text-primary text-xs px-2 py-0.5 rounded-lg font-medium">
                                  {getEditionText()}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {t('cloudSync.official.lastSync')}:{' '}
                                  <span className="font-medium">
                                    {(status?.timestamp &&
                                      t('{{date, niceDateSeconds}}', { date: status.timestamp })) ||
                                      t('cloudSync.official.notSynced')}
                                  </span>
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <span
                              className={cn(
                                'inline-block w-2 h-2 mr-1 rounded-full',
                                status?.status === 'error'
                                  ? 'bg-destructive'
                                  : 'bg-primary animate-pulse'
                              )}
                            ></span>
                            <span
                              className={cn(
                                'text-xs font-medium',
                                status?.status === 'error' ? 'text-destructive' : 'text-primary'
                              )}
                            >
                              {status?.status === 'error'
                                ? t('cloudSync.official.disconnected')
                                : t('cloudSync.official.connected')}
                            </span>
                          </div>
                        </div>

                        <div className="pt-3 mt-2 border-t">
                          <div className="flex items-center justify-between mb-2">
                            <span className="flex items-center text-sm text-muted-foreground">
                              <HardDrive className="w-4 h-4 mr-1" />
                              {t('cloudSync.official.storage')}
                            </span>
                            <span className="text-sm">
                              {formatStorage(usedQuota)} / {formatStorage(totalQuota)}
                            </span>
                          </div>

                          <div className="relative w-full h-2.5 bg-muted/60 rounded-full overflow-hidden">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all',
                                storagePercentage > 90 ? 'bg-destructive' : 'bg-primary'
                              )}
                              style={{ width: `${storagePercentage}%` }}
                            ></div>
                          </div>

                          <div className="flex justify-end mt-1">
                            <span className="text-xs text-muted-foreground">
                              {storagePercentage.toFixed(1)}% {t('cloudSync.official.used')}
                            </span>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* Self-hosted mode UI */}
            {enabled && syncMode === 'selfHosted' && (
              <Card className="shadow-sm">
                <CardContent className="">
                  <div className="flex flex-col gap-5">
                    <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-4 items-center">
                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <HardDrive className="w-4 h-4" />
                        <span>{t('cloudSync.selfHosted.serverAddress')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          value={selfHostedUrl}
                          onChange={(e) => setSelfHostedUrl(e.target.value)}
                          onBlur={saveSelfHostedUrl}
                          placeholder="https://your-couchdb-server.com"
                        />
                      </div>

                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <User className="w-4 h-4" />
                        <span>{t('cloudSync.selfHosted.username')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          value={selfHostedUsername}
                          onChange={(e) => setSelfHostedUsername(e.target.value)}
                          onBlur={saveSelfHostedUsername}
                          placeholder="admin"
                        />
                      </div>

                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <Key className="w-4 h-4" />
                        <span>{t('cloudSync.selfHosted.password')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          type="password"
                          value={selfHostedPassword}
                          onChange={(e) => setSelfHostedPassword(e.target.value)}
                          onBlur={saveSelfHostedPassword}
                          placeholder="••••••••"
                        />
                      </div>

                      <div className="col-span-2 pt-2 text-xs text-muted-foreground">
                        <p className="flex items-center gap-1">
                          <InfoIcon className="w-3.5 h-3.5" />
                          <span>
                            <Trans
                              i18nKey="config:cloudSync.selfHosted.info"
                              components={{
                                couchdb: (
                                  <Link
                                    name="CouchDB"
                                    className="text-xs"
                                    url="https://couchdb.apache.org"
                                  />
                                )
                              }}
                            />
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* WebDAV mode UI */}
            {enabled && syncMode === 'webdav' && (
              <Card className="shadow-sm">
                <CardContent className="">
                  <div className="flex flex-col gap-5">
                    <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-4 items-center">
                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <Server className="w-4 h-4" />
                        <span>{t('cloudSync.webdav.serverAddress')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          value={webdavUrl}
                          onChange={(e) => setWebdavUrl(e.target.value)}
                          onBlur={saveWebdavUrl}
                          placeholder="https://your-webdav-server.com/dav/"
                        />
                      </div>

                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <FolderSync className="w-4 h-4" />
                        <span>{t('cloudSync.webdav.remotePath')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          value={webdavRemotePath}
                          onChange={(e) => setWebdavRemotePath(e.target.value)}
                          onBlur={saveWebdavRemotePath}
                          placeholder="/vnite-sync/"
                        />
                      </div>

                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <User className="w-4 h-4" />
                        <span>{t('cloudSync.webdav.username')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          value={webdavUsername}
                          onChange={(e) => setWebdavUsername(e.target.value)}
                          onBlur={saveWebdavUsername}
                          placeholder="admin"
                        />
                      </div>

                      <div className="flex items-center gap-2 select-none whitespace-nowrap">
                        <Key className="w-4 h-4" />
                        <span>{t('cloudSync.webdav.password')}</span>
                      </div>
                      <div>
                        <Input
                          className={cn('w-full')}
                          type="password"
                          value={isEncryptedPassword(webdavPassword) ? '' : webdavPassword}
                          onChange={(e) => setWebdavPassword(e.target.value)}
                          onBlur={saveWebdavPassword}
                          placeholder={
                            isEncryptedPassword(webdavPassword)
                              ? t('cloudSync.webdav.passwordSaved')
                              : '••••••••'
                          }
                        />
                      </div>

                      <div className="col-span-2 pt-2 flex flex-row gap-2">
                        <Button variant="outline" onClick={testWebdav}>
                          {t('cloudSync.webdav.testConnection')}
                        </Button>
                        <Button variant="secondary" onClick={() => syncWebdav('auto')}>
                          <FolderSync className="w-4 h-4 mr-2" />
                          {t('cloudSync.webdav.syncNow')}
                        </Button>
                        <Button variant="secondary" onClick={() => syncWebdav('upload')}>
                          <Upload className="w-4 h-4 mr-2" />
                          {t('cloudSync.webdav.upload')}
                        </Button>
                        <Button variant="secondary" onClick={() => syncWebdav('download')}>
                          <Download className="w-4 h-4 mr-2" />
                          {t('cloudSync.webdav.download')}
                        </Button>
                      </div>

                      {/* Auto-sync settings */}
                      <div className="col-span-2 pt-3 border-t">
                        <div className="flex flex-row items-center justify-between">
                          <div className="flex items-center gap-2 select-none">
                            <Clock className="w-4 h-4" />
                            <span className="text-sm">{t('cloudSync.webdav.autoSync')}</span>
                          </div>
                          <Switch checked={webdavAutoSync} onCheckedChange={setWebdavAutoSync} />
                        </div>
                        {webdavAutoSync && (
                          <div className="flex flex-row items-center gap-3 mt-3">
                            <span className="text-sm text-muted-foreground whitespace-nowrap">
                              {t('cloudSync.webdav.autoSyncInterval')}
                            </span>
                            <Input
                              className={cn('w-24')}
                              type="number"
                              min={1}
                              max={1440}
                              value={webdavAutoSyncInterval ?? 30}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10)
                                if (val > 0 && val <= 1440) {
                                  setWebdavAutoSyncInterval(val)
                                }
                              }}
                            />
                            <span className="text-sm text-muted-foreground">
                              {t('cloudSync.webdav.minutes')}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Sync progress (manual sync only) */}
                      {manualSyncing && syncProgress && (
                        <div className="col-span-2 pt-2">
                          <div className="flex items-center gap-2 p-2 text-xs rounded-md text-muted-foreground bg-muted/40">
                            <span className="inline-block w-2 h-2 rounded-lg bg-accent animate-pulse"></span>
                            <span>
                              {t(`cloudSync.webdav.progress.${syncProgress.phase}`, {
                                database: syncProgress.database,
                                current: syncProgress.current,
                                total: syncProgress.total
                              })}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Conflict list */}
                      {webdavConflicts.length > 0 && (
                        <div className="col-span-2 pt-2">
                          <div className="flex flex-col p-3 text-sm border rounded-md bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                              <button
                                type="button"
                                className="flex items-center flex-1 gap-1 text-left"
                                onClick={() => setConflictsExpanded((prev) => !prev)}
                              >
                                <span>
                                  {t('cloudSync.webdav.conflicts.title', {
                                    count: webdavConflicts.length
                                  })}
                                </span>
                                <ChevronDown
                                  className={cn(
                                    'w-4 h-4 transition-transform',
                                    conflictsExpanded && 'rotate-180'
                                  )}
                                />
                              </button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setWebdavConflicts([])}
                              >
                                {t('cloudSync.webdav.conflicts.clear')}
                              </Button>
                            </div>
                            {conflictsExpanded && (
                              <div className="flex flex-col gap-1 mt-2 border-t border-amber-200 dark:border-amber-800 pt-2">
                                {webdavConflicts.map((conflict) => {
                                  const key = `${conflict.dbName}/${conflict.docId}`
                                  const resolving = resolvingConflicts.has(key)
                                  return (
                                    <div key={key} className="flex items-center gap-2 text-xs">
                                      <Badge variant="outline">{conflict.dbName}</Badge>
                                      <span className="flex-1 truncate">
                                        {conflictDisplayName(conflict.dbName, conflict.docId)}
                                      </span>
                                      <span className="text-muted-foreground whitespace-nowrap">
                                        {t('cloudSync.webdav.conflicts.detectedAt')}{' '}
                                        {t('{{date, niceDateSeconds}}', {
                                          date: conflict.detectedAt
                                        })}
                                      </span>
                                      {resolving ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                                      ) : (
                                        <>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-6 px-2 text-xs"
                                            onClick={() =>
                                              handleViewConflictDiff(
                                                conflict.dbName,
                                                conflict.docId
                                              )
                                            }
                                          >
                                            {t('cloudSync.webdav.conflicts.viewDiff')}
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-6 px-2 text-xs"
                                            onClick={() =>
                                              handleResolveConflict(
                                                conflict.dbName,
                                                conflict.docId,
                                                'local'
                                              )
                                            }
                                          >
                                            {t('cloudSync.webdav.conflicts.keepLocal')}
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-6 px-2 text-xs"
                                            onClick={() =>
                                              handleResolveConflict(
                                                conflict.dbName,
                                                conflict.docId,
                                                'remote'
                                              )
                                            }
                                          >
                                            {t('cloudSync.webdav.conflicts.useRemote')}
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Held-back save deletions (upload guard) */}
                      {pendingSaveDeletions.length > 0 && (
                        <div className="col-span-2 pt-2">
                          <div className="flex flex-col p-3 text-sm border rounded-md bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                              <span className="flex-1">
                                {t('cloudSync.webdav.saveDeletions.title', {
                                  count: pendingSaveDeletions.length
                                })}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {t('cloudSync.webdav.saveDeletions.description')}
                            </div>
                            <div className="flex flex-col gap-1 mt-2 border-t border-red-200 dark:border-red-800 pt-2">
                              {pendingSaveDeletions.map((pending) => {
                                const processing = processingSaveDeletions.has(pending.id)
                                return (
                                  <div key={pending.id} className="flex items-center gap-2 text-xs">
                                    <span className="flex-1 truncate">
                                      {conflictDisplayName('game', pending.gameId)}
                                    </span>
                                    <div className="flex flex-col flex-1 min-w-0 text-muted-foreground">
                                      <span>
                                        {pending.comparisonFailed
                                          ? t('cloudSync.webdav.saveDeletions.comparisonFailed')
                                          : pending.clearsHistory
                                            ? t('cloudSync.webdav.saveDeletions.itemClearsAll', {
                                                total: pending.remoteSaveCount
                                              })
                                            : t('cloudSync.webdav.saveDeletions.itemPartial', {
                                                removed: pending.removedCount,
                                                total: pending.remoteSaveCount
                                              })}
                                      </span>
                                      {!pending.comparisonFailed && (
                                        <span className="break-all text-[10px]">
                                          {t('cloudSync.webdav.saveDeletions.binding', {
                                            remoteHash: pending.remoteHash,
                                            localHash: pending.localHash,
                                            saveIds: pending.removedSaveIds?.join(', ') || '-'
                                          })}
                                        </span>
                                      )}
                                    </div>
                                    {processing ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                                    ) : pending.comparisonFailed ? null : (
                                      <>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-6 px-2 text-xs"
                                          onClick={() =>
                                            handleSaveDeletionAction(pending, 'dismiss')
                                          }
                                        >
                                          {t('cloudSync.webdav.saveDeletions.keepCloud')}
                                        </Button>
                                        <Button
                                          variant="destructive"
                                          size="sm"
                                          className="h-6 px-2 text-xs"
                                          onClick={() =>
                                            handleSaveDeletionAction(pending, 'confirm')
                                          }
                                        >
                                          {t('cloudSync.webdav.saveDeletions.confirmDelete')}
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Conflict diff dialog */}
                      <Dialog
                        open={conflictDiff !== null}
                        onOpenChange={(open) => !open && setConflictDiff(null)}
                      >
                        <DialogContent className="max-w-3xl">
                          <DialogHeader>
                            <DialogTitle>
                              {t('cloudSync.webdav.conflicts.diffTitle', {
                                name: conflictDiff
                                  ? conflictDisplayName(conflictDiff.dbName, conflictDiff.docId)
                                  : ''
                              })}
                            </DialogTitle>
                          </DialogHeader>
                          {conflictDiff?.loading ? (
                            <div className="flex items-center justify-center py-8">
                              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            </div>
                          ) : conflictDiff ? (
                            <>
                              <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto text-xs">
                                {conflictDiff.remote === null && (
                                  <p className="text-muted-foreground">
                                    {t('cloudSync.webdav.conflicts.remoteMissing')}
                                  </p>
                                )}
                                {conflictChangedKeys.length === 0 ? (
                                  <p className="text-muted-foreground">
                                    {t('cloudSync.webdav.conflicts.noDiff')}
                                  </p>
                                ) : (
                                  <>
                                    <div className="grid grid-cols-2 gap-2 font-medium">
                                      <span>{t('cloudSync.webdav.conflicts.localVersion')}</span>
                                      <span>{t('cloudSync.webdav.conflicts.remoteVersion')}</span>
                                    </div>
                                    {conflictChangedKeys.map((key) => (
                                      <div key={key} className="flex flex-col gap-1">
                                        <span className="font-medium">{key}</span>
                                        <div className="grid grid-cols-2 gap-2">
                                          <pre className="p-2 rounded-md bg-muted/40 overflow-x-auto whitespace-pre-wrap break-all">
                                            {JSON.stringify(
                                              (conflictDiff.local ?? {})[key],
                                              null,
                                              2
                                            ) ?? '—'}
                                          </pre>
                                          <pre className="p-2 rounded-md bg-muted/40 overflow-x-auto whitespace-pre-wrap break-all">
                                            {JSON.stringify(
                                              (conflictDiff.remote ?? {})[key],
                                              null,
                                              2
                                            ) ?? '—'}
                                          </pre>
                                        </div>
                                      </div>
                                    ))}
                                  </>
                                )}
                              </div>
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={resolvingConflicts.has(
                                    `${conflictDiff.dbName}/${conflictDiff.docId}`
                                  )}
                                  onClick={() =>
                                    handleResolveConflict(
                                      conflictDiff.dbName,
                                      conflictDiff.docId,
                                      'local'
                                    )
                                  }
                                >
                                  {t('cloudSync.webdav.conflicts.keepLocal')}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    conflictDiff.remote === null ||
                                    resolvingConflicts.has(
                                      `${conflictDiff.dbName}/${conflictDiff.docId}`
                                    )
                                  }
                                  onClick={() =>
                                    handleResolveConflict(
                                      conflictDiff.dbName,
                                      conflictDiff.docId,
                                      'remote'
                                    )
                                  }
                                >
                                  {t('cloudSync.webdav.conflicts.useRemote')}
                                </Button>
                              </div>
                            </>
                          ) : null}
                        </DialogContent>
                      </Dialog>

                      <div className="col-span-2 pt-2 text-xs text-muted-foreground border-t mt-2">
                        <p className="flex items-center gap-1 mb-2 font-medium">
                          <InfoIcon className="w-3.5 h-3.5" />
                          <span>{t('cloudSync.webdav.remoteInfo')}</span>
                        </p>
                        {webdavRemoteInfo === null ? (
                          <p>{t('cloudSync.webdav.loadingInfo')}</p>
                        ) : webdavRemoteInfo.exists ? (
                          <div className="flex flex-col gap-1">
                            <p>
                              {t('cloudSync.webdav.lastModified')}:{' '}
                              {new Date(webdavRemoteInfo.lastModified || '').toLocaleString()}
                            </p>
                            <p>
                              {t('cloudSync.webdav.size')}:{' '}
                              {formatStorage(webdavRemoteInfo.size || 0)}
                            </p>
                          </div>
                        ) : (
                          <p>{t('cloudSync.webdav.noRemoteSnapshot')}</p>
                        )}

                        {/* Local sync status (persisted on this device) */}
                        <p className="flex items-center gap-1 mt-3 mb-2 font-medium">
                          <InfoIcon className="w-3.5 h-3.5" />
                          <span>{t('cloudSync.webdav.status.title')}</span>
                        </p>
                        {webdavStatus?.lastAttemptAt ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span>
                                {t('cloudSync.webdav.status.lastSync')}:{' '}
                                {t('{{date, niceDateSeconds}}', {
                                  date: webdavStatus.lastAttemptAt
                                })}
                              </span>
                              {webdavStatus.lastResult === 'success' && (
                                <Badge variant="outline" className="gap-1">
                                  <CheckCircle2 className="w-3 h-3 text-primary" />
                                  {t('cloudSync.webdav.status.success')}
                                </Badge>
                              )}
                              {webdavStatus.lastResult === 'conflict' && (
                                <Badge variant="outline" className="gap-1">
                                  <AlertTriangle className="w-3 h-3 text-amber-600" />
                                  {t('cloudSync.webdav.status.conflict', {
                                    count: webdavStatus.lastConflictCount
                                  })}
                                </Badge>
                              )}
                              {webdavStatus.lastResult === 'error' && (
                                <Badge variant="outline" className="gap-1">
                                  <XCircle className="w-3 h-3 text-destructive" />
                                  {t('cloudSync.webdav.status.error')}
                                </Badge>
                              )}
                            </div>
                            {webdavStatus.lastResult === 'error' && webdavStatus.lastError && (
                              <p className="text-destructive truncate">
                                {webdavStatus.lastError.slice(0, 120)}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p>{t('cloudSync.webdav.status.never')}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Save button */}
            {enabled && (
              <div className={cn('flex justify-end pt-2')}>
                <Button onClick={updateCloudSyncConfig}>{t('utils:common.save')}</Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      <Card className={cn('group mt-5')}>
        <CardHeader>
          <CardTitle className={cn('relative')}>
            <div className={cn('flex flex-row justify-between items-center')}>
              <div className={cn('flex items-center')}>{t('cloudSync.syncSpace.title')}</div>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className={cn('space-y-4 text-sm')}>
            <div className="text-muted-foreground mb-4">{t('cloudSync.syncSpace.description')}</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-4 items-center">
              <div className="flex items-center gap-2 select-none whitespace-nowrap">
                <FolderSync className="w-4 h-4" />
                <span>{t('cloudSync.syncSpace.path')}</span>
              </div>
              <div className={cn('flex flex-row gap-3 items-center')}>
                <Input
                  className={cn('flex-1')}
                  value={syncSpacePath || ''}
                  onChange={(e) => setSyncSpacePath(e.target.value)}
                  onBlur={saveSyncSpacePath}
                  placeholder="D:\OneDrive\VniteSaves"
                />
                <Button
                  variant={'outline'}
                  size={'icon'}
                  title={t('cloudSync.syncSpace.browse')}
                  onClick={selectSyncSpacePath}
                >
                  <span className={cn('icon-[mdi--folder-outline] w-5 h-5')}></span>
                </Button>
              </div>
              <div></div>
              <p className="text-sm text-muted-foreground">{t('cloudSync.syncSpace.hint')}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
