// 内存缓存实现，用于API响应缓存
export interface CacheConfig {
  maxSize?: number // 最大缓存条目数
  defaultTTL?: number // 默认过期时间（毫秒）
}

// 支持自动过期和大小限制的内存缓存类
export class InMemoryCache {
  private store = new Map<string, { value: any; timer?: NodeJS.Timeout; createdAt: number }>()
  private maxSize: number
  private defaultTTL: number

  constructor(config: CacheConfig = {}) {
    this.maxSize = config.maxSize || 1000
    this.defaultTTL = config.defaultTTL || 600000 // 默认10分钟
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key)?.value
  }

  async set(key: string, value: any, maxAge?: number): Promise<void> {
    // 缓存已满则清理最旧条目
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      this.evictOldest()
    }

    const existing = this.store.get(key)
    if (existing?.timer) clearTimeout(existing.timer)

    const ttl = maxAge || this.defaultTTL
    const timer = setTimeout(() => this.store.delete(key), ttl)

    this.store.set(key, { value, timer, createdAt: Date.now() })
  }

  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.store.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt
        oldestKey = key
      }
    }

    if (oldestKey) {
      const entry = this.store.get(oldestKey)
      if (entry?.timer) clearTimeout(entry.timer)
      this.store.delete(oldestKey)
    }
  }

  clear(): void {
    for (const { timer } of this.store.values()) {
      if (timer) clearTimeout(timer)
    }
    this.store.clear()
  }

  getStats() {
    return {
      size: this.store.size,
      maxSize: this.maxSize,
    }
  }

  dispose() {
    this.clear()
  }
}

import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { logger } from '../utils'
import { Config } from '../config'

interface CacheEntry {
  galleryId: string
  mediaId: string
  pageIndex: number
  extension: string
  filePath: string
  cachedAt: number
  lastAccessed: number
  accessCount: number
  size: number
  isThumb?: boolean
}

// 缓存基类，提供通用的 LRU 清理、索引管理功能
abstract class BaseCache<T extends { galleryId: string; filePath: string; cachedAt: number; lastAccessed: number; accessCount: number; size: number }> {
  protected cacheDir: string
  protected indexFile: string
  protected entries: Map<string, T> = new Map()
  protected maxCacheSize: number
  protected cacheTTL: number
  protected indexDirty: boolean = false
  protected saveTimer: NodeJS.Timeout | null = null

  constructor(protected config: Config, baseDir: string, cacheName: string, maxSizeConfig: number, ttlConfig: number) {
    this.cacheDir = path.resolve(baseDir, config.downloadPath, cacheName)
    this.indexFile = path.resolve(this.cacheDir, 'index.json')
    this.maxCacheSize = maxSizeConfig
    this.cacheTTL = ttlConfig
  }

  // 清理定时器
  protected clearTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  // 调度索引保存
  protected scheduleSaveIndex(): void {
    this.indexDirty = true
    this.clearTimer()
    this.saveTimer = setTimeout(() => {
      if (this.indexDirty) this.saveIndex().catch((err) => logger.warn(`延迟保存索引失败: ${err.message}`))
      this.saveTimer = null
    }, 5000)
  }

  // LRU 清理机制
  protected async cleanupIfNeeded(newSize: number): Promise<void> {
    let totalSize = Array.from(this.entries.values()).reduce((sum, entry) => sum + entry.size, 0)

    if (totalSize + newSize > this.maxCacheSize) {
      const sortedEntries = Array.from(this.entries.values()).sort((a, b) => {
        const scoreA = a.lastAccessed + a.accessCount * 3600000
        const scoreB = b.lastAccessed + b.accessCount * 3600000
        return scoreA - scoreB
      })

      const targetSize = this.maxCacheSize * 0.7
      let cleanedCount = 0
      for (const entry of sortedEntries) {
        if (totalSize + newSize <= targetSize) break
        try {
          await fs.unlink(entry.filePath)
          this.deleteEntry(entry)
          totalSize -= entry.size
          cleanedCount++
        } catch {
          // 忽略文件不存在错误
        }
      }
      if (this.config.debug && cleanedCount > 0) logger.info(`LRU 清理: 删除了 ${cleanedCount} 个条目`)
      this.scheduleSaveIndex()
    }
  }

  // 删除条目的抽象方法
  protected abstract deleteEntry(entry: T): void

