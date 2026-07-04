import { createClient, WebDAVClient } from 'webdav'
import type { RemoteStorageAdapter, FileStat, WriteFileOptions } from './types'
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

  async stat(path: string): Promise<FileStat | null> {
    try {
      const result = await this.client.stat(path)
      if (!result) return null
      // webdav stat returns different shapes depending on the server
      const data = result.data ?? result
      return {
        size: data.size ?? data['content-length'] ?? data.props?.getcontentlength ?? 0,
        lastModified:
          data.lastmod ??
          data.mtime ??
          data.props?.getlastmodified ??
          new Date().toISOString(),
        isDirectory: data.type === 'directory'
      }
    } catch {
      return null
    }
  }

  async readFile(path: string, format: 'text' | 'binary'): Promise<string | Buffer> {
    const content = await this.client.getFileContents(path, { format })
    return content as string | Buffer
  }

  async writeFile(
    path: string,
    data: string | Buffer,
    options?: WriteFileOptions
  ): Promise<void> {
    const putOptions: any = {}
    if (options?.contentType) {
      putOptions.contentType = options.contentType
    }
    if (typeof data === 'string') {
      await this.client.putFileContents(path, data, putOptions)
    } else {
      // For binary data, the webdav client needs the buffer directly
      await this.client.putFileContents(path, data, putOptions)
    }
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
