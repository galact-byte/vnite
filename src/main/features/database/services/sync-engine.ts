import path from 'path'
import crypto from 'crypto'
import log from 'electron-log/main'
import { RemoteStorageAdapter } from './sync-adapter/types'
import { baseDBManager } from '~/core/database'
import type { PendingSaveDeletionDisplaySave } from '@appTypes/models'

// ─── Types ───────────────────────────────────────────────────────────

export interface DocEntry {
  rev: string
  /** SHA256 of the doc JSON content (excluding _rev and _attachments data) */
  hash: string
  /** Tombstone: the doc was deleted on some device and the deletion is synced */
  deleted?: true
  /** ISO timestamp of the deletion; drives tombstone GC (see TOMBSTONE_RETENTION_MS) */
  deletedAt?: string
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

/**
 * A game doc whose upload was held back because it would propagate an
 * abnormal save deletion (≥2 saves removed, or the entire save history
 * cleared) to the remote. The doc stays local-only until the user approves
 * the deletion (approveSaveDeletion + re-sync) or restores the saves.
 */
export interface PendingSaveDeletion {
  /** Stable opaque handle used by renderer IPC; main resolves it from config-local. */
  id: string
  gameId: string
  /** Number of saves that would be deleted on the remote */
  removedCount: number
  /** Save count currently on the remote (before the deletion) */
  remoteSaveCount: number
  /** True when the local doc has no saves left at all */
  clearsHistory: boolean
  /** Remote manifest hash bound to this destructive operation. */
  remoteHash?: string
  /** Local document hash bound to this destructive operation. */
  localHash?: string
  /** Exact remote save IDs bound to this destructive operation. */
  removedSaveIds?: string[]
  /** The destructive path that is waiting for this approval. */
  source?: 'upload' | 'conflict'
  /** Trusted remote snapshot for renderer display only; never authorizes deletion. */
  displaySaves?: PendingSaveDeletionDisplaySave[]
  /** The remote game doc could not be read, so deletion comparison is unsafe. */
  comparisonFailed?: boolean
  /** Diagnostic detail for a failed comparison; never treated as a cancellation. */
  error?: string
}

export interface SyncResult {
  uploaded: number
  downloaded: number
  conflicts: ConflictInfo[]
  errors: string[]
  attachmentsUploaded: number
  attachmentsDownloaded: number
  /** Orphan attachment blobs deleted from the remote by the post-sync GC */
  attachmentsPurged: number
  /** Doc deletions propagated to the remote (tombstones written) this pass */
  deletionsPropagated: number
  pendingSaveDeletions: PendingSaveDeletion[]
  /** Conflicts that converged without an explicit user resolution this pass. */
  resolvedConflictCopies: ConflictInfo[]
}

export interface SyncProgress {
  phase: 'download' | 'upload'
  database: string
  current: number
  total: number
}

export type SyncProgressCallback = (progress: SyncProgress) => void

// ─── Constants ───────────────────────────────────────────────────────

const SYNCABLE_DATABASES = ['game', 'config', 'game-collection', 'plugin']
const LOCK_FILE = 'lock.json'
const MANIFEST_FILE = 'manifest.json'
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

const BASELINE_DOC_ID = 'webdav-sync-baseline'
const SAVE_DELETION_APPROVALS_DOC_ID = 'webdav-save-deletion-approvals'

interface SaveDeletionApproval {
  gameId: string
  remoteHash: string
  localHash: string
  removedSaveIds: string[]
  source: 'upload' | 'conflict'
}

// Save-deletion guard thresholds: removing more saves than this in one sync
// round (or clearing a game's entire history) is considered abnormal and
// requires explicit user approval before the deletion reaches the remote.
const MAX_SILENT_SAVE_REMOVALS = 1
/** A content binding for a local game document that no longer exists. */
const DELETED_GAME_DOC_HASH = 'deleted-game-document'

// Tombstones older than this are garbage-collected from manifest + baseline
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ─── In-process Mutex ────────────────────────────────────────────────

let syncInFlight = false

async function withSyncMutex<T>(fn: () => Promise<T>): Promise<T> {
  if (syncInFlight) {
    throw new Error('Sync already in progress')
  }
  syncInFlight = true
  try {
    return await fn()
  } finally {
    syncInFlight = false
  }
}

// ─── Crypto Helpers ──────────────────────────────────────────────────

function sha256(data: Buffer | string): string {
  return crypto
    .createHash('sha256')
    .update(data as any)
    .digest('hex')
}

/**
 * Deterministic recursive serialization: object keys are sorted at every
 * nesting level, so any nested change alters the output. Keys whose value is
 * `undefined` are omitted (matching JSON.stringify object semantics).
 */
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

/** Compute a content hash for a doc, excluding _rev and attachment inline data */
function docContentHash(doc: any): string {
  const stripped: any = { ...doc }
  delete stripped._rev
  if (stripped._attachments) {
    const cleanAtts: any = {}
    for (const [name, att] of Object.entries(stripped._attachments)) {
      const a = att as any
      // Only content-derived metadata: digest/length/content_type are stable
      // across devices, while revpos/stub depend on local write history and
      // would make identical content hash differently on different devices.
      cleanAtts[name] = {
        content_type: a.content_type,
        digest: a.digest,
        length: a.length
      }
    }
    stripped._attachments = cleanAtts
  }
  return sha256(stableStringify(stripped))
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

// ─── Save-deletion Approvals ────────────────────────────────────────

async function loadSaveDeletionApprovals(): Promise<SaveDeletionApproval[]> {
  const approvals = await baseDBManager.getValue<unknown>(
    'config-local',
    SAVE_DELETION_APPROVALS_DOC_ID,
    'approvals',
    []
  )
  if (!Array.isArray(approvals)) return []

  // The earlier gameId-only format cannot safely authorize a destructive
  // operation, so deliberately ignore it during migration rather than
  // granting a stale approval to changed content.
  return approvals.filter(
    (approval): approval is SaveDeletionApproval =>
      typeof approval === 'object' &&
      approval !== null &&
      typeof (approval as SaveDeletionApproval).gameId === 'string' &&
      typeof (approval as SaveDeletionApproval).remoteHash === 'string' &&
      typeof (approval as SaveDeletionApproval).localHash === 'string' &&
      Array.isArray((approval as SaveDeletionApproval).removedSaveIds) &&
      ((approval as SaveDeletionApproval).source === 'upload' ||
        (approval as SaveDeletionApproval).source === 'conflict')
  )
}

async function storeSaveDeletionApprovals(approvals: SaveDeletionApproval[]): Promise<void> {
  await baseDBManager.setValue('config-local', SAVE_DELETION_APPROVALS_DOC_ID, '#all', {
    approvals,
    updatedAt: new Date().toISOString()
  })
}

function sameSaveIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((saveId, index) => saveId === b[index])
}

function matchingSaveDeletionApproval(
  approvals: SaveDeletionApproval[],
  pending: PendingSaveDeletion
): number {
  if (
    pending.comparisonFailed ||
    !pending.remoteHash ||
    !pending.localHash ||
    !pending.removedSaveIds ||
    !pending.source
  ) {
    return -1
  }
  return approvals.findIndex(
    (approval) =>
      approval.gameId === pending.gameId &&
      approval.remoteHash === pending.remoteHash &&
      approval.localHash === pending.localHash &&
      approval.source === pending.source &&
      sameSaveIds(approval.removedSaveIds, pending.removedSaveIds!)
  )
}

/**
 * Record a one-shot approval for one exact deletion operation. The user sees
 * hashes and exact IDs indirectly through this pending record; re-reading the
 * docs before upload makes the approval invalid if either side changed.
 */
export async function approveSaveDeletion(pending: PendingSaveDeletion): Promise<void> {
  if (
    !pending.id ||
    pending.comparisonFailed ||
    !pending.remoteHash ||
    !pending.localHash ||
    !pending.removedSaveIds ||
    !pending.source
  ) {
    throw new Error('Cannot approve save deletion until the remote saves can be compared')
  }
  const approvals = await loadSaveDeletionApprovals()
  const next = approvals.filter(
    (approval) =>
      !(
        approval.gameId === pending.gameId &&
        approval.remoteHash === pending.remoteHash &&
        approval.localHash === pending.localHash &&
        approval.source === pending.source &&
        sameSaveIds(approval.removedSaveIds, pending.removedSaveIds!)
      )
  )
  next.push({
    gameId: pending.gameId,
    remoteHash: pending.remoteHash,
    localHash: pending.localHash,
    removedSaveIds: pending.removedSaveIds,
    source: pending.source
  })
  await storeSaveDeletionApprovals(next)
}

/** A user cancellation revokes only this exact not-yet-consumed operation. */
export async function revokeSaveDeletionApproval(pending: PendingSaveDeletion): Promise<void> {
  if (!pending.remoteHash || !pending.localHash || !pending.removedSaveIds || !pending.source)
    return
  const approvals = await loadSaveDeletionApprovals()
  const remaining = approvals.filter(
    (approval) =>
      !(
        approval.gameId === pending.gameId &&
        approval.remoteHash === pending.remoteHash &&
        approval.localHash === pending.localHash &&
        approval.source === pending.source &&
        sameSaveIds(approval.removedSaveIds, pending.removedSaveIds!)
      )
  )
  if (remaining.length !== approvals.length) await storeSaveDeletionApprovals(remaining)
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
      if (lockData.deviceId !== deviceId && Date.now() - lockData.timestamp < LOCK_TIMEOUT_MS) {
        throw new Error('Sync is locked by another device.')
      }
      // Otherwise (same device or expired lock), we can proceed
    } catch (err: any) {
      if (err.message === 'Sync is locked by another device.') throw err
      // Corrupt lock file — overwrite it
    }
  }

  await adapter.writeFile(lockPath, JSON.stringify({ deviceId, timestamp: Date.now() }))
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

