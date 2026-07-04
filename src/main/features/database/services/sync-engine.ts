import path from 'path'
import crypto from 'crypto'
import { RemoteStorageAdapter } from './sync-adapter/types'
import { baseDBManager } from '~/core/database'

// ─── Types ───────────────────────────────────────────────────────────

export interface DocEntry {
  rev: string
  /** SHA256 of the doc JSON content (excluding _rev and _attachments data) */
  hash: string
}

export interface Manifest {
  version: string
  deviceId: string
  lastSync: string
  databases: {
    [dbName: string]: {
      [docId: string]: DocEntry
    }
  }
}

export interface ConflictInfo {
  docId: string
  dbName: string
}

export interface SyncResult {
  uploaded: number
  downloaded: number
  conflicts: ConflictInfo[]
  attachmentsUploaded: number
  attachmentsDownloaded: number
}

// ─── Constants ───────────────────────────────────────────────────────

const SYNCABLE_DATABASES = ['game', 'config', 'game-collection', 'plugin']
const LOCK_FILE = 'lock.json'
const MANIFEST_FILE = 'manifest.json'
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

const BASELINE_DOC_ID = 'webdav-sync-baseline'

// ─── Crypto Helpers ──────────────────────────────────────────────────

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Compute a content hash for a doc, excluding _rev and attachment inline data */
function docContentHash(doc: any): string {
  const stripped: any = { ...doc }
  delete stripped._rev
  if (stripped._attachments) {
    const cleanAtts: any = {}
    for (const [name, att] of Object.entries(stripped._attachments)) {
      const a = att as any
      cleanAtts[name] = {
        content_type: a.content_type,
        digest: a.digest,
        length: a.length,
        revpos: a.revpos
      }
      // keep stub flag if present, drop inline data
      if (a.stub) cleanAtts[name].stub = true
    }
    stripped._attachments = cleanAtts
  }
  return sha256(JSON.stringify(stripped, Object.keys(stripped).sort()))
}

// ─── Device ID ───────────────────────────────────────────────────────

async function getDeviceId(): Promise<string> {
  try {
    let deviceId = await baseDBManager.getValue<string>(
      'config-local',
      'sync',
      'webdavDeviceId',
      ''
    )
    if (!deviceId) {
      deviceId = crypto.randomUUID()
      await baseDBManager.setValue('config-local', 'sync', 'webdavDeviceId', deviceId)
    }
    return deviceId
  } catch {
    const deviceId = crypto.randomUUID()
    await baseDBManager.setValue('config-local', 'sync', 'webdavDeviceId', deviceId)
    return deviceId
  }
}

// ─── Baseline Manifest Persistence ───────────────────────────────────

async function loadBaselineManifest(): Promise<Manifest | null> {
  try {
    const doc = await baseDBManager.getExistingDoc<{ manifest: Manifest }>(
      'config-local',
      BASELINE_DOC_ID
    )
    return doc?.manifest ?? null
  } catch {
    return null
  }
}

async function saveBaselineManifest(manifest: Manifest): Promise<void> {
  await baseDBManager.setValue('config-local', BASELINE_DOC_ID, '#all', { manifest })
}

// ─── Ensure Directory ────────────────────────────────────────────────

async function ensureDirRecursive(
  adapter: RemoteStorageAdapter,
  targetPath: string
): Promise<void> {
  const parts = targetPath.split('/').filter(Boolean)
  let currentPath = targetPath.startsWith('/') ? '/' : ''

  for (const part of parts) {
    currentPath = currentPath === '/' ? `/${part}` : `${currentPath}/${part}`
    if (!(await adapter.exists(currentPath))) {
      try {
        await adapter.mkdir(currentPath)
      } catch {
        // Directory may have been created by a concurrent operation — ignore
      }
    }
  }
}

// ─── Lock ────────────────────────────────────────────────────────────

