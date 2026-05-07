import { Context } from 'koishi'
import { Config } from '../config'
import { logger, importESM, logError, getErrorMessage } from '../utils'
import { API_BASE, CDN_CONFIG_TTL_MS, DEFAULT_IMAGE_CDN, DEFAULT_THUMB_CDN } from '../constants'
import { Gallery, SearchResult } from '../types'
import { InMemoryCache } from './cache'
import type { GotScraping } from 'got-scraping'
import { Agent as HttpAgent } from 'http'
import { Agent as HttpsAgent } from 'https'

let gotScraping: GotScraping

export class GotManager {
  public apiGot: GotScraping | null = null
  public imageGot: GotScraping | null = null
  private initialized = false
  private sessionTokens: Map<string, object> = new Map()

  constructor(private config: Config) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    // 动态导入 got-scraping 模块
    if (!gotScraping) {
      const module = await importESM<{ gotScraping: GotScraping }>('got-scraping')
      gotScraping = module.gotScraping || (module as any)
    }

    this.apiGot = await this.createApiGotInstance()
    this.imageGot = await this.createImageGotInstance()
    this.initialized = true

    if (this.config.debug) logger.info('Got 初始化完成')
  }

  private async createApiGotInstance(): Promise<GotScraping> {
    const downloadTimeoutMs = this.config.downloadTimeout * 1000
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: downloadTimeoutMs,
      scheduling: 'lifo' as const,
    }
    // 配置 HTTPS Agent，禁用证书验证和设置最低 TLS 版本
    const httpsAgent = new HttpsAgent({
      ...agentOptions,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2' as any,
    })
    const httpAgent = new HttpAgent(agentOptions)

    const instanceOptions: any = {
      timeout: { request: downloadTimeoutMs, connect: 10000, secureConnect: 10000 },
      retry: {
        limit: this.config.downloadRetries,
        methods: ['GET', 'POST'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
      },
      https: { rejectUnauthorized: false },
      headerGeneratorOptions: {
        browsers: [
          {
            name: 'chrome',
            minVersion: 120,
            maxVersion: 131,
          },
          {
            name: 'edge',
            minVersion: 120,
            maxVersion: 131,
          },
        ],
        devices: ['desktop'],
        locales: ['en-US', 'zh-CN', 'ja-JP'],
        operatingSystems: ['windows', 'macos'],
      },
      agent: { http: httpAgent, https: httpsAgent },
    }

    // User-Agent 格式：AppName/version (URL)
    const userAgent = 'koishi-plugin-nhentai-downloader/v2 (https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader)'

    instanceOptions.headers = {
      'User-Agent': userAgent,
      'Accept': 'application/json',
    }

    // API Key 认证（使用 "Key" 而非 "Bearer"）
    if (this.config.apiKey) {
      instanceOptions.headers.authorization = `Key ${this.config.apiKey}`
    }

    const instance = gotScraping.extend(instanceOptions as any)

    return this.config.proxy ? instance.extend({ proxyUrl: this.config.proxy } as any) : instance
  }

  private async createImageGotInstance(): Promise<GotScraping> {
    if (!this.apiGot) throw new Error('GotManager: apiGot 必须先初始化')

    const downloadTimeoutMs = this.config.downloadTimeout * 1000
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: downloadTimeoutMs,
      scheduling: 'lifo' as const,
    }
    // 图片下载用的 Agent，连接数更多
    const imageHttpsAgent = new HttpsAgent({
      ...agentOptions,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2' as any,
    })
    const imageHttpAgent = new HttpAgent(agentOptions)

    return this.apiGot.extend({
      responseType: 'buffer',
      timeout: { request: downloadTimeoutMs, connect: 10000, secureConnect: 10000 },
      retry: {
        limit: Math.min(this.config.downloadRetries, 2),
        methods: ['GET'],
        statusCodes: [408, 429, 500, 502, 503, 504, 521, 522, 524],
      },
      agent: { http: imageHttpAgent, https: imageHttpsAgent },
    } as any)
  }

  getSessionToken(galleryId: string): object {
    if (!this.sessionTokens.has(galleryId)) {
      this.sessionTokens.set(galleryId, {})
    }
    return this.sessionTokens.get(galleryId)!
  }

  clearSessionToken(galleryId: string): void {
    this.sessionTokens.delete(galleryId)
  }

  dispose(): void {
    const destroyAgent = (gotInstance: GotScraping | null) => {
      const agent = (gotInstance as any)?.defaults?.options?.agent
      if (agent) {
        agent.http?.destroy()
        agent.https?.destroy()
      }
    }
    // 销毁两个 Got 实例的连接池
    destroyAgent(this.apiGot)
    destroyAgent(this.imageGot)

    this.apiGot = null
    this.imageGot = null
    this.sessionTokens.clear()
    this.initialized = false

    if (this.config.debug) logger.info('Got 实例已释放')
  }
}