// ─── Manifest / Entry Helpers ────────────────────────────────────────

function isLiveEntry(entry: DocEntry | undefined): entry is DocEntry {
  return !!entry && !entry.deleted
}

function isTombstone(entry: DocEntry | undefined): boolean {
  return !!entry && entry.deleted === true
}

function entriesEqual(a: DocEntry | undefined, b: DocEntry | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (!!a.deleted !== !!b.deleted) return false
  if (a.deleted && b.deleted) return true
  return a.hash === b.hash
}

function cloneManifestDatabases(manifest: Manifest | null): Manifest['databases'] {
  const databases: Manifest['databases'] = {}
  for (const dbName of SYNCABLE_DATABASES) {
    databases[dbName] = {}
    const source = manifest?.databases?.[dbName]
    if (source) {
      for (const [docId, entry] of Object.entries(source)) {
        databases[dbName][docId] = { ...entry }
      }
    }
  }
  return databases
}

function remoteDocPath(remotePath: string, dbName: string, docId: string): string {
  return path.posix.join(remotePath, 'docs', dbName, `${encodeURIComponent(docId)}.json`)
}

/**
 * Tombstone GC. Legacy tombstones without `deletedAt` (written before the
 * field existed) are treated as deleted right now: `deletedAt` is backfilled
 * so they survive one further full retention period instead of vanishing
 * immediately. Tombstones whose `deletedAt` is older than the retention
 * window are removed.
 *
 * Known trade-off (accepted — matches CouchDB behavior after compaction):
 * a device that stays offline longer than the retention period and then
 * syncs will see its local copies of collected-tombstone docs as "new" and
 * resurrect them on the remote.
 *
 * Returns true when any entry was modified or removed.
 */