async function acquireLock(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string
): Promise<void> {
  await ensureDirRecursive(adapter, remotePath)
  const lockPath = path.posix.join(remotePath, LOCK_FILE)

  if (await adapter.exists(lockPath)) {
    const content = await adapter.readFile(lockPath, 'text')
    try {
      const lockData = JSON.parse(content as string)
      // If the lock belongs to another device and hasn't expired, reject
      if (
        lockData.deviceId !== deviceId &&
        Date.now() - lockData.timestamp < LOCK_TIMEOUT_MS
      ) {
        throw new Error('Sync is locked by another device.')
      }
      // Otherwise (same device or expired lock), we can proceed
    } catch (err: any) {
      if (err.message === 'Sync is locked by another device.') throw err
      // Corrupt lock file — overwrite it
    }
  }

  await adapter.writeFile(
    lockPath,
    JSON.stringify({ deviceId, timestamp: Date.now() })
  )
}

async function releaseLock(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string
): Promise<void> {
  const lockPath = path.posix.join(remotePath, LOCK_FILE)
  if (!(await adapter.exists(lockPath))) return

  try {
    const content = await adapter.readFile(lockPath, 'text')
    const lockData = JSON.parse(content as string)
    // Only release if we still hold the lock (or it's expired)
    if (lockData.deviceId === deviceId || Date.now() - lockData.timestamp >= LOCK_TIMEOUT_MS) {
      await adapter.deleteFile(lockPath)
    }
  } catch {
    // If we can't read/parse the lock, it's likely corrupt — try to delete anyway
    try {
      await adapter.deleteFile(lockPath)
    } catch {
      // Best effort
    }
  }
}

// ─── Build Local Manifest ────────────────────────────────────────────

async function buildLocalManifest(deviceId: string): Promise<Manifest> {
  const manifest: Manifest = {
    version: '2.0',
    deviceId,
    lastSync: new Date().toISOString(),
    databases: {}
  }

  for (const dbName of SYNCABLE_DATABASES) {
    manifest.databases[dbName] = {}
    const db = baseDBManager.getRawDatabase(dbName)
    const allDocs = await db.allDocs({ include_docs: true, attachments: true, binary: true })

    for (const row of allDocs.rows) {
      if (!row.doc || row.doc._id.startsWith('_design/')) continue
      manifest.databases[dbName][row.doc._id] = {
        rev: row.doc._rev,
        hash: docContentHash(row.doc)
      }
    }
  }

  return manifest
}

// ─── Upload Local Snapshot ───────────────────────────────────────────