  protected async saveIndex(entries?: T[]): Promise<void> {
    try {
      const data = JSON.stringify(entries || Array.from(this.entries.values()), null, 2)
      await fs.writeFile(this.indexFile, data, 'utf-8')
      this.indexDirty = false
    } catch (error) {
      logger.warn(`保存索引失败: ${error.message}`)
    }
  }

  async clear(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        await fs.unlink(entry.filePath)
      } catch {
        // 忽略文件不存在错误
      }
    }
    this.entries.clear()
    this.scheduleSaveIndex()
  }

  async clearAll(): Promise<void> {
    try {
      await this.clear()
      await fs.rm(this.cacheDir, { recursive: true, force: true })
      if (this.config.debug) logger.info(`${this.cacheDir} 已清理`)
    } catch (error) {
      logger.warn(`清理缓存目录失败: ${error.message}`)
    }
  }

  getStats(): { count: number; size: number } {
    const totalSize = Array.from(this.entries.values()).reduce((sum, entry) => sum + entry.size, 0)
    return { count: this.entries.size, size: totalSize }
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (this.indexDirty) await this.saveIndex()
  }

  dispose(): void {
    this.clearTimer()
    this.entries.clear()
    this.indexDirty = false
    if (this.config.debug) logger.info(`${this.cacheDir} 已清理`)
  }
}

export class ImageCache extends BaseCache<CacheEntry> {
  constructor(protected config: Config, baseDir: string) {
    const maxSize = (config.cache.imageCacheMaxSize ?? 1000) * 1024 * 1024
    const ttl = (config.cache.imageCacheTTL ?? 24) * 60 * 60 * 1000
    super(config, baseDir, 'image-cache', maxSize, ttl)
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
      await this.loadIndex()
      if (this.config.debug) logger.info(`图片缓存已初始化: ${this.cacheDir}`)
    } catch (error) {
      logger.warn(`缓存初始化失败: ${error.message}`)
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.indexFile, 'utf-8')
      const index = JSON.parse(data) as CacheEntry[]
      const validEntries: CacheEntry[] = []

      for (const entry of index) {
        try {
          await fs.access(entry.filePath)
          if (Date.now() - entry.cachedAt < this.cacheTTL) {
            entry.lastAccessed = entry.lastAccessed || entry.cachedAt
            entry.accessCount = entry.accessCount || 1
            validEntries.push(entry)
            this.entries.set(this.getCacheKey(entry.galleryId, entry.mediaId, entry.pageIndex, entry.isThumb), entry)
          } else {
            await fs.unlink(entry.filePath).catch(() => {})
          }
        } catch {
          // 忽略索引项加载错误
        }
      }