function gcTombstones(databases: Manifest['databases'], now: number): boolean {
  let dirty = false
  for (const dbEntries of Object.values(databases)) {
    for (const [docId, entry] of Object.entries(dbEntries)) {
      if (!isTombstone(entry)) continue
      const deletedAtMs = entry.deletedAt ? Date.parse(entry.deletedAt) : NaN
      if (!Number.isFinite(deletedAtMs)) {
        // Legacy (or unparseable) tombstone → count retention from now
        entry.deletedAt = new Date(now).toISOString()
        dirty = true
        continue
      }
      if (now - deletedAtMs >= TOMBSTONE_RETENTION_MS) {
        delete dbEntries[docId]
        dirty = true
      }
    }
  }
  return dirty
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
    const allDocs = await db.allDocs({ include_docs: true })

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

// ─── Attachment Helpers ──────────────────────────────────────────────

/**
 * Upload all inline attachments of a doc to content-addressed storage and
 * replace them with stubs referencing the uploaded blob (`_sha256`).
 * Returns a JSON-safe clone of the doc.
 */
async function extractAndUploadAttachments(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  fullDoc: any,
  result: SyncResult
): Promise<any> {
  const attachments = fullDoc._attachments
  const docClone = JSON.parse(JSON.stringify({ ...fullDoc, _attachments: undefined }))

  if (!attachments) return docClone

  const cleanAtts: any = {}
  for (const [attName, att] of Object.entries(attachments)) {
    const anyAtt: any = { ...(att as any) }
    if (anyAtt.data != null) {
      const attBuffer = Buffer.isBuffer(anyAtt.data)
        ? anyAtt.data
        : Buffer.from(anyAtt.data, 'base64')

      const attHash = sha256(attBuffer)
      const attDir = path.posix.join(remotePath, 'attachments')
      const attPath = path.posix.join(attDir, `${attHash}.bin`)

      // Content-addressed: only upload if not already present
      if (!(await adapter.exists(attPath))) {
        await ensureDirRecursive(adapter, attDir)
        await adapter.writeFile(attPath, attBuffer, {
          contentType: anyAtt.content_type || 'application/octet-stream'
        })
        result.attachmentsUploaded++
      }

      // Keep the byte length in the remote stub: docContentHash includes it,
      // and older stubs that lacked it are handled conservatively on read.
      anyAtt.length ??= attBuffer.length
      delete anyAtt.data
      anyAtt.stub = true
      anyAtt._sha256 = attHash
    }
    cleanAtts[attName] = anyAtt
  }

  docClone._attachments = cleanAtts
  return docClone
}

/**
 * Restore attachment inline data from content-addressed blobs.
 * Returns false when any attachment blob is missing (the doc must then be
 * skipped so we never save a stub pointing at nothing).
 */
async function restoreAttachments(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  doc: any,
  result: SyncResult
): Promise<boolean> {
  if (!doc._attachments) return true

  for (const att of Object.values(doc._attachments)) {
    const anyAtt = att as any
    if (!anyAtt.stub) continue
    if (!anyAtt._sha256) return false

    const attPath = path.posix.join(remotePath, 'attachments', `${anyAtt._sha256}.bin`)
    if (!(await adapter.exists(attPath))) return false

    const attBuffer = (await adapter.readFile(attPath, 'binary')) as Buffer
    anyAtt.data = attBuffer.toString('base64')
    delete anyAtt.stub
    delete anyAtt._sha256
    result.attachmentsDownloaded++
  }

  return true
}

// ─── Orphan Attachment GC (R3) ───────────────────────────────────────

const BLOB_FILE_RE = /^([0-9a-f]{64})\.bin$/

/**
 * Collect the sha256 of every attachment blob referenced by the current
 * remote state: all live docs in the remote manifest plus every conflict
 * copy parked under conflicts/ (their attachments are content-addressed in
 * the same blob store). Returns null when any live doc or conflict copy
 * cannot be read or parsed — the caller must then skip deletion entirely,
 * because an unreadable doc may reference any blob. This conservatism is
 * deliberate and must stay strict: the R4 save-deletion guard fails open on
 * unreadable remote docs, so this is the only remaining protection for
 * their blobs.
 */
async function collectReferencedBlobHashes(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  remoteManifest: Manifest
): Promise<Set<string> | null> {
  const referenced = new Set<string>()

  const addDocRefs = (doc: any): void => {
    const attachments = doc?._attachments
    if (!attachments || typeof attachments !== 'object') return
    for (const att of Object.values(attachments)) {
      const hash = (att as any)?._sha256
      if (typeof hash === 'string' && hash.length > 0) referenced.add(hash)
    }
  }

  for (const [dbName, docs] of Object.entries(remoteManifest.databases ?? {})) {
    for (const [docId, entry] of Object.entries(docs ?? {})) {
      if (!isLiveEntry(entry)) continue
      const docPath = remoteDocPath(remotePath, dbName, docId)
      try {
        const content = await adapter.readFile(docPath, 'text')
        const doc = JSON.parse(content as string)
        // The manifest is the committed remote snapshot. A partial or
        // out-of-band doc write must block GC rather than authorizing removal
        // from its uncommitted attachment set.
        if (!(await remoteDocMatchesManifestHash(adapter, remotePath, doc, entry.hash))) {
          throw new Error('doc content hash does not match manifest entry')
        }
        addDocRefs(doc)
      } catch (err: any) {
        log.warn(
          `[Sync] Blob GC: cannot read live doc ${dbName}/${docId} (${err?.message}) — skipping GC this round`
        )
        return null
      }
    }
  }

  const conflictDir = path.posix.join(remotePath, 'conflicts')
  try {
    if (await adapter.exists(conflictDir)) {
      for (const item of await adapter.list(conflictDir)) {
        if (item.isDirectory || !item.name.endsWith('.json')) continue
        const content = await adapter.readFile(path.posix.join(conflictDir, item.name), 'text')
        addDocRefs(JSON.parse(content as string))
      }
    }
  } catch (err: any) {
    log.warn(
      `[Sync] Blob GC: cannot scan conflict copies (${err?.message}) — skipping GC this round`
    )
    return null
  }

  return referenced
}

/**
 * Delete every blob under attachments/ whose hash is not in `referenced`.
 * Unrecognized file names and directories are left alone. Individual
 * deletion failures are logged and skipped (the blob stays orphaned and is
 * retried on the next sync). Returns the number of blobs actually deleted.
 */
async function gcOrphanBlobs(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  referenced: Set<string>
): Promise<number> {
  const attDir = path.posix.join(remotePath, 'attachments')
  if (!(await adapter.exists(attDir))) return 0

  let purged = 0
  for (const item of await adapter.list(attDir)) {
    if (item.isDirectory) continue
    const match = BLOB_FILE_RE.exec(item.name)
    if (!match || referenced.has(match[1])) continue
    try {
      await adapter.deleteFile(path.posix.join(attDir, item.name))
      purged++
    } catch (err: any) {
      log.warn(`[Sync] Blob GC: failed to delete orphan ${item.name} (${err?.message})`)
    }
  }
  if (purged > 0) {
    log.info(`[Sync] Blob GC: deleted ${purged} orphan attachment blob(s)`)
  }
  return purged
}

/**
 * R3 orphan-attachment GC. Runs after a completed sync pass, while the sync
 * mutex and remote lock are still held, so no concurrent upload can add a
 * blob between reference collection and deletion. Best-effort by contract:
 * any failure is logged, returns 0, and never fails the sync.
 *
 * Every completed sync runs GC, including a no-op or download-only pass.
 * This lets clients eventually reclaim pre-existing/legacy orphan blobs
 * without waiting for an unrelated later upload. The full remote scan is
 * deliberate: R3 requires that all current live documents participate in the
 * decision.
 */
async function gcOrphanAttachments(
  adapter: RemoteStorageAdapter,
  remotePath: string
): Promise<number> {
  try {
    const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
    if (!(await adapter.exists(manifestPath))) return 0
    const manifestContent = await adapter.readFile(manifestPath, 'text')
    const remoteManifest: Manifest = JSON.parse(manifestContent as string)

    const referenced = await collectReferencedBlobHashes(adapter, remotePath, remoteManifest)
    if (referenced === null) return 0

    return await gcOrphanBlobs(adapter, remotePath, referenced)
  } catch (err: any) {
    log.warn(`[Sync] Blob GC failed (${err?.message}) — will retry next sync`)
    return 0
  }
}

// ─── Download (three-way merge, tombstone-aware) ─────────────────────

/**
 * Download phase. For every doc in remote manifest ∪ baseline, decide by
 * three-way comparison (baseline B / local L / remote R) whether to download,
 * delete locally, skip, or report a conflict. The baseline advances per-doc:
 * only docs that were actually applied locally get their baseline entry
 * updated; conflicts, skips and failures keep the old baseline value so they
 * are retried / re-reported on the next sync.
 */
async function downloadSnapshotInternal(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string,
  onProgress?: SyncProgressCallback
): Promise<SyncResult> {
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    errors: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0,
    attachmentsPurged: 0,
    deletionsPropagated: 0,
    pendingSaveDeletions: [],
    resolvedConflictCopies: []
  }

  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  if (!(await adapter.exists(manifestPath))) return result

  const manifestContent = await adapter.readFile(manifestPath, 'text')
  const remoteManifest: Manifest = JSON.parse(manifestContent as string)
  const baseline = await loadBaselineManifest()

  const newBaselineDatabases = cloneManifestDatabases(baseline)

  for (const dbName of SYNCABLE_DATABASES) {
    const remoteDB = remoteManifest.databases?.[dbName] ?? {}
    const baselineDB = baseline?.databases?.[dbName] ?? {}
    const newBaselineDB = newBaselineDatabases[dbName]
    const db = baseDBManager.getRawDatabase(dbName)

    // Local docs with content, so we can hash them for the three-way compare
    const allDocs = await db.allDocs({ include_docs: true })
    const localDocs = new Map<string, any>()
    for (const row of allDocs.rows) {
      if (!row.doc || row.doc._id.startsWith('_design/')) continue
      localDocs.set(row.doc._id, row.doc)
    }

    // Queued writes: docsToSave[i] corresponds to pendingBaseline[i]
    const docsToSave: any[] = []
    const pendingBaseline: Array<{ docId: string; entry: DocEntry; isDelete: boolean }> = []

    const allDocIds = new Set([...Object.keys(remoteDB), ...Object.keys(baselineDB)])
    const totalDocs = allDocIds.size
    let processedDocs = 0

    for (const docId of allDocIds) {
      processedDocs++
      onProgress?.({
        phase: 'download',
        database: dbName,
        current: processedDocs,
        total: totalDocs
      })
      const remoteEntry: DocEntry | undefined = remoteDB[docId]
      const baselineEntry: DocEntry | undefined = baselineDB[docId]
      const localDoc = localDocs.get(docId)
      const localHash = localDoc ? docContentHash(localDoc) : null

      // ── R missing entirely (only in baseline) ──
      // A missing entry is NOT a tombstone: legitimate deletions always
      // leave a tombstone, so a wholly absent entry means the remote was
      // wiped or remotePath points at a fresh directory. Never delete the
      // local doc here; the upload phase re-uploads it (B live) or handles
      // tombstone propagation / baseline cleanup.
      if (!remoteEntry) continue

      // ── R is a tombstone ──
      if (isTombstone(remoteEntry)) {
        if (!localDoc) {
          // Deleted on both sides (or never existed here) → record tombstone
          newBaselineDB[docId] = { ...remoteEntry }
          continue
        }
        if (isTombstone(baselineEntry)) {
          // Deletion already synced (B == R tombstone); a local doc here means
          // it was recreated locally → plain local change, not a conflict.
          // The upload phase re-uploads it over the tombstone.
          continue
        }
        // Local doc exists
        const locallyChanged = !isLiveEntry(baselineEntry) || localHash !== baselineEntry.hash
        if (!locallyChanged) {
          // Remote deletion vs unchanged local → propagate deletion locally
          docsToSave.push({ _id: docId, _rev: localDoc._rev, _deleted: true })
          pendingBaseline.push({ docId, entry: { ...remoteEntry }, isDelete: true })
        } else {
          // Delete vs edit → edit wins: keep local doc, baseline unchanged;
          // the upload phase will re-upload it over the tombstone.
          result.conflicts.push({ docId, dbName })
        }
        continue
      }

      // ── R is live ──
      const remotelyChanged = !entriesEqual(remoteEntry, baselineEntry)

      if (!localDoc) {
        if (!baselineEntry) {
          // New doc from remote → download
        } else if (isTombstone(baselineEntry)) {
          if (!remotelyChanged) continue // Tombstone already synced
          // Recreated on remote after a synced deletion → download
        } else if (!remotelyChanged) {
          // Local deletion vs unchanged remote → skip; the upload phase
          // propagates the deletion (tombstone).
          continue
        } else {
          // Local deletion vs remote edit → edit wins: restore from remote
          result.conflicts.push({ docId, dbName })
        }
      } else {
        const locallyChanged = !isLiveEntry(baselineEntry) || localHash !== baselineEntry.hash

        if (!remotelyChanged) continue // Nothing new from remote

        if (locallyChanged) {
          if (localHash === remoteEntry.hash) {
            // Both changed but content converged → adopt as synced. A previous
            // pass may have parked a local recovery copy; defer its removal to
            // the wrapper so multiple docs need only one remote scan + GC.
            newBaselineDB[docId] = { rev: localDoc._rev, hash: localHash as string }
            result.resolvedConflictCopies.push({ docId, dbName })
            continue
          }
          // True conflict: both sides changed → skip, keep old baseline so the
          // conflict stays visible on every sync until one side converges.
          result.conflicts.push({ docId, dbName })
          continue
        }
        // Remote changed, local unchanged → download (overwrite local)
      }

      // ── Download the doc ──
      const docPath = remoteDocPath(remotePath, dbName, docId)
      if (!(await adapter.exists(docPath))) {
        result.errors.push(`${dbName}/${docId}: remote doc file missing`)
        continue
      }

      let doc: any
      try {
        const docContent = await adapter.readFile(docPath, 'text')
        doc = JSON.parse(docContent as string)
      } catch (err: any) {
        result.errors.push(`${dbName}/${docId}: failed to read remote doc (${err?.message})`)
        continue
      }

      if (!(await restoreAttachments(adapter, remotePath, doc, result))) {
        result.errors.push(`${dbName}/${docId}: attachment blob missing on remote`)
        continue
      }

      if (localDoc) {
        doc._rev = localDoc._rev
      } else {
        delete doc._rev
      }

      docsToSave.push(doc)
      pendingBaseline.push({ docId, entry: { ...remoteEntry }, isDelete: false })
    }

    // Batch save; check per-doc results — failed docs keep their old baseline
    if (docsToSave.length > 0) {
      const responses = await db.bulkDocs(docsToSave)
      responses.forEach((res: any, i) => {
        const { docId, entry, isDelete } = pendingBaseline[i]
        if (res && res.error) {
          result.errors.push(`${dbName}/${docId}: ${res.name ?? res.error} (${res.message ?? ''})`)
          return
        }
        newBaselineDB[docId] = entry
        if (!isDelete) result.downloaded++
      })
    }
  }

  await saveBaselineManifest({
    version: '2.0',
    deviceId,
    lastSync: new Date().toISOString(),
    databases: newBaselineDatabases
  })

  return result
}

