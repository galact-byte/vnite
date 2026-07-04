import { ConfigDBManager } from '~/core/database'
import { baseDBManager } from '~/core/database'
import { ipcManager } from '~/core/ipc'
import { getCouchDBSize } from './cloud'
import { syncViaWebDAV } from './webdav'
import { ROLE_QUOTAS } from '@appTypes/sync'
import log from 'electron-log/main'

let webdavSyncInterval: NodeJS.Timeout | null = null

export async function startSync(): Promise<void> {
  try {
    const syncConfig = await ConfigDBManager.getConfigLocalValue('sync')
    const userInfo = await ConfigDBManager.getConfigLocalValue('userInfo')
    if (!syncConfig.enabled) {
      return
    }

    if (syncConfig.mode === 'official') {
      if (
        !syncConfig.officialConfig.auth.username ||
        !syncConfig.officialConfig.auth.password ||
        !userInfo.name ||
        !userInfo.accessToken ||
        !userInfo.role
      ) {
        log.error('[Sync] Missing official sync username or password')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Missing official sync username or password',
          timestamp: new Date().toISOString()
        })

        return
      }
      // Check if the database size exceeds the quota for the user's role
      const roleQuotas = ROLE_QUOTAS[userInfo.role]
      const dbSize = await getCouchDBSize(syncConfig.officialConfig.auth.username)
      if (dbSize > roleQuotas.dbSize) {
        log.error('[Sync] Database size exceeds quota')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Database size exceeds quota',
          timestamp: new Date().toISOString()
        })

        return
      }
      await baseDBManager.syncAllWithRemote(import.meta.env.VITE_COUCHDB_SERVER_URL, {
        auth: {
          username: syncConfig.officialConfig.auth.username,
          password: syncConfig.officialConfig.auth.password
        },
        isOfficial: true
      })
    } else if (syncConfig.mode === 'selfHosted') {
      if (
        !syncConfig.selfHostedConfig.url ||
        !syncConfig.selfHostedConfig.auth.username ||
        !syncConfig.selfHostedConfig.auth.password
      ) {
        log.error('[Sync] Missing self-hosted sync configuration')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Missing self-hosted sync configuration',
          timestamp: new Date().toISOString()
        })

        return
      }
      await baseDBManager.syncAllWithRemote(syncConfig.selfHostedConfig.url, {
        auth: {
          username: syncConfig.selfHostedConfig.auth.username,
          password: syncConfig.selfHostedConfig.auth.password
        },
        isOfficial: false
      })
    } else if (syncConfig.mode === 'webdav') {
      if (
        !syncConfig.webdavConfig.url ||
        !syncConfig.webdavConfig.auth.username ||
        !syncConfig.webdavConfig.auth.password
      ) {
        log.error('[Sync] Missing webdav sync configuration')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Missing webdav sync configuration',
          timestamp: new Date().toISOString()
        })

        return
      }

      ipcManager.send('db:sync-status', {
        status: 'syncing',
        message: 'Syncing via WebDAV...',
        timestamp: new Date().toISOString()
      })

      try {
        const result = await syncViaWebDAV(syncConfig.webdavConfig, 'auto')

        // Notify about conflicts if any
        if (result.conflicts.length > 0) {
          ipcManager.send('db:sync-conflicts', result.conflicts)
        }

        // Setup auto-sync interval
        if (syncConfig.webdavConfig.autoSync) {
          if (webdavSyncInterval) clearInterval(webdavSyncInterval)
          const intervalMs = Math.max(
            1,
            syncConfig.webdavConfig.autoSyncInterval || 30
          ) * 60 * 1000
          webdavSyncInterval = setInterval(() => {
            syncViaWebDAV(syncConfig.webdavConfig, 'auto').catch((err) => {
              log.error('[Sync] WebDAV auto sync error:', err)
            })
          }, intervalMs)
        } else {
          if (webdavSyncInterval) {
            clearInterval(webdavSyncInterval)
            webdavSyncInterval = null
          }
        }
      } catch (err) {
        throw err
      }
    }

    ipcManager.send('db:sync-status', {
      status: 'success',
      message: 'Sync success',
      timestamp: new Date().toISOString()
    })

    log.info('[Sync] Sync success')
  } catch (error) {
    log.error('[Sync] Sync error:', error)

    ipcManager.send('db:sync-status', {
      status: 'error',
      message: 'Sync error',
      timestamp: new Date().toISOString()
    })
  }
}