export async function uploadSnapshot(
  adapter: RemoteStorageAdapter,
  remotePath: string
): Promise<SyncResult> {
  const deviceId = await getDeviceId()
  await acquireLock(adapter, remotePath, deviceId)

  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0
  }

  try {
    // 1. Build current local manifest
    const localManifest = await buildLocalManifest(deviceId)

    // 2. Load baseline (last synced state)
    const baseline = await loadBaselineManifest()

    // 3. Load remote manifest (if exists)
    const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
    let remoteManifest: Manifest | null = null
    if (await adapter.exists(manifestPath)) {
      const content = await adapter.readFile(manifestPath, 'text')
      remoteManifest = JSON.parse(content as string)
    }

    // 4. Collect set of all doc IDs across local + baseline + remote
    const allDbNames = new Set(SYNCABLE_DATABASES)
    for (const dbName of SYNCABLE_DATABASES) {
      const baselineDB = baseline?.databases?.[dbName] ?? {}
      const remoteDB = remoteManifest?.databases?.[dbName] ?? {}
      Object.keys(baselineDB).forEach((id) => allDbNames.add(id))
      Object.keys(remoteDB).forEach((id) => allDbNames.add(id))
    }

    // 5. For each database, determine what to upload
    for (const dbName of SYNCABLE_DATABASES) {
      const localDB = localManifest.databases[dbName] ?? {}
      const baselineDB = baseline?.databases?.[dbName] ?? {}
      const remoteDB = remoteManifest?.databases?.[dbName] ?? {}

      const db = baseDBManager.getRawDatabase(dbName)
      const allDocIds = new Set([
        ...Object.keys(localDB),
        ...Object.keys(baselineDB),
        ...Object.keys(remoteDB)
      ])

      for (const docId of allDocIds) {
        const localEntry = localDB[docId]
        const baselineEntry = baselineDB[docId]
        const remoteEntry = remoteDB[docId]

        // ── Doc deleted locally ──
        if (!localEntry) {
          // If it existed in baseline, mark as deletion (remove from remote)
          // We handle this by not including it in the new manifest
          continue
        }

        const locallyChanged = !baselineEntry || localEntry.hash !== baselineEntry.hash
        const remotelyChanged =
          remoteEntry && baselineEntry && remoteEntry.hash !== baselineEntry.hash

        if (!locallyChanged) {
          // No local change — keep whatever is on remote (or nothing)
          continue
        }

        if (remotelyChanged) {
          // Both sides changed → CONFLICT
          result.conflicts.push({ docId, dbName })

          // Write conflict marker on remote
          const conflictFileName = `${encodeURIComponent(docId)}.conflict.${deviceId}.${Date.now()}.json`
          const conflictPath = path.posix.join(remotePath, 'conflicts', conflictFileName)
          await ensureDirRecursive(adapter, path.posix.join(remotePath, 'conflicts'))

          // Get full doc with attachment data for conflict copy
          const fullDoc = await db.get(docId, { attachments: true, binary: true })
          const docClone = JSON.parse(JSON.stringify(fullDoc))
          // Strip inline attachment data for the conflict file (keep references)
          if (docClone._attachments) {
            for (const att of Object.values(docClone._attachments)) {
              const a = att as any
              if (a.data) {
                delete a.data
                a.stub = true
              }
            }
          }
          await adapter.writeFile(conflictPath, JSON.stringify(docClone, null, 2))
          continue
        }

        // Locally changed, remote unchanged → upload
        const fullDoc = await db.get(docId, { attachments: true, binary: true })
        // Deep clone to avoid mutating PouchDB internals
        const docClone = JSON.parse(JSON.stringify(fullDoc))

        // Process attachments using content-addressed storage
        if (docClone._attachments) {
          for (const [attName, att] of Object.entries(docClone._attachments)) {
            const anyAtt = att as any
            if (!anyAtt.data) continue // Skip stubs

            const attBuffer = Buffer.from(anyAtt.data, 'base64')
            const attHash = sha256(attBuffer)
            const attFileName = `${attHash}.bin`
            const attDir = path.posix.join(remotePath, 'attachments')
            const attPath = path.posix.join(attDir, attFileName)

            // Content-addressed: only upload if not already present
            if (!(await adapter.exists(attPath))) {
              await ensureDirRecursive(adapter, attDir)
              await adapter.writeFile(attPath, attBuffer, {
                contentType: anyAtt.content_type || 'application/octet-stream'
              })
              result.attachmentsUploaded++
            }

            // Replace inline data with stub reference
            delete anyAtt.data
            anyAtt.stub = true
            // Preserve digest for later reconstruction
            anyAtt._sha256 = attHash
          }
        }

        // Upload doc JSON
        const docDir = path.posix.join(remotePath, 'docs', dbName)
        const docPath = path.posix.join(docDir, `${encodeURIComponent(docId)}.json`)
        await ensureDirRecursive(adapter, docDir)
        await adapter.writeFile(docPath, JSON.stringify(docClone), {
          contentType: 'application/json'
        })
        result.uploaded++

        // Update remote manifest entry
        if (!remoteManifest) {
          remoteManifest = { version: '2.0', deviceId, lastSync: '', databases: {} }
        }
        if (!remoteManifest.databases[dbName]) {
          remoteManifest.databases[dbName] = {}
        }
        remoteManifest.databases[dbName][docId] = {
          rev: localEntry.rev,
          hash: localEntry.hash
        }
      }
    }

    // 6. Write updated manifest and save as new baseline
    if (remoteManifest) {
      remoteManifest.lastSync = new Date().toISOString()
      remoteManifest.deviceId = deviceId
      await adapter.writeFile(manifestPath, JSON.stringify(remoteManifest), {
        contentType: 'application/json'
      })
    }

    // Merge remote changes into local manifest for the baseline
    const mergedManifest = remoteManifest
      ? { ...remoteManifest, deviceId, lastSync: new Date().toISOString() }
      : localManifest
    await saveBaselineManifest(mergedManifest)

    return result
  } finally {
    await releaseLock(adapter, remotePath, deviceId)
  }
}

// ─── Download Remote Snapshot ────────────────────────────────────────

