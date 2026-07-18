import type { PendingSaveDeletionDisplaySave } from '@appTypes/models'

const COLLAPSED_SAVE_LIMIT = 3

function normalizeDisplaySave(value: unknown): PendingSaveDeletionDisplaySave | null {
  if (!value || typeof value !== 'object') return null
  const save = value as Record<string, unknown>
  const note = typeof save.note === 'string' && save.note.trim().length > 0 ? save.note : null
  return {
    date: typeof save.date === 'string' ? save.date : null,
    note,
    sizeBytes:
      typeof save.sizeBytes === 'number' &&
      Number.isSafeInteger(save.sizeBytes) &&
      save.sizeBytes >= 0
        ? save.sizeBytes
        : null
  }
}

function validDateTimestamp(date: string | null): number | null {
  if (!date) return null
  const timestamp = Date.parse(date)
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * Creates a display-only view of the trusted pending snapshot without
 * changing its persisted order or any deletion authorization fields.
 * Persisted records may predate this field or be malformed, so normalize at
 * the renderer boundary before formatting individual entries.
 */
export function getPendingSaveDeletionDisplaySaves(
  displaySaves: unknown,
  expanded: boolean
): {
  saves: PendingSaveDeletionDisplaySave[]
  hasSaves: boolean
  hasMore: boolean
  totalCount: number
} {
  const normalizedSaves = Array.isArray(displaySaves)
    ? displaySaves
        .map(normalizeDisplaySave)
        .filter((save): save is PendingSaveDeletionDisplaySave => save !== null)
    : []
  const sortedSaves = normalizedSaves.sort((a, b) => {
    const aTimestamp = validDateTimestamp(a.date)
    const bTimestamp = validDateTimestamp(b.date)
    if (aTimestamp === null) return bTimestamp === null ? 0 : 1
    if (bTimestamp === null) return -1
    return bTimestamp - aTimestamp
  })
  const hasMore = sortedSaves.length > COLLAPSED_SAVE_LIMIT
  return {
    saves: expanded ? sortedSaves : sortedSaves.slice(0, COLLAPSED_SAVE_LIMIT),
    hasSaves: sortedSaves.length > 0,
    hasMore,
    totalCount: sortedSaves.length
  }
}