      await this.saveIndex(validEntries)
      if (this.config.debug) logger.info(`加载 ${validEntries.length} 个图片缓存条目`)
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`加载索引失败: ${error.message}`)
      this.entries.clear()
    }
  }

  private getCacheKey(galleryId: string, mediaId: string, pageIndex: number, isThumb = false, processed = false): string {
    return `${galleryId}-${mediaId}-${pageIndex}${isThumb ? '-thumb' : ''}${processed ? '-processed' : ''}`
  }

  private getCacheFilePath(galleryId: string, mediaId: string, pageIndex: number, extension: string, isThumb = false, processed = false): string {
    const galleryIdStr = String(galleryId)
    const dir = path.resolve(this.cacheDir, galleryIdStr)
    const suffix = `${isThumb ? '-thumb' : ''}${processed ? '-processed' : ''}`
    const filename = `${galleryIdStr}-${pageIndex}${suffix}.${extension}`
    return path.resolve(dir, filename)
  }

  async get(galleryId: string, mediaId: string, pageIndex: number, isThumb = false): Promise<Buffer | null> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, isThumb)
    const entry = this.entries.get(key)
    if (!entry) return null

    try {
      await fs.access(entry.filePath)
      if (Date.now() - entry.cachedAt >= this.cacheTTL) {
        await this.delete(galleryId, mediaId, pageIndex, isThumb)
        return null
      }
      const buffer = await fs.readFile(entry.filePath)
      entry.lastAccessed = Date.now()
      entry.accessCount++
      this.scheduleSaveIndex()
      if (this.config.debug) logger.info(`缓存命中: ${key}`)
      return buffer
    } catch {
      this.entries.delete(key)
      this.scheduleSaveIndex()
      return null
    }
  }

  async set(galleryId: string, mediaId: string, pageIndex: number, buffer: Buffer, extension: string, isThumb = false): Promise<void> {
    if (!this.config.cache.enableImageCache) return

    try {
      const key = this.getCacheKey(galleryId, mediaId, pageIndex, isThumb)
      const filePath = this.getCacheFilePath(galleryId, mediaId, pageIndex, extension, isThumb)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await this.cleanupIfNeeded(buffer.length)
      await fs.writeFile(filePath, buffer)

      const entry: CacheEntry = {
        galleryId,
        mediaId,
        pageIndex,
        extension,
        filePath,
        cachedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        size: buffer.length,
        isThumb,
      }
      this.entries.set(key, entry)
      this.scheduleSaveIndex()
      if (this.config.debug) logger.debug(`缓存已保存: ${key}`)
    } catch (error) {
      logger.warn(`保存缓存失败: ${error.message}`)
    }
  }

  async getProcessed(galleryId: string, mediaId: string, pageIndex: number): Promise<{ buffer: Buffer; extension: string } | null> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, false, true)
    const entry = this.entries.get(key)
    if (!entry) return null

    try {
      await fs.access(entry.filePath)
      if (Date.now() - entry.cachedAt >= this.cacheTTL) {
        await this.deleteProcessed(galleryId, mediaId, pageIndex)
        return null
      }
      const buffer = await fs.readFile(entry.filePath)
      entry.lastAccessed = Date.now()
      entry.accessCount++
      this.scheduleSaveIndex()
      return { buffer, extension: entry.extension }
    } catch {
      this.entries.delete(key)
      this.scheduleSaveIndex()
      return null
    }
  }

  async setProcessed(galleryId: string, mediaId: string, pageIndex: number, buffer: Buffer, extension: string): Promise<void> {
    if (!this.config.cache.enableImageCache) return

    try {
      const key = this.getCacheKey(galleryId, mediaId, pageIndex, false, true)
      const filePath = this.getCacheFilePath(galleryId, mediaId, pageIndex, extension, false, true)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await this.cleanupIfNeeded(buffer.length)
      await fs.writeFile(filePath, buffer)

      const entry: CacheEntry = {
        galleryId,
        mediaId,
        pageIndex,
        extension,
        filePath,
        cachedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        size: buffer.length,
        isThumb: false,
      }
      this.entries.set(key, entry)
      this.scheduleSaveIndex()
      if (this.config.debug) logger.debug(`处理缓存已保存: ${key}`)
    } catch (error) {
      logger.warn(`保存处理缓存失败: ${error.message}`)
    }
  }

  async deleteProcessed(galleryId: string, mediaId: string, pageIndex: number): Promise<void> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, false, true)
    const entry = this.entries.get(key)
    if (entry) {
      try {
        await fs.unlink(entry.filePath)
      } catch {
        // 忽略文件不存在错误
      }
      this.entries.delete(key)
      this.scheduleSaveIndex()
    }
  }

  async delete(galleryId: string, mediaId: string, pageIndex: number, isThumb = false): Promise<void> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, isThumb)
    const entry = this.entries.get(key)
    if (entry) {
      try {
        await fs.unlink(entry.filePath)
      } catch {
        // 忽略文件不存在错误
      }
      this.entries.delete(key)
      this.scheduleSaveIndex()
    }
  }

  async clearGallery(galleryId: string): Promise<void> {
    const keysToDelete: string[] = []
    for (const [key, entry] of this.entries.entries()) {
      if (entry.galleryId === galleryId) {
        try {
          await fs.unlink(entry.filePath)
        } catch {
          // 忽略文件不存在错误
        }
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) this.entries.delete(key)
    if (keysToDelete.length > 0) {
      this.scheduleSaveIndex()
      if (this.config.debug) logger.info(`清理画廊 ${galleryId} 的 ${keysToDelete.length} 个缓存条目`)
    }
  }

  protected deleteEntry(entry: CacheEntry): void {
    this.entries.delete(this.getCacheKey(entry.galleryId, entry.mediaId, entry.pageIndex, entry.isThumb))
  }
}

interface PdfCacheEntry {
  galleryId: string
  filePath: string
  fileName: string
  cachedAt: number
  lastAccessed: number
  accessCount: number
  size: number
  password?: string
}