export async function downloadSnapshot(
  adapter: RemoteStorageAdapter,
  remotePath: string
): Promise<SyncResult> {
  const deviceId = await getDeviceId()
  await acquireLock(adapter, remotePath, deviceId)

  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0
  }

  try {
    const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
    if (!(await adapter.exists(manifestPath))) {
      // No remote data — nothing to download
      return result
    }

    const manifestContent = await adapter.readFile(manifestPath, 'text')
    const remoteManifest: Manifest = JSON.parse(manifestContent as string)

    // Load baseline for three-way merge
    const baseline = await loadBaselineManifest()

    for (const dbName of SYNCABLE_DATABASES) {
      const remoteDB = remoteManifest.databases?.[dbName]
      if (!remoteDB) continue

      const baselineDB = baseline?.databases?.[dbName] ?? {}
      const db = baseDBManager.getRawDatabase(dbName)

      // Build local rev map
      const localDocs = await db.allDocs({ include_docs: false })
      const localRevs = new Map(localDocs.rows.map((r) => [r.id, r.value.rev]))

      const docsToSave: any[] = []

      for (const [docId, remoteEntry] of Object.entries(remoteDB)) {
        const localRev = localRevs.get(docId)
        const baselineEntry = baselineDB[docId]

        // ── Three-way merge ──
        if (!localRev) {
          // Doc doesn't exist locally → download (new from remote)
          // (unless it was locally deleted after baseline — that's a conflict scenario simplified here)
        } else if (baselineEntry) {
          const localDoc = await db.get(docId).catch(() => null)
          const localHash = localDoc ? docContentHash(localDoc) : ''

          const locallyChanged = localHash !== baselineEntry.hash
          const remotelyChanged = remoteEntry.hash !== baselineEntry.hash

          if (locallyChanged && remotelyChanged) {
            // CONFLICT — both sides changed
            result.conflicts.push({ docId, dbName })

            // Download remote version as conflict copy
            const docPath = path.posix.join(
              remotePath,
              'docs',
              dbName,
              `${encodeURIComponent(docId)}.json`
            )
            if (await adapter.exists(docPath)) {
              const docContent = await adapter.readFile(docPath, 'text')
              const remoteDoc = JSON.parse(docContent as string)
              const conflictDoc = {
                ...remoteDoc,
                _id: `${docId}.conflict.remote.${Date.now()}`
              }
              delete conflictDoc._rev
              docsToSave.push(conflictDoc)
              result.downloaded++
            }
            continue
          }

          if (!locallyChanged && !remotelyChanged) {
            // Both unchanged — nothing to do
            continue
          }

          if (!locallyChanged && remotelyChanged) {
            // Remote changed, local unchanged → safe to download
          }
        }
        // else: no baseline entry (first sync), and doc exists locally with different rev
        // For safety during cold start, skip — don't overwrite local data silently

        // ── Actually download the doc ──
        const docPath = path.posix.join(
          remotePath,
          'docs',
          dbName,
          `${encodeURIComponent(docId)}.json`
        )
        if (!(await adapter.exists(docPath))) continue

        const docContent = await adapter.readFile(docPath, 'text')
        const doc = JSON.parse(docContent as string)

        // Restore attachment data from content-addressed blobs
        if (doc._attachments) {
          for (const [attName, att] of Object.entries(doc._attachments)) {
            const anyAtt = att as any
            if (!anyAtt.stub) continue

            const attHash = anyAtt._sha256 || anyAtt.digest?.replace(/[^a-f0-9]/g, '')
            let attBuffer: Buffer | null = null

            // Try SHA256-based lookup first
            if (anyAtt._sha256) {
              const attPath = path.posix.join(remotePath, 'attachments', `${anyAtt._sha256}.bin`)
              if (await adapter.exists(attPath)) {
                attBuffer = (await adapter.readFile(attPath, 'binary')) as Buffer
              }
            }

            // Fallback: try digest-based lookup
            if (!attBuffer && attHash) {
              const attPath = path.posix.join(remotePath, 'attachments', `${attHash}.bin`)
              if (await adapter.exists(attPath)) {
                attBuffer = (await adapter.readFile(attPath, 'binary')) as Buffer
              }
            }

            if (attBuffer) {
              anyAtt.data = attBuffer.toString('base64')
              delete anyAtt.stub
              delete anyAtt._sha256
              result.attachmentsDownloaded++
            }
            // If attachment blob not found, leave as stub — will be missing locally
          }
        }

        // Prepare for save: use existing _rev if doc exists, otherwise remove _rev
        if (localRev) {
          doc._rev = localRev
        } else {
          delete doc._rev
        }

        docsToSave.push(doc)
        result.downloaded++
      }

      // Batch save to PouchDB (default new_edits: true)
      if (docsToSave.length > 0) {
        await db.bulkDocs(docsToSave)
      }
    }

    // Save remote manifest as new baseline
    const newBaseline: Manifest = {
      ...remoteManifest,
      deviceId,
      lastSync: new Date().toISOString()
    }
    await saveBaselineManifest(newBaseline)

    return result
  } finally {
    await releaseLock(adapter, remotePath, deviceId)
  }
}

