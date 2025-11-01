// src/services/image-cache.ts
import { logger } from '../utils'
import { Config } from '../config'
import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

interface CacheEntry {
  mediaId: string
  pageIndex: number
  extension: string
  filePath: string
  cachedAt: number
  size: number
}

/**
 * 图片缓存服务
 * 基于文件系统的缓存，使用 media_id + 页码作为 key
 */
export class ImageCache {
  private cacheDir: string
  private indexFile: string
  private entries: Map<string, CacheEntry> = new Map()
  private maxCacheSize: number // 最大缓存大小（字节）
  private cacheTTL: number // 缓存过期时间（毫秒）

  constructor(private config: Config, baseDir: string) {
    this.cacheDir = path.resolve(baseDir, config.downloadPath, 'image-cache')
    this.indexFile = path.resolve(this.cacheDir, 'index.json')
    // 将 MB 转换为字节
    this.maxCacheSize = (config.cache.imageCacheMaxSize ?? 1000) * 1024 * 1024
    // 将小时转换为毫秒
    this.cacheTTL = (config.cache.imageCacheTTL ?? 24) * 60 * 60 * 1000
  }

  /**
   * 初始化缓存目录和索引
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
      await this.loadIndex()
      if (this.config.debug) {
        logger.info(`缓存目录已初始化: ${this.cacheDir}`)
      }
    } catch (error: any) {
      logger.warn(`缓存目录初始化失败: ${error?.message || String(error)}`)
    }
  }

  /**
   * 加载缓存索引
   */
  private async loadIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.indexFile, 'utf-8')
      const index = JSON.parse(data) as CacheEntry[]

      // 验证文件是否存在，清理无效条目
      const validEntries: CacheEntry[] = []
      for (const entry of index) {
        try {
          await fs.access(entry.filePath)
          // 检查是否过期
          const age = Date.now() - entry.cachedAt
          if (age < this.cacheTTL) {
            validEntries.push(entry)
            const key = this.getCacheKey(entry.mediaId, entry.pageIndex)
            this.entries.set(key, entry)
          } else {
            // 删除过期文件
            await fs.unlink(entry.filePath).catch(() => {})
          }
        } catch {
          // 文件不存在，跳过
        }
      }

      await this.saveIndex(validEntries)
      if (this.config.debug) {
        logger.info(`加载了 ${validEntries.length} 个有效缓存条目`)
      }
    } catch (error: any) {
      // 索引文件不存在或损坏，创建新的
      if ((error as any).code !== 'ENOENT') {
        logger.warn(`加载索引失败: ${error?.message || String(error)}`)
      }
      this.entries.clear()
    }
  }

  /**
   * 保存缓存索引
   */
  private async saveIndex(entries?: CacheEntry[]): Promise<void> {
    try {
      const data = JSON.stringify(entries || Array.from(this.entries.values()), null, 2)
      await fs.writeFile(this.indexFile, data, 'utf-8')
    } catch (error: any) {
      logger.warn(`保存索引失败: ${error?.message || String(error)}`)
    }
  }

  /**
   * 生成缓存 key
   */
  private getCacheKey(mediaId: string, pageIndex: number): string {
    return `${mediaId}-${pageIndex}`
  }

  /**
   * 获取缓存文件路径
   */
  private getCacheFilePath(mediaId: string, pageIndex: number, extension: string): string {
    // 使用哈希来避免路径过长问题
    const hash = createHash('md5').update(`${mediaId}-${pageIndex}`).digest('hex')
    const dir = path.resolve(this.cacheDir, hash.substring(0, 2))
    return path.resolve(dir, `${hash}.${extension}`)
  }

  /**
   * 从缓存获取图片
   */
  async get(mediaId: string, pageIndex: number): Promise<Buffer | null> {
    const key = this.getCacheKey(mediaId, pageIndex)
    const entry = this.entries.get(key)

    if (!entry) {
      return null
    }

    try {
      // 验证文件存在
      await fs.access(entry.filePath)

      // 检查是否过期
      const age = Date.now() - entry.cachedAt
      if (age >= this.cacheTTL) {
        // 过期，删除
        await this.delete(mediaId, pageIndex)
        return null
      }

      const buffer = await fs.readFile(entry.filePath)
      if (this.config.debug) {
        logger.info(`缓存命中: ${key}`)
      }
      return buffer
    } catch (error) {
      // 文件不存在，从索引中移除
      this.entries.delete(key)
      await this.saveIndex()
      return null
    }
  }

  /**
   * 保存图片到缓存
   */
  async set(mediaId: string, pageIndex: number, buffer: Buffer, extension: string): Promise<void> {
    if (!this.config.cache.enableImageCache) {
      return
    }

    try {
      const key = this.getCacheKey(mediaId, pageIndex)
      const filePath = this.getCacheFilePath(mediaId, pageIndex, extension)

      // 确保目录存在
      await fs.mkdir(path.dirname(filePath), { recursive: true })

      // 检查缓存大小，如果超过限制则清理
      await this.cleanupIfNeeded(buffer.length)

      // 写入文件
      await fs.writeFile(filePath, buffer)

      // 更新索引
      const entry: CacheEntry = {
        mediaId,
        pageIndex,
        extension,
        filePath,
        cachedAt: Date.now(),
        size: buffer.length
      }
      this.entries.set(key, entry)
      await this.saveIndex()

      if (this.config.debug) {
        logger.info(`已缓存: ${key} (${(buffer.length / 1024).toFixed(2)} KB)`)
      }
    } catch (error: any) {
      logger.warn(`保存缓存失败: ${error?.message || String(error)}`)
    }
  }

  /**
   * 删除缓存
   */
  async delete(mediaId: string, pageIndex: number): Promise<void> {
    const key = this.getCacheKey(mediaId, pageIndex)
    const entry = this.entries.get(key)

    if (entry) {
      try {
        await fs.unlink(entry.filePath)
      } catch {
        // 忽略删除失败
      }
      this.entries.delete(key)
      await this.saveIndex()
    }
  }

  /**
   * 清理缓存（如果超过大小限制）
   */
  private async cleanupIfNeeded(newSize: number): Promise<void> {
    // 计算当前缓存总大小
    let totalSize = 0
    for (const entry of this.entries.values()) {
      totalSize += entry.size
    }

    // 如果加上新文件会超过限制，清理最旧的缓存
    if (totalSize + newSize > this.maxCacheSize) {
      // 按时间排序，删除最旧的
      const sortedEntries = Array.from(this.entries.values())
        .sort((a, b) => a.cachedAt - b.cachedAt)

      const targetSize = this.maxCacheSize * 0.7 // 清理到 70%
      let currentSize = totalSize

      for (const entry of sortedEntries) {
        if (currentSize + newSize <= targetSize) {
          break
        }

        try {
          await fs.unlink(entry.filePath)
          this.entries.delete(this.getCacheKey(entry.mediaId, entry.pageIndex))
          currentSize -= entry.size
        } catch {
          // 忽略删除失败
        }
      }

      await this.saveIndex()
      if (this.config.debug) {
        logger.info(`已清理缓存，当前大小: ${(currentSize / 1024 / 1024).toFixed(2)} MB`)
      }
    }
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        await fs.unlink(entry.filePath)
      } catch {
        // 忽略删除失败
      }
    }
    this.entries.clear()
    await this.saveIndex()
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { count: number; size: number } {
    let totalSize = 0
    for (const entry of this.entries.values()) {
      totalSize += entry.size
    }
    return {
      count: this.entries.size,
      size: totalSize
    }
  }
}