export class PdfCache extends BaseCache<PdfCacheEntry> {
  constructor(protected config: Config, baseDir: string) {
    const maxSize = config.cache.pdfCacheMaxSize * 1024 * 1024
    const ttl = config.cache.pdfCacheTTL === 0 ? Infinity : config.cache.pdfCacheTTL * 60 * 60 * 1000
    super(config, baseDir, 'pdf-cache', maxSize, ttl)
  }

  async initialize(): Promise<void> {
    if (!this.config.cache.enablePdfCache) return

    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
      await this.loadIndex()
      if (this.config.debug) logger.info(`PDF 缓存已初始化: ${this.cacheDir}`)
    } catch (error) {
      logger.warn(`PDF 缓存初始化失败: ${error.message}`)
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.indexFile, 'utf-8')
      const index = JSON.parse(data) as PdfCacheEntry[]
      const validEntries: PdfCacheEntry[] = []

      for (const entry of index) {
        try {
          await fs.access(entry.filePath)
          const isExpired = this.cacheTTL !== Infinity && (Date.now() - entry.cachedAt >= this.cacheTTL)

          if (!isExpired) {
            entry.lastAccessed = entry.lastAccessed || entry.cachedAt
            entry.accessCount = entry.accessCount || 1
            validEntries.push(entry)
            this.entries.set(this.getCacheKey(entry.galleryId, entry.password), entry)
          } else {
            await fs.unlink(entry.filePath).catch(() => {})
          }
        } catch {
          // 忽略索引项加载错误
        }
      }

      await this.saveIndex(validEntries)
      if (this.config.debug) logger.info(`加载 ${validEntries.length} 个 PDF 缓存条目`)
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`加载 PDF 索引失败: ${error.message}`)
      this.entries.clear()
    }
  }

  private getCacheKey(galleryId: string, password?: string): string {
    const galleryIdStr = String(galleryId)
    return password ? `${galleryIdStr}-${createHash('md5').update(password).digest('hex').substring(0, 8)}` : galleryIdStr
  }

  private getCacheFilePath(galleryId: string, password?: string): string {
    const galleryIdStr = String(galleryId)
    const filename = password
      ? `${galleryIdStr}-${createHash('md5').update(password).digest('hex').substring(0, 8)}.pdf`
      : `${galleryIdStr}.pdf`
    return path.resolve(this.cacheDir, filename)
  }

  async get(galleryId: string, password?: string): Promise<string | null> {
    if (!this.config.cache.enablePdfCache) return null

    const key = this.getCacheKey(galleryId, password)
    const entry = this.entries.get(key)
    if (!entry) return null

    try {
      await fs.access(entry.filePath)
      const isExpired = this.cacheTTL !== Infinity && (Date.now() - entry.cachedAt >= this.cacheTTL)

      if (isExpired) {
        await this.delete(galleryId, password)
        return null
      }

      entry.lastAccessed = Date.now()
      entry.accessCount++
      this.scheduleSaveIndex()
      if (this.config.debug) logger.info(`PDF 缓存命中: ${galleryId}`)
      return entry.filePath
    } catch {
      this.entries.delete(key)
      this.scheduleSaveIndex()
      return null
    }
  }

  async set(galleryId: string, sourcePath: string, fileName: string, password?: string): Promise<void> {
    if (!this.config.cache.enablePdfCache) return

    try {
      const key = this.getCacheKey(galleryId, password)
      const filePath = this.getCacheFilePath(galleryId, password)

      const stat = await fs.stat(sourcePath)
      await this.cleanupIfNeeded(stat.size)

      await fs.copyFile(sourcePath, filePath)

      const entry: PdfCacheEntry = {
        galleryId,
        filePath,
        fileName,
        cachedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        size: stat.size,
        password,
      }
      this.entries.set(key, entry)
      this.scheduleSaveIndex()
      if (this.config.debug) logger.info(`PDF 已缓存: ${galleryId} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
    } catch (error) {
      logger.warn(`保存 PDF 缓存失败: ${error.message}`)
    }
  }

  async delete(galleryId: string, password?: string): Promise<void> {
    const key = this.getCacheKey(galleryId, password)
    const entry = this.entries.get(key)
    if (entry) {
      try {
        await fs.unlink(entry.filePath)
      } catch {
        // 忽略文件不存在错误
      }
      this.entries.delete(key)
      this.scheduleSaveIndex()
    }
  }

  protected deleteEntry(entry: PdfCacheEntry): void {
    this.entries.delete(this.getCacheKey(entry.galleryId, entry.password))
  }
}

