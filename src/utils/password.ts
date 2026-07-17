/**
 * Storage format marker for passwords encrypted with Electron safeStorage.
 * The actual encryption/decryption only happens in the main process; the
 * renderer merely needs to recognize the format to adjust its UI.
 */
export const ENCRYPTED_PASSWORD_PREFIX = 'enc:v1:'

export function isEncryptedPassword(value: string): boolean {
  return value.startsWith(ENCRYPTED_PASSWORD_PREFIX)
}
