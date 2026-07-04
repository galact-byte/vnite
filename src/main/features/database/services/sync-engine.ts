import path from 'path'
import { RemoteStorageAdapter } from './sync-adapter/types'
import { baseDBManager } from '~/core/database'

export interface Manifest {
  version: string
  lastSync: string
  databases: {
    [dbName: string]: {
      [docId: string]: {
        rev: string
      }
    }
  }
}

const SYNCABLE_DATABASES = ['game', 'config', 'game-collection', 'plugin']
const LOCK_FILE = 'lock.json'
const MANIFEST_FILE = 'manifest.json'
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

async function ensureDirRecursive(adapter: RemoteStorageAdapter, targetPath: string): Promise<void> {
  const parts = targetPath.split('/').filter(Boolean)
  let currentPath = targetPath.startsWith('/') ? '/' : ''
  
  for (const part of parts) {
    currentPath = currentPath === '/' ? `/${part}` : `${currentPath}/${part}`
    if (!(await adapter.exists(currentPath))) {
      try {
        await adapter.mkdir(currentPath)
      } catch (err) {
        // Ignore if exists
      }
    }
  }
}

async function acquireLock(adapter: RemoteStorageAdapter, remotePath: string): Promise<void> {
  await ensureDirRecursive(adapter, remotePath)
  const lockPath = path.posix.join(remotePath, LOCK_FILE)
  if (await adapter.exists(lockPath)) {
    const content = await adapter.readFile(lockPath, 'text')
    try {
      const lockData = JSON.parse(content as string)
      if (Date.now() - lockData.timestamp < LOCK_TIMEOUT_MS) {
        throw new Error('Sync is locked by another process.')
      }
    } catch (err: any) {
      if (err.message === 'Sync is locked by another process.') {
        throw err
      }
    }
  }
  await adapter.writeFile(lockPath, JSON.stringify({ timestamp: Date.now() }))
}

async function releaseLock(adapter: RemoteStorageAdapter, remotePath: string): Promise<void> {
  const lockPath = path.posix.join(remotePath, LOCK_FILE)
  if (await adapter.exists(lockPath)) {
    await adapter.deleteFile(lockPath)
  }
}

export async function uploadIncrementalSnapshot(adapter: RemoteStorageAdapter, remotePath: string): Promise<void> {
  await acquireLock(adapter, remotePath)
  try {
    const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
    let manifest: Manifest = { version: '1.0', lastSync: new Date().toISOString(), databases: {} }
    
    if (await adapter.exists(manifestPath)) {
      const content = await adapter.readFile(manifestPath, 'text')
      manifest = JSON.parse(content as string)
    }

    for (const dbName of SYNCABLE_DATABASES) {
      if (!manifest.databases[dbName]) {
        manifest.databases[dbName] = {}
      }

      const db = baseDBManager.getRawDatabase(dbName)
      const allDocs = await db.allDocs({ include_docs: true, attachments: true, binary: false })

      for (const row of allDocs.rows) {
        if (!row.doc) continue
        if (row.doc._id.startsWith('_design/')) continue

        const docId = row.doc._id
        const docRev = row.doc._rev
        const remoteDocInfo = manifest.databases[dbName][docId]

        if (!remoteDocInfo || remoteDocInfo.rev !== docRev) {
          // Process attachments
          if (row.doc._attachments) {
            for (const [_attName, att] of Object.entries(row.doc._attachments)) {
              const anyAtt = att as any
              const digest = anyAtt.digest || anyAtt.revpos
              const attFileName = typeof digest === 'string' 
                ? `${digest.replace(/[^a-zA-Z0-9-]/g, '_')}.bin` 
                : `${Date.now()}-${Math.random().toString(36).substring(2)}.bin`
              const attRemoteDir = path.posix.join(remotePath, 'attachments')
              const attRemotePath = path.posix.join(attRemoteDir, attFileName)
              
              if (!(await adapter.exists(attRemotePath))) {
                const buffer = Buffer.from(anyAtt.data, 'base64')
                await ensureDirRecursive(adapter, attRemoteDir)
                await adapter.writeFile(attRemotePath, buffer)
              }
              delete anyAtt.data
              anyAtt.stub = true
            }
          }

          // Upload doc json
          const docRemoteDir = path.posix.join(remotePath, 'docs', dbName)
          const docRemotePath = path.posix.join(docRemoteDir, `${encodeURIComponent(docId)}.json`)
          await ensureDirRecursive(adapter, docRemoteDir)
          await adapter.writeFile(docRemotePath, JSON.stringify(row.doc))

          manifest.databases[dbName][docId] = { rev: docRev }
        }
      }
    }
    
    manifest.lastSync = new Date().toISOString()
    await adapter.writeFile(manifestPath, JSON.stringify(manifest))
  } finally {
    await releaseLock(adapter, remotePath)
  }
}

export async function downloadIncrementalSnapshot(adapter: RemoteStorageAdapter, remotePath: string): Promise<void> {
  await acquireLock(adapter, remotePath)
  try {
    const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
    if (!(await adapter.exists(manifestPath))) {
      return
    }
    
    const manifestContent = await adapter.readFile(manifestPath, 'text')
    const manifest: Manifest = JSON.parse(manifestContent as string)

    for (const dbName of SYNCABLE_DATABASES) {
      if (!manifest.databases[dbName]) continue

      const db = baseDBManager.getRawDatabase(dbName)
      const localDocs = await db.allDocs({ include_docs: false })
      const localRevs = new Map(localDocs.rows.map(r => [r.id, r.value.rev]))

      const docsToSave: any[] = []

      for (const [docId, info] of Object.entries(manifest.databases[dbName])) {
        const localRev = localRevs.get(docId)
        if (localRev !== info.rev) {
          const docRemotePath = path.posix.join(remotePath, 'docs', dbName, `${encodeURIComponent(docId)}.json`)
          if (await adapter.exists(docRemotePath)) {
            const docContent = await adapter.readFile(docRemotePath, 'text')
            const doc = JSON.parse(docContent as string)

            if (doc._attachments) {
              for (const [_attName, att] of Object.entries(doc._attachments)) {
                const anyAtt = att as any
                if (anyAtt.stub) {
                  const digest = anyAtt.digest || anyAtt.revpos
                  const attFileName = typeof digest === 'string' 
                    ? `${digest.replace(/[^a-zA-Z0-9-]/g, '_')}.bin` 
                    : null
                    
                  if (attFileName) {
                    const attRemotePath = path.posix.join(remotePath, 'attachments', attFileName)
                    if (await adapter.exists(attRemotePath)) {
                      const attBuffer = await adapter.readFile(attRemotePath, 'binary')
                      anyAtt.data = (attBuffer as Buffer).toString('base64')
                      delete anyAtt.stub
                    }
                  }
                }
              }
            }
            docsToSave.push(doc)
          }
        }
      }

      if (docsToSave.length > 0) {
        await db.bulkDocs(docsToSave, { new_edits: false })
      }
    }
  } finally {
    await releaseLock(adapter, remotePath)
  }
}