/** Save IDs of a game doc (keys of save.saveList), or empty set. */
function gameSaveIds(doc: any): Set<string> {
  const saveList = doc?.save?.saveList
  if (!saveList || typeof saveList !== 'object') return new Set()
  return new Set(Object.keys(saveList))
}

/**
 * Compare a local game doc with the current remote document before an
 * overwrite. A failed read/parse is deliberately represented as pending:
 * without a trustworthy remote save set, uploading could silently destroy
 * unknown saves. This helper owns the identical guard for normal uploads and
 * conflict "keep local" resolution.
 */
function pendingSaveDeletionId(
  gameId: string,
  remoteHash: string,
  localHash: string,
  removedSaveIds: string[],
  source: 'upload' | 'conflict'
): string {
  // Opaque to renderer. Stable while the exact destructive operation stays
  // stable, so persisted UI state can merge without trusting renderer data.
  return sha256(stableStringify({ gameId, remoteHash, localHash, removedSaveIds, source }))
}

function validAttachmentLength(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Reads an attachment's declared length, or reconstructs it from its known
 * content-addressed blob for legacy stubs. This is display/integrity metadata
 * only; callers must not use it to authorize a destructive operation.
 */
async function resolveAttachmentLength(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  attachment: unknown
): Promise<number | null> {
  const att = attachment as { length?: unknown; _sha256?: unknown } | null
  const declaredLength = validAttachmentLength(att?.length)
  if (declaredLength !== null) return declaredLength
  if (typeof att?._sha256 !== 'string' || !att._sha256) return null

  try {
    const stat = await adapter.stat(
      path.posix.join(remotePath, 'attachments', `${att._sha256}.bin`)
    )
    return stat && !stat.isDirectory ? validAttachmentLength(stat.size) : null
  } catch {
    return null
  }
}

async function remoteDocMatchesManifestHash(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  doc: any,
  manifestHash: string
): Promise<boolean> {
  if (docContentHash(doc) === manifestHash) return true

  // Older sync versions wrote attachment stubs without `length`, even though
  // the corresponding manifest hash included the local attachment length.
  // Reconstruct that canonical field from the content-addressed blob. Any
  // missing/unreadable blob keeps this validation false (fail closed).
  const legacyDoc = JSON.parse(JSON.stringify(doc))
  for (const attachment of Object.values(legacyDoc._attachments ?? {})) {
    const legacyAttachment = attachment as { length?: unknown }
    // Preserve the normal hash path for every declared numeric value. Only
    // legacy stubs that genuinely omit `length` may be reconstructed from a
    // blob stat; otherwise this compatibility path could mask a changed doc.
    if (typeof legacyAttachment.length === 'number') continue

    const length = await resolveAttachmentLength(adapter, remotePath, attachment)
    if (length === null) return false
    legacyAttachment.length = length
  }
  return docContentHash(legacyDoc) === manifestHash
}

async function createPendingSaveDeletionDisplaySaves(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  remoteDoc: any,
  removedSaveIds: string[]
): Promise<PendingSaveDeletionDisplaySave[]> {
  const saveList = remoteDoc?.save?.saveList
  const attachments = remoteDoc?._attachments
  return Promise.all(
    removedSaveIds.map(async (saveId) => {
      const save = saveList?.[saveId]
      const attachment = attachments?.[`saves/${saveId}.zip`]
      return {
        date: typeof save?.date === 'string' ? save.date : null,
        note: typeof save?.note === 'string' ? save.note : null,
        sizeBytes: await resolveAttachmentLength(adapter, remotePath, attachment)
      }
    })
  )
}

async function inspectSaveDeletion(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  docId: string,
  remoteEntry: DocEntry,
  fullDoc: any | null,
  localHash: string,
  source: 'upload' | 'conflict'
): Promise<PendingSaveDeletion | null> {
  const failedComparison = (error: unknown): PendingSaveDeletion => ({
    id: pendingSaveDeletionId(docId, remoteEntry.hash, localHash, [], source),
    gameId: docId,
    removedCount: 0,
    remoteSaveCount: 0,
    clearsHistory: false,
    remoteHash: remoteEntry.hash,
    localHash,
    removedSaveIds: [],
    source,
    comparisonFailed: true,
    error: error instanceof Error ? error.message : 'unknown remote read error'
  })

  try {
    const docPath = remoteDocPath(remotePath, 'game', docId)
    if (!(await adapter.exists(docPath))) {
      throw new Error('remote doc file is missing')
    }
    const remoteDocContent = await adapter.readFile(docPath, 'text')
    const remoteDoc = JSON.parse(remoteDocContent as string)
    // The manifest commits to the exact remote JSON. A mismatched doc may be
    // stale or tampered, so it must never authorize destructive propagation.
    if (!(await remoteDocMatchesManifestHash(adapter, remotePath, remoteDoc, remoteEntry.hash))) {
      throw new Error('remote doc content hash does not match manifest entry')
    }
    const remoteSaveIds = gameSaveIds(remoteDoc)
    const localSaveIds = gameSaveIds(fullDoc)
    const removedSaveIds = [...remoteSaveIds].filter((saveId) => !localSaveIds.has(saveId)).sort()
    const clearsHistory = localSaveIds.size === 0 && remoteSaveIds.size > 0
    if (removedSaveIds.length <= MAX_SILENT_SAVE_REMOVALS && !clearsHistory) return null
    return {
      id: pendingSaveDeletionId(docId, remoteEntry.hash, localHash, removedSaveIds, source),
      gameId: docId,
      removedCount: removedSaveIds.length,
      remoteSaveCount: remoteSaveIds.size,
      clearsHistory,
      remoteHash: remoteEntry.hash,
      localHash,
      removedSaveIds,
      source,
      displaySaves: await createPendingSaveDeletionDisplaySaves(
        adapter,
        remotePath,
        remoteDoc,
        removedSaveIds
      )
    }
  } catch (error) {
    return failedComparison(error)
  }
}

// ─── Upload (three-way merge, tombstone-aware) ───────────────────────

/**
 * Upload phase. For every doc in local manifest ∪ baseline, decide by
 * three-way comparison whether to upload, propagate a deletion (tombstone),
 * skip, or report a conflict. Baseline and remote manifest advance per-doc:
 * only actually-uploaded docs get new entries; conflicts and failures keep
 * both at their old values so they are retried / re-reported next sync.
 */
async function uploadSnapshotInternal(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string,
  onProgress?: SyncProgressCallback
): Promise<SyncResult> {
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    errors: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0,
    attachmentsPurged: 0,
    deletionsPropagated: 0,
    pendingSaveDeletions: [],
    resolvedConflictCopies: []
  }

  const localManifest = await buildLocalManifest(deviceId)
  const baseline = await loadBaselineManifest()
  const saveDeletionApprovals = await loadSaveDeletionApprovals()

  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  let remoteManifest: Manifest | null = null
  if (await adapter.exists(manifestPath)) {
    const content = await adapter.readFile(manifestPath, 'text')
    remoteManifest = JSON.parse(content as string)
  }

  const newBaselineDatabases = cloneManifestDatabases(baseline)
  const newRemoteDatabases = cloneManifestDatabases(remoteManifest)
  const consumedSaveDeletionApprovals = new Set<number>()
  let remoteManifestDirty = false

  for (const dbName of SYNCABLE_DATABASES) {
    const localDB = localManifest.databases[dbName] ?? {}
    const baselineDB = baseline?.databases?.[dbName] ?? {}
    const remoteDB = remoteManifest?.databases?.[dbName] ?? {}
    const newBaselineDB = newBaselineDatabases[dbName]
    const newRemoteDB = newRemoteDatabases[dbName]
    const db = baseDBManager.getRawDatabase(dbName)

    const allDocIds = new Set([...Object.keys(localDB), ...Object.keys(baselineDB)])
    const totalDocs = allDocIds.size
    let processedDocs = 0

    for (const docId of allDocIds) {
      processedDocs++
      onProgress?.({
        phase: 'upload',
        database: dbName,
        current: processedDocs,
        total: totalDocs
      })
      const localEntry: DocEntry | undefined = localDB[docId]
      const baselineEntry: DocEntry | undefined = baselineDB[docId]
      const remoteEntry: DocEntry | undefined = remoteDB[docId]

      // ── Local doc deleted ──
      if (!localEntry) {
        if (!baselineEntry) continue // Never synced, nothing to do
        if (isTombstone(baselineEntry)) continue // Deletion already synced

        const remotelyChanged = !entriesEqual(remoteEntry, baselineEntry)

        if (isTombstone(remoteEntry)) {
          // Deleted on both sides → adopt remote tombstone
          newBaselineDB[docId] = { ...remoteEntry }
          continue
        }

        if (remotelyChanged && isLiveEntry(remoteEntry)) {
          // Local deletion vs remote edit → edit wins; the download phase
          // restores the doc. Keep baseline/manifest untouched.
          result.conflicts.push({ docId, dbName })
          continue
        }

        // Whole game-doc deletion removes its entire save history. It must
        // pass the same exact R4 approval as an in-place overwrite; otherwise
        // a local DB loss could silently tombstone remote saves and GC blobs.
        let approvalIndex = -1
        if (dbName === 'game' && isLiveEntry(remoteEntry)) {
          const pending = await inspectSaveDeletion(
            adapter,
            remotePath,
            docId,
            remoteEntry,
            null,
            DELETED_GAME_DOC_HASH,
            'upload'
          )
          if (pending) {
            approvalIndex = matchingSaveDeletionApproval(saveDeletionApprovals, pending)
            if (approvalIndex < 0) {
              result.pendingSaveDeletions.push(pending)
              if (pending.comparisonFailed) {
                result.errors.push(
                  `${dbName}/${docId}: cannot compare remote saves; deletion held (${pending.error})`
                )
              } else {
                log.warn(
                  `[Sync] Held back deletion of ${docId}: would delete ${pending.removedCount} remote saves ` +
                    '(awaiting user confirmation)'
                )
              }
              continue
            }
          }
        }

        // Local deletion vs unchanged remote (or remote already gone)
        // → propagate deletion: remove remote doc file, write tombstone.
        try {
          const docPath = remoteDocPath(remotePath, dbName, docId)
          if (await adapter.exists(docPath)) {
            await adapter.deleteFile(docPath)
          }
          const tombstone: DocEntry = {
            rev: baselineEntry.rev,
            hash: '',
            deleted: true,
            deletedAt: new Date().toISOString()
          }
          newRemoteDB[docId] = { ...tombstone }
          newBaselineDB[docId] = { ...tombstone }
          remoteManifestDirty = true
          result.deletionsPropagated++
          if (approvalIndex >= 0) consumedSaveDeletionApprovals.add(approvalIndex)
        } catch (err: any) {
          result.errors.push(`${dbName}/${docId}: failed to delete on remote (${err?.message})`)
        }
        continue
      }

      // ── Local doc exists ──
      const baselineLive = isLiveEntry(baselineEntry)
      const locallyChanged = !baselineLive || localEntry.hash !== baselineEntry.hash
      if (!locallyChanged) {
        // ── L live, L==B, but R entry missing entirely ──
        // Legitimate deletions always leave a tombstone, so a wholly absent
        // remote entry means the remote was wiped or remotePath points at a
        // fresh directory → treat as new: fall through and re-upload,
        // recording fresh manifest + baseline entries.
        if (remoteEntry === undefined) {
          // fall through to the upload branch below
        } else {
          // Unchanged since baseline; remote-side differences are handled by
          // the download phase.
          continue
        }
      }

      const remotelyChanged = !!remoteEntry && !entriesEqual(remoteEntry, baselineEntry)

      if (isLiveEntry(remoteEntry) && remotelyChanged) {
        if (remoteEntry.hash === localEntry.hash) {
          // Content converged (e.g. cold start with identical data, or the
          // same edit made on both sides) → adopt as synced, nothing to upload.
          // Any parked recovery copies are no longer needed, but cleanup is
          // batched by the mutex+lock wrapper after this whole pass completes.
          newBaselineDB[docId] = { rev: localEntry.rev, hash: localEntry.hash }
          result.resolvedConflictCopies.push({ docId, dbName })
          continue
        }

        // True conflict: both sides changed → do NOT upload/overwrite.
        // Baseline and remote manifest keep their old values, so the conflict
        // is re-reported every sync until one side converges. A copy of the
        // local doc is parked under conflicts/ on the remote for recovery.
        result.conflicts.push({ docId, dbName })
        try {
          // Content-addressed name: a persisting conflict re-detected on every
          // sync writes the copy only once per distinct local content, instead
          // of accumulating a new timestamped file per sync run.
          const conflictDir = path.posix.join(remotePath, 'conflicts')
          const conflictName = `${dbName}__${encodeURIComponent(docId)}__${localEntry.hash.slice(0, 16)}.json`
          const conflictPath = path.posix.join(conflictDir, conflictName)
          if (!(await adapter.exists(conflictPath))) {
            const fullDoc = await db.get(docId, { attachments: true, binary: true })
            const conflictClone = await extractAndUploadAttachments(
              adapter,
              remotePath,
              fullDoc,
              result
            )
            await ensureDirRecursive(adapter, conflictDir)
            await adapter.writeFile(conflictPath, JSON.stringify(conflictClone, null, 2), {
              contentType: 'application/json'
            })
          }
        } catch (err: any) {
          log.warn(`[Sync] Failed to write conflict copy for ${dbName}/${docId}:`, err)
        }
        continue
      }

      // Local new/edited, remote unchanged, missing, or tombstoned
      // (edit wins over a remote tombstone) → upload
      try {
        const fullDoc = await db.get(docId, { attachments: true, binary: true })

        // ── Save-deletion guard (game docs only) ──
        // This is fail-closed: a read/parse failure means we cannot prove that
        // an overwrite is safe, therefore neither doc nor baseline advances.
        let approvalIndex = -1
        if (dbName === 'game' && isLiveEntry(remoteEntry)) {
          const pending = await inspectSaveDeletion(
            adapter,
            remotePath,
            docId,
            remoteEntry,
            fullDoc,
            localEntry.hash,
            'upload'
          )
          if (pending) {
            approvalIndex = matchingSaveDeletionApproval(saveDeletionApprovals, pending)
            if (approvalIndex < 0) {
              result.pendingSaveDeletions.push(pending)
              if (pending.comparisonFailed) {
                result.errors.push(
                  `${dbName}/${docId}: cannot compare remote saves; upload held (${pending.error})`
                )
              } else {
                log.warn(
                  `[Sync] Held back upload of ${docId}: would delete ${pending.removedCount} of ` +
                    `${pending.remoteSaveCount} remote saves (awaiting user confirmation)`
                )
              }
              continue
            }
            log.info(
              `[Sync] Approved save deletion for ${docId} (${pending.removedCount} saves) — propagating`
            )
          }
        }

        const docClone = await extractAndUploadAttachments(adapter, remotePath, fullDoc, result)

        const docDir = path.posix.join(remotePath, 'docs', dbName)
        await ensureDirRecursive(adapter, docDir)
        await adapter.writeFile(
          path.posix.join(docDir, `${encodeURIComponent(docId)}.json`),
          JSON.stringify(docClone),
          { contentType: 'application/json' }
        )
        result.uploaded++

        const newEntry: DocEntry = { rev: localEntry.rev, hash: localEntry.hash }
        newRemoteDB[docId] = { ...newEntry }
        newBaselineDB[docId] = { ...newEntry }
        remoteManifestDirty = true
        if (approvalIndex >= 0) consumedSaveDeletionApprovals.add(approvalIndex)
      } catch (err: any) {
        result.errors.push(`${dbName}/${docId}: upload failed (${err?.message})`)
      }
    }
  }

  // GC expired tombstones from both the outgoing remote manifest and the new
  // baseline (kept in lockstep so a collected tombstone doesn't linger in one
  // and resurrect decisions in the other).
  const gcNow = Date.now()
  const remoteGcDirty = gcTombstones(newRemoteDatabases, gcNow)
  gcTombstones(newBaselineDatabases, gcNow)

  // Write the remote manifest (entries only advanced for successful uploads)
  if (remoteManifestDirty || remoteGcDirty || !remoteManifest) {
    const updatedManifest: Manifest = {
      version: '2.0',
      deviceId,
      lastSync: new Date().toISOString(),
      databases: newRemoteDatabases
    }
    await adapter.writeFile(manifestPath, JSON.stringify(updatedManifest), {
      contentType: 'application/json'
    })
  }

  // An approval is consumed only after the matching upload and its manifest
  // update completed. Failed, stale, or unrelated approvals remain unusable
  // until their exact operation is retried or superseded by a fresh approval.
  if (consumedSaveDeletionApprovals.size > 0) {
    await storeSaveDeletionApprovals(
      saveDeletionApprovals.filter((_, index) => !consumedSaveDeletionApprovals.has(index))
    )
  }

  await saveBaselineManifest({
    version: '2.0',
    deviceId,
    lastSync: new Date().toISOString(),
    databases: newBaselineDatabases
  })

  return result
}

