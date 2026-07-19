import { DocChange, type DocChangeResult } from '@appTypes/models'
import { create } from 'zustand'
import { ipcManager } from '~/app/ipc'

/**
 * Generic Database Synchronization Functions - Synchronize data to a specified database
 *
 * @param dbName Database name
 * @param docId Document ID
 * @param data Documentation data
 * @returns Database normalization metadata.
 */
export async function syncTo<T extends Record<string, any>>(
  dbName: string,
  docId: string,
  data: T | '#delete'
): Promise<DocChangeResult> {
  // Creating Change Objects
  const change: DocChange = {
    dbName,
    docId,
    data,
    timestamp: Date.now()
  }

  try {
    return await ipcManager.invoke('db:doc-changed', change)
  } catch (error) {
    console.error(`[Sync] sync failure ${dbName}/${docId}:`, error)
    throw error
  }
}

interface BackupState {
  isBackingUp: boolean
  setBackingUp: (value: boolean) => void
}

export const useBackupStore = create<BackupState>((set) => ({
  isBackingUp: false,
  setBackingUp: (value) => set({ isBackingUp: value })
}))
