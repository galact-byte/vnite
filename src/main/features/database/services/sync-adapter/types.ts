export interface RemoteStorageAdapter {
  exists(path: string): Promise<boolean>
  readFile(path: string, format: 'text' | 'binary'): Promise<string | Buffer>
  writeFile(path: string, data: string | Buffer): Promise<void>
  deleteFile(path: string): Promise<void>
  list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>
  mkdir(path: string): Promise<void>
}