// ─── Public API (mutex + lock wrappers) ──────────────────────────────

export async function uploadSnapshot(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  onProgress?: SyncProgressCallback
): Promise<SyncResult> {
  return withSyncMutex(async () => {
    const deviceId = await getDeviceId()
    await acquireLock(adapter, remotePath, deviceId)
    try {
      const result = await uploadSnapshotInternal(adapter, remotePath, deviceId, onProgress)
      await removeResolvedConflictCopies(adapter, remotePath, result.resolvedConflictCopies)
      result.attachmentsPurged = !result.pendingSaveDeletions.some(
        (pending) => pending.comparisonFailed
      )
        ? await gcOrphanAttachments(adapter, remotePath)
        : 0
      return result
    } finally {
      await releaseLock(adapter, remotePath, deviceId)
    }
  })
}

export async function downloadSnapshot(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  onProgress?: SyncProgressCallback
): Promise<SyncResult> {
  return withSyncMutex(async () => {
    const deviceId = await getDeviceId()
    await acquireLock(adapter, remotePath, deviceId)
    try {
      const result = await downloadSnapshotInternal(adapter, remotePath, deviceId, onProgress)
      await removeResolvedConflictCopies(adapter, remotePath, result.resolvedConflictCopies)
      result.attachmentsPurged = await gcOrphanAttachments(adapter, remotePath)
      return result
    } finally {
      await releaseLock(adapter, remotePath, deviceId)
    }
  })
}

