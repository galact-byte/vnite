export interface FileStat {
  size: number
  lastModified: string
  isDirectory: boolean
}

export interface WriteFileOptions {
  contentType?: string
}

export interface RemoteStorageAdapter {
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<FileStat | null>
  readFile(path: string, format: 'text' | 'binary'): Promise<string | Buffer>
  writeFile(path: string, data: string | Buffer, options?: WriteFileOptions): Promise<void>
  deleteFile(path: string): Promise<void>
  list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>
  mkdir(path: string): Promise<void>
}