// ─── Bidirectional Sync (auto mode) ──────────────────────────────────

export async function syncBidirectional(
  adapter: RemoteStorageAdapter,
  remotePath: string
): Promise<SyncResult> {
  const deviceId = await getDeviceId()
  await acquireLock(adapter, remotePath, deviceId)

  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0
  }

  try {
    // First, download changes from remote
    const dlResult = await downloadSnapshotInternal(
      adapter,
      remotePath,
      deviceId
    )
    result.downloaded = dlResult.downloaded
    result.attachmentsDownloaded = dlResult.attachmentsDownloaded
    result.conflicts.push(...dlResult.conflicts)

    // Then, upload local changes
    const ulResult = await uploadSnapshotInternal(
      adapter,
      remotePath,
      deviceId
    )
    result.uploaded = ulResult.uploaded
    result.attachmentsUploaded = ulResult.attachmentsUploaded
    // Merge conflicts (avoid duplicates)
    for (const c of ulResult.conflicts) {
      if (!result.conflicts.some((e) => e.docId === c.docId && e.dbName === c.dbName)) {
        result.conflicts.push(c)
      }
    }

    return result
  } finally {
    await releaseLock(adapter, remotePath, deviceId)
  }
}

// ─── Internal helpers (no lock management — called by bidirectional) ──

async function downloadSnapshotInternal(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string
): Promise<SyncResult> {
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0
  }

  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  if (!(await adapter.exists(manifestPath))) return result

  const manifestContent = await adapter.readFile(manifestPath, 'text')
  const remoteManifest: Manifest = JSON.parse(manifestContent as string)
  const baseline = await loadBaselineManifest()

  for (const dbName of SYNCABLE_DATABASES) {
    const remoteDB = remoteManifest.databases?.[dbName]
    if (!remoteDB) continue

    const baselineDB = baseline?.databases?.[dbName] ?? {}
    const db = baseDBManager.getRawDatabase(dbName)
    const localDocs = await db.allDocs({ include_docs: false })
    const localRevs = new Map(localDocs.rows.map((r) => [r.id, r.value.rev]))

    const docsToSave: any[] = []

    for (const [docId, remoteEntry] of Object.entries(remoteDB)) {
      const localRev = localRevs.get(docId)
      const baselineEntry = baselineDB[docId]

      // Skip if already in sync
      if (!localRev && !baselineEntry) {
        // New doc from remote — download
      } else if (localRev && baselineEntry) {
        const localDoc = await db.get(docId).catch(() => null)
        const localHash = localDoc ? docContentHash(localDoc) : ''
        const locallyChanged = localHash !== baselineEntry.hash
        const remotelyChanged = remoteEntry.hash !== baselineEntry.hash

        if (locallyChanged && remotelyChanged) {
          result.conflicts.push({ docId, dbName })
          continue
        }
        if (!remotelyChanged) continue // Nothing new from remote
        if (locallyChanged && !remotelyChanged) continue // Keep local changes
      } else if (localRev && !baselineEntry) {
        // Doc exists locally but no baseline — first sync, skip to avoid data loss
        continue
      }

      // Download doc
      const docPath = path.posix.join(
        remotePath, 'docs', dbName,
        `${encodeURIComponent(docId)}.json`
      )
      if (!(await adapter.exists(docPath))) continue

      const docContent = await adapter.readFile(docPath, 'text')
      const doc = JSON.parse(docContent as string)

      // Restore attachments
      if (doc._attachments) {
        for (const att of Object.values(doc._attachments)) {
          const anyAtt = att as any
          if (!anyAtt.stub) continue
          if (anyAtt._sha256) {
            const attPath = path.posix.join(
              remotePath, 'attachments', `${anyAtt._sha256}.bin`
            )
            if (await adapter.exists(attPath)) {
              const attBuffer = (await adapter.readFile(attPath, 'binary')) as Buffer
              anyAtt.data = attBuffer.toString('base64')
              delete anyAtt.stub
              delete anyAtt._sha256
              result.attachmentsDownloaded++
            }
          }
        }
      }

      if (localRev) {
        doc._rev = localRev
      } else {
        delete doc._rev
      }

      docsToSave.push(doc)
      result.downloaded++
    }

    if (docsToSave.length > 0) {
      await db.bulkDocs(docsToSave)
    }
  }

  // Update baseline
  const newBaseline: Manifest = {
    ...remoteManifest,
    deviceId,
    lastSync: new Date().toISOString()
  }
  await saveBaselineManifest(newBaseline)

  return result
}