// ─── Per-conflict Resolution ─────────────────────────────────────────

export interface ConflictVersions {
  local: Record<string, unknown> | null
  remote: Record<string, unknown> | null
  /** True when the remote manifest entry is a tombstone */
  remoteDeleted: boolean
}

function assertSyncableDatabase(dbName: string): void {
  if (!SYNCABLE_DATABASES.includes(dbName)) {
    throw new Error(`Unknown database: ${dbName}`)
  }
}

/** Strip _rev for display: it is device-local and meaningless in a diff. */
function sanitizeDocForDisplay(doc: any): Record<string, unknown> {
  const clone = { ...doc }
  delete clone._rev
  return clone
}

function emptySyncResult(): SyncResult {
  return {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    errors: [],
    attachmentsUploaded: 0,
    attachmentsDownloaded: 0,
    attachmentsPurged: 0,
    deletionsPropagated: 0,
    pendingSaveDeletions: [],
    resolvedConflictCopies: []
  }
}

/**
 * Read both sides of a conflict for display. Read-only and lock-free: a
 * concurrent sync can at worst make this snapshot slightly stale; the actual
 * resolution runs under the sync mutex + remote lock and re-reads the remote.
 */
export async function getConflictVersions(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  dbName: string,
  docId: string
): Promise<ConflictVersions> {
  assertSyncableDatabase(dbName)
  const db = baseDBManager.getRawDatabase(dbName)

  let local: Record<string, unknown> | null = null
  try {
    local = sanitizeDocForDisplay(await db.get(docId))
  } catch {
    local = null
  }

  let remote: Record<string, unknown> | null = null
  let remoteDeleted = false

  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  if (await adapter.exists(manifestPath)) {
    const manifestContent = await adapter.readFile(manifestPath, 'text')
    const manifest: Manifest = JSON.parse(manifestContent as string)
    const entry = manifest.databases?.[dbName]?.[docId]
    remoteDeleted = isTombstone(entry)
    if (isLiveEntry(entry)) {
      const docPath = remoteDocPath(remotePath, dbName, docId)
      if (await adapter.exists(docPath)) {
        const docContent = await adapter.readFile(docPath, 'text')
        remote = sanitizeDocForDisplay(JSON.parse(docContent as string))
      }
    }
  }

  return { local, remote, remoteDeleted }
}