export class ApiService {
  private cache: InMemoryCache | null = null
  private gotManager: GotManager
  // CDN 配置缓存 - 分别存储图片和缩略图服务器
  private cdnImageServers: string[] | null = null
  private cdnThumbServers: string[] | null = null
  private lastCdnUpdate = 0
  // 速率限制和并发控制
  private requestQueue: Array<() => Promise<any>> = []
  private activeRequests = 0
  private maxConcurrentRequests = 5
  private rateLimitResetTime = 0

  constructor(private ctx: Context, private config: Config) {
    this.gotManager = new GotManager(config)
  }

  async initialize(): Promise<void> {
    await this.gotManager.initialize()
  }

  get imageGot() {
    return this.gotManager.imageGot
  }

  getSessionToken(galleryId: string): object {
    return this.gotManager.getSessionToken(galleryId)
  }

  clearSessionToken(galleryId: string): void {
    this.gotManager.clearSessionToken(galleryId)
  }

  /**
   * 限制 API 请求并发数
   */
  private async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    // 检查速率限制
    if (this.rateLimitResetTime > Date.now()) {
      const waitTime = Math.ceil((this.rateLimitResetTime - Date.now()) / 1000)
      logger.warn(`API 速率限制，需等待 ${waitTime}s`)
      await new Promise(resolve => setTimeout(resolve, this.rateLimitResetTime - Date.now()))
    }

