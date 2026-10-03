/**
 * 缓存层，三类缓存共用一个 LRU + TTL 基类：
 *
 * - InMemoryCache：接口响应，进程内，带惰性过期与定期清扫
 * - ImageCache：页面图片与处理后图片，落盘，按体积做 LRU
 * - PdfCache：生成的 PDF，落盘，按体积做 LRU
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { logger } from '../utils'
import type { Config } from '../config'

export interface CacheConfig {
  maxSize?: number // 最大缓存条目数
  defaultTTL?: number // 默认过期时间（毫秒）
}

/** 兜底清扫周期：惰性过期之外，定期回收无人访问的过期条目 */
const SWEEP_INTERVAL_MS = 60_000

/**
 * LRU + TTL 内存缓存。
 *
 * 性能要点：
 *   - 不再为每个条目创建 setTimeout：条目数达数百时会有同等数量的定时器，
 *     现在改为 get() 时惰性判过期 + 单个 unref 定时器定期清扫；
 *   - 利用 Map 的插入顺序实现 O(1) 淘汰（原实现每次插入都全量扫描找最旧条目）；
 *   - get() 命中后把条目重新插入到 Map 末尾，从而具备真正的 LRU 语义。
 */
export class InMemoryCache {
  private store = new Map<string, { value: any; expiresAt: number }>()
  private maxSize: number
  private defaultTTL: number
  private hitCount: number = 0
  private missCount: number = 0
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(config: CacheConfig = {}) {
    this.maxSize = config.maxSize || 1000
    this.defaultTTL = config.defaultTTL || 600000 // 默认10分钟
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key)
    if (!entry) {
      this.missCount++
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      this.missCount++
      return undefined
    }
    // 触摸：移到 Map 末尾，维持 LRU 顺序
    this.store.delete(key)
    this.store.set(key, entry)
    this.hitCount++
    return entry.value
  }

  async set(key: string, value: any, maxAge?: number): Promise<void> {
    const existing = this.store.get(key)
    if (existing) {
      // 先删除再插入，保证新条目位于 Map 末尾
      this.store.delete(key)
    } else if (this.store.size >= this.maxSize) {
      this.evictOldest()
    }

    const ttl = maxAge || this.defaultTTL
    this.store.set(key, { value, expiresAt: Date.now() + ttl })
  }

  /** Map 的第一个键即最久未使用的条目 */
  private evictOldest(): void {
    const oldest = this.store.keys().next()
    if (!oldest.done) this.store.delete(oldest.value)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key)
    }
  }

  clear(): void {
    this.store.clear()
  }

  getStats() {
    const totalRequests = this.hitCount + this.missCount
    const hitRate = totalRequests > 0 ? (this.hitCount / totalRequests * 100).toFixed(2) : '0.00'
    return {
      size: this.store.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: `${hitRate}%`,
    }
  }

  dispose() {
    this.clear()
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}


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
  /** 非空表示已处理缓存，值为编码参数指纹（键与文件名都带 -processed-<指纹> 后缀） */
  processed?: string
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
  // 统计信息
  protected hitCount: number = 0
  protected missCount: number = 0
  protected cleanupCount: number = 0
  protected totalCleanedEntries: number = 0
  // 并发锁
  private saveLock: Promise<void> | null = null
  private cleanupLock: Promise<void> | null = null

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

  // LRU 清理机制（增量清理，带并发保护）
  protected async cleanupIfNeeded(newSize: number): Promise<void> {
    // 并发保护：如果正在清理，等待完成
    if (this.cleanupLock) {
      await this.cleanupLock
      return
    }

    let totalSize = Array.from(this.entries.values()).reduce((sum, entry) => sum + entry.size, 0)

    if (totalSize + newSize <= this.maxCacheSize) return

    // 设置清理锁
    this.cleanupLock = this.performCleanup(totalSize, newSize)
    try {
      await this.cleanupLock
    } finally {
      this.cleanupLock = null
    }
  }

  private async performCleanup(currentSize: number, newSize: number): Promise<void> {
    let totalSize = currentSize
    this.cleanupCount++

    // 优化的 LRU 算法：计算清理优先级分数（越小越应该清理）
    const entriesWithScore = Array.from(this.entries.values()).map(entry => ({
      entry,
      score: this.calculateLRUScore(entry),
    }))

    // 仅排序需要清理的部分（增量排序）
    entriesWithScore.sort((a, b) => a.score - b.score)

    const targetSize = this.maxCacheSize * 0.7
    let cleanedCount = 0

    for (const { entry } of entriesWithScore) {
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

    this.totalCleanedEntries += cleanedCount
    if (this.config.debug && cleanedCount > 0) {
      logger.info(`LRU 清理: 删除了 ${cleanedCount} 个条目，释放 ${((currentSize - totalSize) / 1024 / 1024).toFixed(2)} MB`)
    }
    this.scheduleSaveIndex()
  }

  // 计算 LRU 评分（分数越低越应该被清理）
  private calculateLRUScore(entry: T): number {
    const now = Date.now()
    const age = now - entry.cachedAt // 年龄（毫秒）
    const idleTime = now - entry.lastAccessed // 空闲时间（毫秒）
    const accessFrequency = entry.accessCount

    // 综合评分：空闲时间权重 40%，年龄 30%，访问频率 30%
    return idleTime * 0.4 + age * 0.3 - accessFrequency * 3600000 * 0.3
  }

  // 删除条目的抽象方法
  protected abstract deleteEntry(entry: T): void

  protected async saveIndex(entries?: T[]): Promise<void> {
    // 并发保护：如果正在保存，等待完成
    if (this.saveLock) {
      await this.saveLock
      return
    }

    this.saveLock = this.performSaveIndex(entries)
    try {
      await this.saveLock
    } finally {
      this.saveLock = null
    }
  }

  private async performSaveIndex(entries?: T[]): Promise<void> {
    try {
      const data = JSON.stringify(entries || Array.from(this.entries.values()), null, 2)
      // 原子替换：先写临时文件再 rename。直接覆盖时若进程被杀或恰好被读到，
      // 索引会变成半截 JSON，loadIndex 失败后会清空全部索引，
      // 而磁盘上的缓存文件又只靠索引回收，于是变成永久泄漏。
      const tmpFile = `${this.indexFile}.tmp`
      try {
        await fs.writeFile(tmpFile, data, 'utf-8')
        await fs.rename(tmpFile, this.indexFile)
      } catch (renameError) {
        // 少数环境（目标文件被占用）rename 会失败，退回直接写入
        await fs.writeFile(this.indexFile, data, 'utf-8').catch(() =>
          logger.warn(`写入缓存索引失败: ${(renameError as Error).message}`),
        )
        await fs.rm(tmpFile, { force: true }).catch(() => undefined)
      }
      this.indexDirty = false
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`保存索引失败: ${err.message}`)
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
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`清理缓存目录失败: ${err.message}`)
    }
  }

  getStats(): { count: number; size: number; hitCount: number; missCount: number; hitRate: string; cleanupCount: number; totalCleanedEntries: number } {
    const totalSize = Array.from(this.entries.values()).reduce((sum, entry) => sum + entry.size, 0)
    const totalRequests = this.hitCount + this.missCount
    const hitRate = totalRequests > 0 ? (this.hitCount / totalRequests * 100).toFixed(2) : '0.00'
    return {
      count: this.entries.size,
      size: totalSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: `${hitRate}%`,
      cleanupCount: this.cleanupCount,
      totalCleanedEntries: this.totalCleanedEntries,
    }
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (this.indexDirty) await this.saveIndex()
  }

  dispose(): void {
    this.clearTimer()
    // 修复：dispose 时强制保存索引，防止数据丢失
    if (this.indexDirty) {
      this.saveIndex().catch((err) => logger.warn(`dispose 时保存索引失败: ${err.message}`))
    }
    this.entries.clear()
    this.indexDirty = false
    // 清理并发锁
    this.saveLock = null
    this.cleanupLock = null
    if (this.config.debug) logger.info(`${this.cacheDir} 已释放`)
  }
}