/**
 * Resolve a single conflict by choosing one side wholesale.
 *
 * - 'local': upload the local doc over the remote one, advancing both the
 *   remote manifest and the baseline to the local version.
 * - 'remote': apply the remote doc (attachments restored) to the local DB,
 *   advancing the baseline to the remote manifest entry.
 *
 * Runs under the sync mutex + remote lock so it cannot interleave with a
 * running sync. On any failure the baseline is left untouched, so the
 * conflict keeps being re-reported by subsequent syncs.
 */
export type ResolveConflictResult =
  | { status: 'resolved'; attachmentsPurged: number }
  | { status: 'pending-save-deletion'; pendingSaveDeletion: PendingSaveDeletion }

export async function resolveConflict(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  dbName: string,
  docId: string,
  choice: 'local' | 'remote'
): Promise<ResolveConflictResult> {
  assertSyncableDatabase(dbName)
  return withSyncMutex(async () => {
    const deviceId = await getDeviceId()
    await acquireLock(adapter, remotePath, deviceId)
    try {
      if (choice === 'local') {
        return await resolveConflictKeepLocal(adapter, remotePath, deviceId, dbName, docId)
      }
      const attachmentsPurged = await resolveConflictUseRemote(
        adapter,
        remotePath,
        deviceId,
        dbName,
        docId
      )
      return { status: 'resolved', attachmentsPurged }
    } finally {
      await releaseLock(adapter, remotePath, deviceId)
    }
  })
}

async function resolveConflictKeepLocal(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string,
  dbName: string,
  docId: string
): Promise<ResolveConflictResult> {
  const db = baseDBManager.getRawDatabase(dbName)

  let fullDoc: any
  try {
    fullDoc = await db.get(docId, { attachments: true, binary: true })
  } catch {
    throw new Error(`Local doc ${dbName}/${docId} no longer exists; run a sync instead`)
  }
  const localHash = docContentHash(fullDoc)

  // Read the manifest and game document under the same mutex + remote lock
  // before writing anything. This is both the R4 guard and the TOCTOU check
  // for a content-bound user authorization.
  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  if (!(await adapter.exists(manifestPath))) {
    throw new Error('Remote manifest missing; run a sync instead')
  }
  const manifestContent = await adapter.readFile(manifestPath, 'text')
  const remoteManifest: Manifest = JSON.parse(manifestContent as string)
  const remoteEntry = remoteManifest.databases?.[dbName]?.[docId]
  if (!isLiveEntry(remoteEntry)) {
    throw new Error(`Remote version of ${dbName}/${docId} no longer exists; run a sync instead`)
  }

  let approvalIndex = -1
  let approvals: SaveDeletionApproval[] = []
  if (dbName === 'game') {
    const pending = await inspectSaveDeletion(
      adapter,
      remotePath,
      docId,
      remoteEntry,
      fullDoc,
      localHash,
      'conflict'
    )
    if (pending) {
      approvals = await loadSaveDeletionApprovals()
      approvalIndex = matchingSaveDeletionApproval(approvals, pending)
      if (approvalIndex < 0) {
        return { status: 'pending-save-deletion', pendingSaveDeletion: pending }
      }
    }
  }

  const attachmentResult = emptySyncResult()
  const docClone = await extractAndUploadAttachments(adapter, remotePath, fullDoc, attachmentResult)
  const docDir = path.posix.join(remotePath, 'docs', dbName)
  await ensureDirRecursive(adapter, docDir)
  await adapter.writeFile(remoteDocPath(remotePath, dbName, docId), JSON.stringify(docClone), {
    contentType: 'application/json'
  })

  const newEntry: DocEntry = { rev: fullDoc._rev, hash: localHash }
  const newRemoteDatabases = cloneManifestDatabases(remoteManifest)
  newRemoteDatabases[dbName][docId] = { ...newEntry }
  await adapter.writeFile(
    manifestPath,
    JSON.stringify({
      version: '2.0',
      deviceId,
      lastSync: new Date().toISOString(),
      databases: newRemoteDatabases
    } satisfies Manifest),
    { contentType: 'application/json' }
  )

  const baseline = await loadBaselineManifest()
  const newBaselineDatabases = cloneManifestDatabases(baseline)
  newBaselineDatabases[dbName][docId] = { ...newEntry }
  await saveBaselineManifest({
    version: '2.0',
    deviceId,
    lastSync: new Date().toISOString(),
    databases: newBaselineDatabases
  })

  // The authorization is consumed only after its exact remote overwrite and
  // manifest/baseline updates completed. The remote lock still protects GC.
  if (approvalIndex >= 0) {
    await storeSaveDeletionApprovals(approvals.filter((_, index) => index !== approvalIndex))
  }
  return {
    status: 'resolved',
    attachmentsPurged: await removeResolvedConflictCopiesAndGc(adapter, remotePath, dbName, docId)
  }
}

/**
 * Remove every parked recovery copy for the supplied resolved documents.
 * Returns false on any failure so callers never GC blobs that may still be
 * referenced by an undeleted copy. One directory listing batches all docs
 * that converged in the same sync pass.
 */
async function removeResolvedConflictCopies(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  resolved: readonly ConflictInfo[]
): Promise<boolean> {
  if (resolved.length === 0) return false
  const prefixes = new Set(
    resolved.map(({ dbName, docId }) => `${dbName}__${encodeURIComponent(docId)}__`)
  )
  const conflictDir = path.posix.join(remotePath, 'conflicts')
  try {
    if (!(await adapter.exists(conflictDir))) return true
    for (const item of await adapter.list(conflictDir)) {
      if (
        !item.isDirectory &&
        item.name.endsWith('.json') &&
        [...prefixes].some((prefix) => item.name.startsWith(prefix))
      ) {
        await adapter.deleteFile(path.posix.join(conflictDir, item.name))
      }
    }
    return true
  } catch (error) {
    log.warn('[Sync] Failed to remove resolved conflict copies:', error)
    return false
  }
}

/** Explicit resolution has one doc; use the same batched cleanup primitive. */
async function removeResolvedConflictCopiesAndGc(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  dbName: string,
  docId: string
): Promise<number> {
  const removed = await removeResolvedConflictCopies(adapter, remotePath, [{ dbName, docId }])
  return removed ? await gcOrphanAttachments(adapter, remotePath) : 0
}

async function resolveConflictUseRemote(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  deviceId: string,
  dbName: string,
  docId: string
): Promise<number> {
  const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
  if (!(await adapter.exists(manifestPath))) {
    throw new Error('Remote manifest missing; run a sync instead')
  }
  const manifestContent = await adapter.readFile(manifestPath, 'text')
  const remoteManifest: Manifest = JSON.parse(manifestContent as string)
  const remoteEntry = remoteManifest.databases?.[dbName]?.[docId]
  if (!isLiveEntry(remoteEntry)) {
    // Missing or tombstoned remote entry means this is no longer a live-live
    // conflict; a normal sync will settle it (edit-wins / deletion).
    throw new Error(`Remote version of ${dbName}/${docId} no longer exists; run a sync instead`)
  }

  const docPath = remoteDocPath(remotePath, dbName, docId)
  if (!(await adapter.exists(docPath))) {
    throw new Error(`Remote doc file for ${dbName}/${docId} is missing`)
  }
  const docContent = await adapter.readFile(docPath, 'text')
  const doc = JSON.parse(docContent as string)

  if (!(await restoreAttachments(adapter, remotePath, doc, emptySyncResult()))) {
    throw new Error(`Attachment blob missing on remote for ${dbName}/${docId}`)
  }

  const db = baseDBManager.getRawDatabase(dbName)
  try {
    const localDoc = await db.get(docId)
    doc._rev = localDoc._rev
  } catch {
    delete doc._rev
  }
  await db.put(doc)

  // Same convention as the download phase: adopt the remote entry wholesale
  // (rev is the remote device's rev; comparisons only use the hash).
  const baseline = await loadBaselineManifest()
  const newBaselineDatabases = cloneManifestDatabases(baseline)
  newBaselineDatabases[dbName][docId] = { ...remoteEntry }
  await saveBaselineManifest({
    version: '2.0',
    deviceId,
    lastSync: new Date().toISOString(),
    databases: newBaselineDatabases
  })
  return await removeResolvedConflictCopiesAndGc(adapter, remotePath, dbName, docId)
}

