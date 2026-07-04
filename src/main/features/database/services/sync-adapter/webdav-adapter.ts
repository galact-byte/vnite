import { createClient, WebDAVClient } from 'webdav'
import type { RemoteStorageAdapter } from './types'
import { configLocalDocs } from '@appTypes/models'

type WebDAVConfig = configLocalDocs['sync']['webdavConfig']

export class WebDAVAdapter implements RemoteStorageAdapter {
  private client: WebDAVClient

  constructor(config: WebDAVConfig) {
    this.client = createClient(config.url, {
      username: config.auth.username,
      password: config.auth.password
    })
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await this.client.exists(path)) === true
    } catch {
      return false
    }
  }

  async readFile(path: string, format: 'text' | 'binary'): Promise<string | Buffer> {
    const content = await this.client.getFileContents(path, { format })
    return content as string | Buffer
  }

  async writeFile(path: string, data: string | Buffer): Promise<void> {
    await this.client.putFileContents(path, data)
  }

  async deleteFile(path: string): Promise<void> {
    await this.client.deleteFile(path)
  }

  async list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const contents = await this.client.getDirectoryContents(path)
    return (contents as Array<any>).map((item) => ({
      name: item.basename,
      isDirectory: item.type === 'directory'
    }))
  }

  async mkdir(path: string): Promise<void> {
    await this.client.createDirectory(path)
  }
}