    // 并发控制
    while (this.activeRequests >= this.maxConcurrentRequests) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    this.activeRequests++
    try {
      return await fn()
    } finally {
      this.activeRequests--
    }
  }

  /**
   * 处理速率限制响应
   */
  private handleRateLimit(headers: any): void {
    const retryAfter = headers['retry-after']
    if (retryAfter) {
      let delayMs = 1000

      if (/^\d+$/.test(retryAfter)) {
        delayMs = parseInt(retryAfter, 10) * 1000
      } else {
        try {
          const retryDate = new Date(retryAfter).getTime()
          delayMs = Math.max(0, retryDate - Date.now())
        } catch {}
      }

      this.rateLimitResetTime = Date.now() + Math.min(delayMs, 60000)
      logger.warn(`API 速率限制，${Math.ceil((this.rateLimitResetTime - Date.now()) / 1000)}s 后恢复`)
    }
  }

  private getCache(): InMemoryCache {
    if (!this.cache) {
      this.cache = new InMemoryCache({
        maxSize: 500,
        defaultTTL: this.config.cache.apiCacheTTL * 60 * 1000,
      })
      if (this.config.debug) logger.debug('API 缓存已初始化')
    }
    return this.cache
  }

  // 从缓存获取数据
  private async getCached<T>(key: string): Promise<T | null> {
    if (!this.config.cache.enableApiCache) return null
    const cached = await this.getCache().get<T>(key)
    if (cached && this.config.debug) logger.debug(`命中缓存: ${key}`)
    return cached || null
  }

  // 保存数据到缓存
  private async setCached<T>(key: string, data: T): Promise<void> {
    if (!this.config.cache.enableApiCache) return
    await this.getCache().set(key, data, this.config.cache.apiCacheTTL * 60 * 1000)
  }

  /**
   * 解析 Retry-After 响应头
   */
  private parseRetryAfter(headers: any): number {
    const retryAfter = headers['retry-after']
    if (!retryAfter) return 1000

    if (/^\d+$/.test(retryAfter)) {
      return parseInt(retryAfter, 10) * 1000
    }

    try {
      const retryDate = new Date(retryAfter).getTime()
      const delay = Math.max(0, retryDate - Date.now())
      return Math.min(delay, 60000)
    } catch {
      return 1000
    }
  }

  /**
   * 分类 HTTP 错误
   */
  private parseHttpError(error: any, context: string): { code: number; message: string; isRetryable: boolean } {
    if (!error.response) {
      return {
        code: 0,
        message: context,
        isRetryable: false,
      }
    }

    const status = error.response.status
    let message = context

    switch (status) {
      case 404:
        message = `${context}：画廊不存在或已被删除`
        logger.warn(message)
        return { code: 404, message, isRetryable: false }

      case 403:
        message = `${context}：画廊已被隐藏或无权访问`
        logger.warn(message)
        return { code: 403, message, isRetryable: false }

      case 429:
        message = `${context}：触发 API 速率限制`
        const retryAfter = this.parseRetryAfter(error.response.headers || {})
        this.handleRateLimit(error.response.headers || {})
        logger.warn(`${message} (建议等待 ${(retryAfter / 1000).toFixed(1)} 秒)`)
        return { code: 429, message, isRetryable: true }

      case 500:
      case 502:
      case 503:
      case 504:
        message = `${context}：服务器暂时不可用`
        logger.warn(message)
        return { code: status, message, isRetryable: true }

      default:
        return { code: status, message: `${context}：HTTP ${status}`, isRetryable: false }
    }
  }

  /**
   * 获取 CDN 服务器列表（从 /api/v2/cdn 动态获取，缓存 24h）
   * API 返回格式: { image_servers: [...], thumb_servers: [...] }
   * 返回值: { image: 主机名列表, thumb: 主机名列表 }
   */
  async getCdnServers(): Promise<{ image: string[]; thumb: string[] }> {
    const now = Date.now()

    // 使用缓存 - 检查两个服务器列表是否都有效
    if (this.cdnImageServers && this.cdnImageServers.length > 0 && this.cdnThumbServers && this.cdnThumbServers.length > 0 && now - this.lastCdnUpdate < CDN_CONFIG_TTL_MS) {
      if (this.config.debug) logger.debug(`使用缓存的 CDN 服务器`)
      return {
        image: this.cdnImageServers,
        thumb: this.cdnThumbServers,
      }
    }

    try {
      const url = `${API_BASE}/cdn`
      const response = await this.gotManager.apiGot!.get(url).json<any>()

      if (this.config.debug) {
        logger.debug(`CDN API 响应: ${JSON.stringify(response, null, 2)}`)
      }

      // 从 API 响应中提取服务器列表
      let imageServers: string[] = []
      let thumbServers: string[] = []

      // 官方 API 格式: { image_servers: [...], thumb_servers: [...] }
      if (response?.image_servers && Array.isArray(response.image_servers) && response.image_servers.length > 0) {
        if (this.config.debug) {
          logger.debug(`检测到 image_servers: ${response.image_servers.length} 个`)
        }
        imageServers = response.image_servers
          .map((url: any) => {
            const host = this.extractHostFromUrl(url)
            if (this.config.debug) {
              logger.debug(`提取图片服务器: ${url} -> ${host}`)
            }
            return host
          })
          .filter((host: string | null): host is string => host !== null && host.length > 0)
      }

      if (response?.thumb_servers && Array.isArray(response.thumb_servers) && response.thumb_servers.length > 0) {
        if (this.config.debug) {
          logger.debug(`检测到 thumb_servers: ${response.thumb_servers.length} 个`)
        }
        thumbServers = response.thumb_servers
          .map((url: any) => {
            const host = this.extractHostFromUrl(url)
            if (this.config.debug) {
              logger.debug(`提取缩略图服务器: ${url} -> ${host}`)
            }
            return host
          })
          .filter((host: string | null): host is string => host !== null && host.length > 0)
      }

      // 备用格式处理
      if (imageServers.length === 0 && response?.servers && Array.isArray(response.servers)) {
        if (this.config.debug) {
          logger.debug(`检测到 servers (旧格式): ${response.servers.length} 个`)
        }
        imageServers = response.servers
          .map((s: any) => s?.c || s)
          .filter((host: any): host is string => typeof host === 'string' && host.length > 0)
      }

      if (imageServers.length === 0) {
        logger.warn(`CDN API 返回空列表或无效格式: ${JSON.stringify(response)}`)
        throw new Error('CDN 服务器列表为空或格式无效')
      }

      // 如果只有图片服务器没有缩略图服务器，使用图片服务器
      if (thumbServers.length === 0) {
        thumbServers = imageServers
      }

      // 分别保存两个服务器列表到缓存
      this.cdnImageServers = imageServers
      this.cdnThumbServers = thumbServers
      this.lastCdnUpdate = now
      logger.info(
        `CDN 已更新 - 图片: ${imageServers.join(', ')} | 缩略图: ${thumbServers.join(', ')}`
      )
      return { image: imageServers, thumb: thumbServers }
    } catch (error) {
      // 降级到默认 CDN
      const defaultImageServers = [DEFAULT_IMAGE_CDN]
      const defaultThumbServers = [DEFAULT_THUMB_CDN]

      const errorMsg = getErrorMessage(error)
      logger.warn(
        `获取 CDN 失败: ${errorMsg}，使用默认值 [${defaultImageServers.join(', ')} | ${defaultThumbServers.join(', ')}]`
      )

      if (!this.cdnImageServers || this.cdnImageServers.length === 0) {
        this.cdnImageServers = defaultImageServers
        this.cdnThumbServers = defaultThumbServers
        this.lastCdnUpdate = now
      }

      return {
        image: this.cdnImageServers || defaultImageServers,
        thumb: this.cdnThumbServers || defaultThumbServers,
      }
    }
  }

  /**
   * 从完整 URL 中提取主机名
   * 例如: https://i1.nhentai.net -> i1.nhentai.net
   */
  private extractHostFromUrl(url: string): string | null {
    try {
      if (!url || typeof url !== 'string') return null

      // 如果已经是主机名格式（不含 ://），直接返回
      if (!url.includes('://')) {
        return url.length > 0 ? url : null
      }

      // 从完整 URL 中提取主机名
      const urlObj = new URL(url)
      return urlObj.hostname
    } catch (e) {
      // URL 解析失败，尝试直接使用
      return url?.length > 0 ? url : null
    }
  }

  /**
   * 将 API 响应格式转换为内部数据格式
   */
  private transformGalleryResponse(rawData: any): Gallery {
    // 清理路径中的重复扩展名（API 可能返回如 cover.webp.webp）
    const cleanPath = (path: string): string => {
      if (!path) return path
      // 匹配常见的重复扩展名模式：.webp.webp, .jpg.jpg, .png.png, .png.webp 等
      return path.replace(/\.(webp|jpg|jpeg|png)\.(webp|jpg|jpeg|png)$/i, '.$1')
    }

    return {
      id: String(rawData.id),
      media_id: rawData.media_id,
      title: rawData.title,
      images: {
        pages: (rawData.pages || []).map((p: any) => ({
          ...p,
          path: cleanPath(p.path),
          thumbnail: cleanPath(p.thumbnail),
        })),
        cover: rawData.cover ? { ...rawData.cover, path: cleanPath(rawData.cover.path) } : rawData.cover,
        thumbnail: rawData.thumbnail ? { ...rawData.thumbnail, path: cleanPath(rawData.thumbnail.path) } : rawData.thumbnail,
      },
      scanlator: rawData.scanlator,
      upload_date: rawData.upload_date,
      tags: rawData.tags,
      num_pages: rawData.num_pages,
      num_favorites: rawData.num_favorites,
    }
  }

  async getGallery(id: string): Promise<Gallery | null> {
    const cacheKey = `nhentai:gallery:${id}`
    // 检查缓存
    const cached = await this.getCached<Gallery>(cacheKey)
    if (cached) return cached

    try {
      logger.info(`请求画廊: ${id}`)

      const url = `${API_BASE}/galleries/${id}`
      const rawData = await this.gotManager.apiGot!.get(url).json<any>()

      if (!rawData || typeof rawData.id === 'undefined') throw new Error('无效的API响应')

      const data = this.transformGalleryResponse(rawData)

      logger.info(`获取画廊 ${id} 成功`)

      if (this.config.returnApiJson) {
        logger.info(`[API响应] 画廊 ${id}:
${JSON.stringify(rawData, null, 2)}`)
      }
      // 保存到缓存
      await this.setCached(cacheKey, data)

      return data
    } catch (error) {
      logError('请求画廊', id, error)
      return null
    }
  }

  /**
   * 获取随机画廊
   * 官方文档：使用 GET /api/v2/galleries/random
   * 注意：API 返回只包含 id，需要再次调用 getGallery 获取完整信息
   * 注意：不缓存随机结果，每次都返回新的画廊
   */
  async getRandomGallery(): Promise<Gallery | null> {
    try {
      logger.info('请求随机画廊')

      const url = `${API_BASE}/galleries/random`
      const randomResponse = await this.gotManager.apiGot!.get(url).json<any>()

      if (!randomResponse || typeof randomResponse.id === 'undefined') {
        throw new Error('无效的API响应')
      }

      if (this.config.returnApiJson) {
        logger.info(`[API响应] 随机画廊 ${randomResponse.id}:
${JSON.stringify(randomResponse, null, 2)}`)
      }

      // API 仅返回 id，需要获取完整的画廊信息
      const galleryId = String(randomResponse.id)
      const data = await this.getGallery(galleryId)

      if (!data) {
        throw new Error(`无法获取随机画廊完整信息: ${galleryId}`)
      }

      logger.info(`随机画廊获取成功: ${data.id}`)

      // 注意：不缓存随机结果，避免重复返回同一画廊
      return data
    } catch (error) {
      logError('请求随机画廊', 'GET /api/v2/galleries/random', error)
      return null
    }
  }

  async searchGalleries(query: string, page = 1, sort?: string): Promise<SearchResult | null> {
    const cacheKey = `nhentai:search:${query}:${page}:${sort || ''}`
    const cached = await this.getCached<SearchResult>(cacheKey)
    if (cached) return cached

    try {
      // 官方 API 仅支持 'popular'
      if (sort && sort !== 'popular') {
        logger.warn(`排序选项 "${sort}" 不受支持，已移除`)
        sort = undefined
      }

      logger.info(`搜索: "${query}" (页 ${page}${sort ? `, 排序: ${sort}` : ''})`)

      const searchParams = new URLSearchParams({ query, page: page.toString() })
      if (sort) searchParams.set('sort', sort)

      const url = `${API_BASE}/search?${searchParams.toString()}`
      const data = await this.gotManager.apiGot!.get(url).json<SearchResult>()

      if (!data || !data.result) {
        logger.warn(`搜索 "${query}" 无结果`)
        return { result: [], num_pages: 0, per_page: 25 }
      }

      logger.info(`找到 ${data.result.length} 个结果（共 ${data.num_pages} 页）`)
      await this.setCached(cacheKey, data)
      return data
    } catch (error) {
      logError('搜索', `"${query}"`, error)
      return null
    }
  }

  /**
   * 获取相关画廊
   * 官方文档：GET /api/v2/galleries/{id}/related
   * 用于推荐相似的作品
   */
  async getRelatedGalleries(id: string): Promise<SearchResult | null> {
    const cacheKey = `nhentai:related:${id}`
    // 检查缓存
    const cached = await this.getCached<SearchResult>(cacheKey)
    if (cached) return cached

    try {
      logger.info(`请求相关画廊: ${id}`)

      const url = `${API_BASE}/galleries/${id}/related`
      const data = await this.gotManager.apiGot!.get(url).json<SearchResult>()

      if (!data || !data.result) {
        logger.warn(`画廊 ${id} 的相关作品返回了意外的数据结构`)
        if (this.config.debug) {
          logger.info(`[API响应] 原始数据:
${JSON.stringify(data, null, 2)}`)
        }
        return { result: [], num_pages: 0, per_page: 25 }
      }

      logger.info(`获取相关画廊成功，找到 ${data.result.length} 个相关作品`)

      if (this.config.returnApiJson) {
        logger.info(`[API响应] 画廊 ${id} 的相关作品:
${JSON.stringify(data, null, 2)}`)
      }
      // 保存到缓存
      await this.setCached(cacheKey, data)

      return data
    } catch (error) {
      logError('请求相关画廊', id, error)
      return null
    }
  }

  /**
   * 获取热门画廊
   * 官方文档：GET /api/v2/galleries/popular
   * 获取热门作品列表
   */
  async getPopularGalleries(page = 1): Promise<SearchResult | null> {
    const cacheKey = `nhentai:popular:${page}`
    // 检查缓存
    const cached = await this.getCached<SearchResult>(cacheKey)
    if (cached) return cached

    try {
      logger.info(`请求热门画廊: 第 ${page} 页`)

      const searchParams = new URLSearchParams({ page: page.toString() })
      const url = `${API_BASE}/galleries/popular?${searchParams.toString()}`
      const data = await this.gotManager.apiGot!.get(url).json<SearchResult>()

      if (!data || !data.result) {
        logger.warn(`热门画廊返回了意外的数据结构`)
        if (this.config.debug) {
          logger.info(`[API响应] 原始数据:
${JSON.stringify(data, null, 2)}`)
        }
        return { result: [], num_pages: 0, per_page: 25 }
      }

      logger.info(`获取热门画廊成功，找到 ${data.result.length} 个结果`)

      if (this.config.returnApiJson) {
        logger.info(`[API响应] 热门画廊第 ${page} 页:
${JSON.stringify(data, null, 2)}`)
      }
      // 保存到缓存
      await this.setCached(cacheKey, data)

      return data
    } catch (error) {
      logError('请求热门画廊', `第 ${page} 页`, error)
      return null
    }
  }

  // 获取画廊完整下载链接
  async getGalleryDownloadUrl(id: string): Promise<{ url: string } | null> {
    try {
      logger.info(`请求画廊下载链接: ${id}`)

      const url = `${API_BASE}/galleries/${id}/download`
      const data = await this.gotManager.apiGot!.post(url).json<{ url: string }>()

      if (!data?.url || typeof data.url !== 'string') {
        logger.warn(`获取画廊 ${id} 下载链接失败：响应格式无效`)
        return null
      }

      logger.info(`获取画廊 ${id} 下载链接成功`)

      if (this.config.debug) {
        logger.debug(`下载链接有效期可能受限，请立即使用`)
      }

      return data
    } catch (error) {
      const errorMsg = getErrorMessage(error)
      logger.warn(`获取画廊 ${id} 下载链接失败: ${errorMsg}`)
      return null
    }
  }

  dispose(): void {
    // 销毁缓存实例
    if (this.cache) {
      this.cache.dispose()
      this.cache = null
    }
    this.gotManager.dispose()
    if (this.config.debug) logger.info('ApiService 已释放')
  }
}
