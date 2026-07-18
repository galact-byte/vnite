/**
 * 同步空间转换时,某一侧存档(本地或云端)的客观元数据。
 * 仅用于弹窗"摆事实",不含任何推荐/优劣判断。
 */
export interface SaveSyncSideMeta {
  /** 总字节数(目录为递归累加,单文件为自身大小) */
  sizeBytes: number
  /** 最后修改时间(目录取递归内最新 mtime,单文件取自身) */
  mtimeMs: number
  /** 文件数(目录为递归文件数,单文件为 1) */
  fileCount: number
  /** 触及扫描上限时为 true,此时 sizeBytes/fileCount 为下限值而非精确值 */
  truncated?: boolean
}

/** 用户在同步空间冲突弹窗中的决策。 */
export type SaveSyncResolution = 'use-cloud' | 'use-local'

/**
 * 探测某个存档路径转换到同步空间时的状态。
 * - already-in-sync:已是指向同步空间的链接,无需转换。
 * - fresh:云端无该游戏条目,直接转换即可。
 * - conflict:云端已有条目,需用户在两侧元数据间二选一。
 */
export type SaveSyncProbeResult =
  | { status: 'already-in-sync' }
  | { status: 'fresh' }
  | { status: 'conflict'; local: SaveSyncSideMeta; cloud: SaveSyncSideMeta }

export interface CouchDBConfig {
  url: string
  adminUsername: string
  adminPassword: string
}

export interface CouchDBCredentials {
  username: string
  password: string
}

export interface AuthResult {
  success: boolean
  error?: string
}

export interface SyncCredentialsResponse {
  success: boolean
  username?: string
  password?: string
  dbName?: string
  couchdbUrl?: string
  error?: string
}

export interface StoredCredentials {
  username: string
  couchdbUsername: string
  couchdbPassword: string
}

export interface AuthCallbackData {
  code: string
  state?: string
}

export interface AuthentikUser {
  sub: string
  name: string
  email: string
  preferred_username: string
  groups: string[]
  role?: string
  avatar?: string
  couchdb?: {
    username: string
    password: string
    url: string
    databases: {
      config: { dbName: string }
      game: { dbName: string }
      gameCollection: { dbName: string }
    }
  }
}