export async function fullSync(): Promise<void> {
  try {
    const syncConfig = await ConfigDBManager.getConfigLocalValue('sync')
    const userInfo = await ConfigDBManager.getConfigLocalValue('userInfo')
    if (!syncConfig.enabled) {
      return
    }

    ipcManager.send('db:full-syncing')

    if (syncConfig.mode === 'official') {
      if (
        !syncConfig.officialConfig.auth.username ||
        !syncConfig.officialConfig.auth.password ||
        !userInfo.name ||
        !userInfo.accessToken ||
        !userInfo.role
      ) {
        log.error('[Sync] Missing official sync username or password')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Missing official sync username or password',
          timestamp: new Date().toISOString()
        })
        ipcManager.send('db:full-sync-error', 'Missing official sync username or password')

        return
      }
      // Check if the database size exceeds the quota for the user's role
      const roleQuotas = ROLE_QUOTAS[userInfo.role]
      const dbSize = await getCouchDBSize(syncConfig.officialConfig.auth.username)
      if (dbSize > roleQuotas.dbSize) {
        log.error('[Sync] Database size exceeds quota')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Database size exceeds quota',
          timestamp: new Date().toISOString()
        })
        ipcManager.send('db:full-sync-error', 'Database size exceeds quota')

        return
      }
      await baseDBManager.syncAllWithRemoteFull(import.meta.env.VITE_COUCHDB_SERVER_URL, {
        auth: {
          username: syncConfig.officialConfig.auth.username,
          password: syncConfig.officialConfig.auth.password
        },
        isOfficial: true
      })
    } else if (syncConfig.mode === 'selfHosted') {
      if (
        !syncConfig.selfHostedConfig.url ||
        !syncConfig.selfHostedConfig.auth.username ||
        !syncConfig.selfHostedConfig.auth.password
      ) {
        log.error('[Sync] Missing self-hosted sync configuration')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Missing self-hosted sync configuration',
          timestamp: new Date().toISOString()
        })
        ipcManager.send('db:full-sync-error', 'Missing self-hosted sync configuration')

        return
      }
      await baseDBManager.syncAllWithRemoteFull(syncConfig.selfHostedConfig.url, {
        auth: {
          username: syncConfig.selfHostedConfig.auth.username,
          password: syncConfig.selfHostedConfig.auth.password
        },
        isOfficial: false
      })
    } else if (syncConfig.mode === 'webdav') {
      if (
        !syncConfig.webdavConfig.url ||
        !syncConfig.webdavConfig.auth.username ||
        !syncConfig.webdavConfig.auth.password
      ) {
        log.error('[Sync] Missing webdav sync configuration')

        ipcManager.send('db:sync-status', {
          status: 'error',
          message: 'Missing webdav sync configuration',
          timestamp: new Date().toISOString()
        })
        ipcManager.send('db:full-sync-error', 'Missing webdav sync configuration')

        return
      }

      const result = await syncViaWebDAV(syncConfig.webdavConfig, 'upload')

      if (result.conflicts.length > 0) {
        ipcManager.send('db:sync-conflicts', result.conflicts)
      }
    }

    ipcManager.send('db:sync-status', {
      status: 'success',
      message: 'Sync success',
      timestamp: new Date().toISOString()
    })
    ipcManager.send('db:full-synced')

    log.info('[Sync] Sync success')
  } catch (error) {
    log.error('[Sync] Sync error:', error)

    ipcManager.send('db:sync-status', {
      status: 'error',
      message: 'Sync error',
      timestamp: new Date().toISOString()
    })
    ipcManager.send('db:full-sync-error', error instanceof Error ? error.message : String(error))
  }
}

export function stopSync(): void {
  baseDBManager.stopAllSync()
  if (webdavSyncInterval) {
    clearInterval(webdavSyncInterval)
    webdavSyncInterval = null
  }
}
