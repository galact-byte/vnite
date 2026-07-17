import { safeStorage } from 'electron'
import log from 'electron-log/main'
import { ENCRYPTED_PASSWORD_PREFIX, isEncryptedPassword } from '@appUtils'
import { ConfigDBManager } from '~/core/database'

/**
 * Encrypt a plaintext password for storage using Electron safeStorage
 * (DPAPI on Windows / Keychain on macOS / libsecret on Linux).
 *
 * Falls back to returning the plaintext unchanged when the input is empty,
 * already encrypted, or safeStorage is unavailable (e.g. some Linux setups) —
 * in that case behavior matches the previous plaintext storage.
 */
export function encryptPasswordForStorage(plain: string): string {
  if (!plain || isEncryptedPassword(plain)) return plain
  try {
    if (!safeStorage.isEncryptionAvailable()) return plain
    return ENCRYPTED_PASSWORD_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch (error) {
    log.warn('[PasswordCrypto] Encryption failed, storing plaintext:', error)
    return plain
  }
}

/**
 * Decrypt a stored password. Plaintext values (legacy configs, or written
 * while safeStorage was unavailable) pass through unchanged. Returns an
 * empty string when decryption fails (e.g. the config was copied from
 * another machine and DPAPI cannot decrypt it) so callers surface a
 * "missing password" error instead of crashing.
 */
export function decryptStoredPassword(stored: string): string {
  if (!stored || !isEncryptedPassword(stored)) return stored
  try {
    const encrypted = Buffer.from(stored.slice(ENCRYPTED_PASSWORD_PREFIX.length), 'base64')
    return safeStorage.decryptString(encrypted)
  } catch (error) {
    log.error('[PasswordCrypto] Failed to decrypt stored password:', error)
    return ''
  }
}

/**
 * One-shot startup check: encrypt a legacy plaintext WebDAV password in
 * config-local. Runs unconditionally on every launch (cheap single read)
 * rather than through the run-once migration framework, because a backup
 * restore can re-introduce plaintext at any time.
 */
export async function encryptStoredWebdavPasswordIfNeeded(): Promise<void> {
  try {
    const stored = await ConfigDBManager.getConfigLocalValue('sync.webdavConfig.auth.password')
    if (!stored || isEncryptedPassword(stored)) return
    const encrypted = encryptPasswordForStorage(stored)
    if (encrypted !== stored) {
      await ConfigDBManager.setConfigLocalValue('sync.webdavConfig.auth.password', encrypted)
      log.info('[PasswordCrypto] Migrated plaintext WebDAV password to encrypted storage')
    }
  } catch (error) {
    log.warn('[PasswordCrypto] WebDAV password migration failed:', error)
  }
}