// ─── Force Restore One Game From Remote (R2) ────────────────────────

export interface ForceRestoreResult {
  status:
    | 'restored'
    | 'no-remote'
    | 'remote-empty'
    | 'remote-older'
    | 'blob-missing'
    | 'remote-invalid'
  /** ISO date of the newest remote save (null when the remote doc has none) */
  remoteNewest?: string | null
  /** ISO date of the newest local save (null when the local doc has none) */
  localNewest?: string | null
  attachmentsDownloaded?: number
}

/** Newest `date` across a game doc's save.saveList, or null when empty. */
function newestSaveDate(doc: any): string | null {
  const saveList = doc?.save?.saveList
  if (!saveList || typeof saveList !== 'object') return null
  let newest: string | null = null
  for (const save of Object.values(saveList)) {
    const date = (save as any)?.date
    if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) continue
    if (newest === null || Date.parse(date) > Date.parse(newest)) newest = date
  }
  return newest
}

/**
 * R2 escape hatch: restore ONE game doc (and its save attachments) from the
 * remote, bypassing the three-way merge for this doc only. Used when the
 * local copy is known-bad (e.g. saves were deleted by mistake) and normal
 * sync would treat the local state as the latest intent.
 *
 * Structured refusals instead of exceptions:
 * - 'no-remote': the remote has no live version of this game.
 * - 'remote-older': the newest remote save is older than the newest local
 *   save (or the remote doc has no saves while the local one does). Nothing
 *   is touched; the caller must re-invoke with `confirmedOlder: true` after
 *   an explicit user confirmation.
 * - 'blob-missing': a save blob is gone from the remote; the local doc is
 *   left untouched so no save is replaced by a dangling stub.
 *
 * On success the baseline entry of THIS docId (and no other) is aligned to
 * the remote manifest entry, so the next sync sees local == baseline ==
 * remote and neither re-uploads the old state nor reports a conflict.
 *
 * Runs under the sync mutex + remote lock, held continuously from the
 * manifest read through the last blob fetch — the R3 orphan GC also runs
 * under this lock, so a concurrent GC can never delete a blob between the
 * doc read and its download.
 */
export async function forceRestoreGameFromRemote(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  gameId: string,
  opts: { confirmedOlder?: boolean } = {}
): Promise<ForceRestoreResult> {
  return withSyncMutex(async () => {
    const deviceId = await getDeviceId()
    await acquireLock(adapter, remotePath, deviceId)
    try {
      const manifestPath = path.posix.join(remotePath, MANIFEST_FILE)
      if (!(await adapter.exists(manifestPath))) return { status: 'no-remote' }
      const manifestContent = await adapter.readFile(manifestPath, 'text')
      const remoteManifest: Manifest = JSON.parse(manifestContent as string)
      const remoteEntry = remoteManifest.databases?.game?.[gameId]
      if (!isLiveEntry(remoteEntry)) return { status: 'no-remote' }

      const docPath = remoteDocPath(remotePath, 'game', gameId)
      if (!(await adapter.exists(docPath))) return { status: 'no-remote' }
      const docContent = await adapter.readFile(docPath, 'text')
      let doc: any
      try {
        doc = JSON.parse(docContent as string)
        // The manifest is the remote snapshot's commit record. Never import a
        // doc that differs from its committed hash: it could be a partial write
        // or out-of-band tampering. This precedes every local/baseline/blob
        // mutation, and shares the legacy stub-length compatibility used by R4.
        if (!(await remoteDocMatchesManifestHash(adapter, remotePath, doc, remoteEntry.hash))) {
          return { status: 'remote-invalid' }
        }
      } catch {
        return { status: 'remote-invalid' }
      }

      const db = baseDBManager.getRawDatabase('game')
      let localDoc: any = null
      try {
        localDoc = await db.get(gameId)
      } catch {
        localDoc = null
      }

      // Timestamp guard: refuse to silently replace newer local saves with
      // older remote ones. Compares newest save dates only — doc-level edit
      // times don't exist, and saves are what this restore is about.
      const remoteNewest = newestSaveDate(doc)
      const localNewest = localDoc ? newestSaveDate(localDoc) : null
      // Nothing to restore: the remote doc exists but carries no saves at all
      // (e.g. a confirmed bulk deletion already propagated). Refuse honestly
      // instead of "restoring" an empty save history and reporting success.
      if (remoteNewest === null) {
        return { status: 'remote-empty', remoteNewest, localNewest }
      }
      if (!opts.confirmedOlder && localNewest !== null) {
        if (Date.parse(remoteNewest) < Date.parse(localNewest)) {
          return { status: 'remote-older', remoteNewest, localNewest }
        }
      }

      const result = emptySyncResult()
      if (!(await restoreAttachments(adapter, remotePath, doc, result))) {
        return { status: 'blob-missing' }
      }

      if (localDoc) {
        doc._rev = localDoc._rev
      } else {
        delete doc._rev
      }
      await db.put(doc)

      // Align ONLY this doc's baseline entry to the remote manifest entry
      // (same convention as resolveConflictUseRemote): the next three-way
      // merge sees local == baseline == remote for this doc and is a no-op.
      const baseline = await loadBaselineManifest()
      const newBaselineDatabases = cloneManifestDatabases(baseline)
      newBaselineDatabases.game[gameId] = { ...remoteEntry }
      await saveBaselineManifest({
        version: '2.0',
        deviceId,
        lastSync: new Date().toISOString(),
        databases: newBaselineDatabases
      })

      log.info(
        `[Sync] Force-restored game/${gameId} from remote ` +
          `(${result.attachmentsDownloaded} attachment blob(s) downloaded)`
      )
      return {
        status: 'restored',
        remoteNewest,
        localNewest,
        attachmentsDownloaded: result.attachmentsDownloaded
      }
    } finally {
      await releaseLock(adapter, remotePath, deviceId)
    }
  })
}

export async function syncBidirectional(
  adapter: RemoteStorageAdapter,
  remotePath: string,
  onProgress?: SyncProgressCallback
): Promise<SyncResult> {
  return withSyncMutex(async () => {
    const deviceId = await getDeviceId()
    await acquireLock(adapter, remotePath, deviceId)
    try {
      // Download first, then upload — one lock spans both phases
      const dlResult = await downloadSnapshotInternal(adapter, remotePath, deviceId, onProgress)
      const ulResult = await uploadSnapshotInternal(adapter, remotePath, deviceId, onProgress)

      const result: SyncResult = {
        uploaded: ulResult.uploaded,
        downloaded: dlResult.downloaded,
        conflicts: [...dlResult.conflicts],
        errors: [...dlResult.errors, ...ulResult.errors],
        attachmentsUploaded: ulResult.attachmentsUploaded,
        attachmentsDownloaded: dlResult.attachmentsDownloaded,
        attachmentsPurged: 0,
        deletionsPropagated: ulResult.deletionsPropagated,
        pendingSaveDeletions: [...ulResult.pendingSaveDeletions],
        resolvedConflictCopies: [
          ...dlResult.resolvedConflictCopies,
          ...ulResult.resolvedConflictCopies
        ]
      }
      for (const c of ulResult.conflicts) {
        if (!result.conflicts.some((e) => e.docId === c.docId && e.dbName === c.dbName)) {
          result.conflicts.push(c)
        }
      }
      await removeResolvedConflictCopies(adapter, remotePath, result.resolvedConflictCopies)
      result.attachmentsPurged = !ulResult.pendingSaveDeletions.some(
        (pending) => pending.comparisonFailed
      )
        ? await gcOrphanAttachments(adapter, remotePath)
        : 0
      return result
    } finally {
      await releaseLock(adapter, remotePath, deviceId)
    }
  })
}