async function uploadSnapshotInternal(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string
): Promise<SyncResult> {
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0
  }

  const localManifest = await buildLocalManifest(deviceId)
  const baseline = await loadBaselineManifest()

  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  let remoteManifest: Manifest | null = null
  if (await adapter.exists(manifestPath)) {
    const content = await adapter.readFile(manifestPath, 'text')
    remoteManifest = JSON.parse(content as string)
  }

  for (const dbName of SYNCABLE_DATABASES) {
    const localDB = localManifest.databases[dbName] ?? {}
    const baselineDB = baseline?.databases?.[dbName] ?? {}
    const remoteDB = remoteManifest?.databases?.[dbName] ?? {}

    const db = baseDBManager.getRawDatabase(dbName)

    for (const [docId, localEntry] of Object.entries(localDB)) {
      const baselineEntry = baselineDB[docId]
      const remoteEntry = remoteDB[docId]

      const locallyChanged = !baselineEntry || localEntry.hash !== baselineEntry.hash
      if (!locallyChanged) continue

      const remotelyChanged =
        remoteEntry && baselineEntry && remoteEntry.hash !== baselineEntry.hash

      if (remotelyChanged) {
        result.conflicts.push({ docId, dbName })
        continue
      }

      // Upload doc
      const fullDoc = await db.get(docId, { attachments: true, binary: true })
      const docClone = JSON.parse(JSON.stringify(fullDoc))

      if (docClone._attachments) {
        for (const att of Object.values(docClone._attachments)) {
          const anyAtt = att as any
          if (!anyAtt.data) continue

          const attBuffer = Buffer.from(anyAtt.data, 'base64')
          const attHash = sha256(attBuffer)
          const attFileName = `${attHash}.bin`
          const attDir = path.posix.join(remotePath, 'attachments')
          const attPath = path.posix.join(attDir, attFileName)

          if (!(await adapter.exists(attPath))) {
            await ensureDirRecursive(adapter, attDir)
            await adapter.writeFile(attPath, attBuffer, {
              contentType: anyAtt.content_type || 'application/octet-stream'
            })
            result.attachmentsUploaded++
          }

          delete anyAtt.data
          anyAtt.stub = true
          anyAtt._sha256 = attHash
        }
      }

      const docDir = path.posix.join(remotePath, 'docs', dbName)
      const docPath = path.posix.join(docDir, `${encodeURIComponent(docId)}.json`)
      await ensureDirRecursive(adapter, docDir)
      await adapter.writeFile(docPath, JSON.stringify(docClone), {
        contentType: 'application/json'
      })
      result.uploaded++

      if (!remoteManifest) {
        remoteManifest = { version: '2.0', deviceId, lastSync: '', databases: {} }
      }
      if (!remoteManifest.databases[dbName]) {
        remoteManifest.databases[dbName] = {}
      }
      remoteManifest.databases[dbName][docId] = {
        rev: localEntry.rev,
        hash: localEntry.hash
      }
    }
  }

  if (remoteManifest) {
    remoteManifest.lastSync = new Date().toISOString()
    remoteManifest.deviceId = deviceId
    await adapter.writeFile(manifestPath, JSON.stringify(remoteManifest), {
      contentType: 'application/json'
    })
  }

  const mergedManifest = remoteManifest
    ? { ...remoteManifest, deviceId, lastSync: new Date().toISOString() }
    : localManifest
  await saveBaselineManifest(mergedManifest)

  return result
}