export class ImageCache extends BaseCache<CacheEntry> {
  constructor(protected config: Config, baseDir: string) {
    const maxSize = (config.cache.imageCacheMaxSize ?? 1024) * 1024 * 1024
    // 与 PDF 缓存一致：0 表示永久保存。此前直接乘算得到 0，
    // 会让所有条目一写入就判定为过期（缓存永远不命中），与配置描述相反。
    const ttl = config.cache.imageCacheTTL === 0 ? Infinity : config.cache.imageCacheTTL * 60 * 60 * 1000
    super(config, baseDir, 'image-cache', maxSize, ttl)
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
      await this.loadIndex()
      if (this.config.debug) logger.info(`图片缓存已初始化: ${this.cacheDir}`)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`缓存初始化失败: ${err.message}`)
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
            // 早期索引里 processed 是布尔，现在改为参数指纹；旧值统一视作 legacy
            const rawProcessed = entry.processed as unknown
            if (typeof rawProcessed === 'boolean') entry.processed = rawProcessed ? 'legacy' : undefined
            validEntries.push(entry)
            this.entries.set(
              this.getCacheKey(entry.galleryId, entry.mediaId, entry.pageIndex, entry.isThumb, entry.processed),
              entry,
            )
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
      const err = error as any
      if (err.code !== 'ENOENT') {
        const errMsg = err instanceof Error ? err.message : String(error)
        logger.warn(`加载索引失败: ${errMsg}`)
      }
      this.entries.clear()
    }
  }

  private getCacheKey(galleryId: string, mediaId: string, pageIndex: number, isThumb = false, processed?: string): string {
    // 确保 galleryId 为字符串类型（防御性编程）
    const gidStr = String(galleryId)
    const midStr = String(mediaId)
    return `${gidStr}-${midStr}-${pageIndex}${isThumb ? '-thumb' : ''}${processed ? `-processed-${processed}` : ''}`
  }

  private getCacheFilePath(galleryId: string, _mediaId: string, pageIndex: number, extension: string, isThumb = false, processed?: string): string {
    const galleryIdStr = String(galleryId)
    const dir = path.resolve(this.cacheDir, galleryIdStr)
    const suffix = `${isThumb ? '-thumb' : ''}${processed ? `-processed-${processed}` : ''}`
    const filename = `${galleryIdStr}-${pageIndex}${suffix}.${extension}`
    return path.resolve(dir, filename)
  }

  async get(galleryId: string, mediaId: string, pageIndex: number, isThumb = false): Promise<Buffer | null> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, isThumb)
    const entry = this.entries.get(key)
    if (!entry) {
      this.missCount++
      return null
    }

    try {
      await fs.access(entry.filePath)
      if (Date.now() - entry.cachedAt >= this.cacheTTL) {
        await this.delete(galleryId, mediaId, pageIndex, isThumb)
        this.missCount++
        return null
      }
      const buffer = await fs.readFile(entry.filePath)
      entry.lastAccessed = Date.now()
      entry.accessCount++
      this.hitCount++
      this.scheduleSaveIndex()
      if (this.config.debug) logger.info(`缓存命中: ${key}`)
      return buffer
    } catch {
      this.entries.delete(key)
      this.missCount++
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
        processed: undefined,
      }
      this.entries.set(key, entry)
      this.scheduleSaveIndex()
      if (this.config.debug) logger.debug(`缓存已保存: ${key}`)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`保存缓存失败: ${err.message}`)
    }
  }

  /** 某画廊的 1..pageCount 页是否已全部在缓存索引中（用于跳过官方直链签发） */
  hasCachedPages(galleryId: string, mediaId: string, pageCount: number): boolean {
    if (!this.config.cache.enableImageCache || pageCount <= 0) return false
    for (let index = 0; index < pageCount; index++) {
      if (!this.entries.has(this.getCacheKey(galleryId, mediaId, index, false))) return false
    }
    return true
  }

  async getProcessed(galleryId: string, mediaId: string, pageIndex: number, variant: string): Promise<{ buffer: Buffer; extension: string } | null> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, false, variant)
    const entry = this.entries.get(key)
    if (!entry) {
      this.missCount++
      return null
    }

    try {
      await fs.access(entry.filePath)
      if (Date.now() - entry.cachedAt >= this.cacheTTL) {
        await this.deleteProcessed(galleryId, mediaId, pageIndex, variant)
        this.missCount++
        return null
      }
      const buffer = await fs.readFile(entry.filePath)
      entry.lastAccessed = Date.now()
      entry.accessCount++
      this.hitCount++
      this.scheduleSaveIndex()
      return { buffer, extension: entry.extension }
    } catch {
      this.entries.delete(key)
      this.missCount++
      this.scheduleSaveIndex()
      return null
    }
  }

  async setProcessed(galleryId: string, mediaId: string, pageIndex: number, buffer: Buffer, extension: string, variant: string): Promise<void> {
    if (!this.config.cache.enableImageCache) return

    try {
      const key = this.getCacheKey(galleryId, mediaId, pageIndex, false, variant)
      const filePath = this.getCacheFilePath(galleryId, mediaId, pageIndex, extension, false, variant)
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
        processed: variant,
      }
      this.entries.set(key, entry)
      this.scheduleSaveIndex()
      if (this.config.debug) logger.debug(`处理缓存已保存: ${key}`)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`保存处理缓存失败: ${err.message}`)
    }
  }

  async deleteProcessed(galleryId: string, mediaId: string, pageIndex: number, variant: string): Promise<void> {
    const key = this.getCacheKey(galleryId, mediaId, pageIndex, false, variant)
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
    // processed 必须一起传入：processed 缓存用的是带 -processed 后缀的键，
    // 漏传会删掉同页原始图的索引项，使原始文件变成永远不会被回收的孤儿
    this.entries.delete(
      this.getCacheKey(entry.galleryId, entry.mediaId, entry.pageIndex, entry.isThumb, entry.processed),
    )
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
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`PDF 缓存初始化失败: ${err.message}`)
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
      const err = error as any
      if (err.code !== 'ENOENT') {
        const errMsg = err instanceof Error ? err.message : String(error)
        logger.warn(`加载 PDF 索引失败: ${errMsg}`)
      }
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
    if (!entry) {
      this.missCount++
      return null
    }

    try {
      await fs.access(entry.filePath)
      const isExpired = this.cacheTTL !== Infinity && (Date.now() - entry.cachedAt >= this.cacheTTL)

      if (isExpired) {
        await this.delete(galleryId, password)
        this.missCount++
        return null
      }

      entry.lastAccessed = Date.now()
      entry.accessCount++
      this.hitCount++
      this.scheduleSaveIndex()
      if (this.config.debug) logger.info(`PDF 缓存命中: ${galleryId}`)
      return entry.filePath
    } catch {
      this.entries.delete(key)
      this.missCount++
      this.scheduleSaveIndex()
      return null
    }
  }

  async set(galleryId: string, sourcePath: string, fileName: string, password?: string): Promise<string | null> {
    if (!this.config.cache.enablePdfCache) return null

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
      return filePath
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.warn(`保存 PDF 缓存失败: ${err.message}`)
      return null
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

