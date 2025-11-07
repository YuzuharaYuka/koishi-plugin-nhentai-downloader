import { Context } from 'koishi'
import { Config } from '../config'
import { logger, importESM } from '../utils'
import { API_BASE } from '../constants'
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

    if (!gotScraping) {
      const module = await importESM<{ gotScraping: GotScraping }>('got-scraping')
      gotScraping = module.gotScraping || (module as any)
    }

    this.apiGot = await this.createApiGotInstance()
    this.imageGot = await this.createImageGotInstance()
    this.initialized = true

    if (this.config.debug) {
      logger.info('Got 初始化完成')
    }
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
    const httpsAgent = new HttpsAgent({
      ...agentOptions,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2' as any,
    })
    const httpAgent = new HttpAgent(agentOptions)

    const instance = gotScraping.extend({
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
    } as any)

    return this.config.proxy ? instance.extend({ proxyUrl: this.config.proxy } as any) : instance
  }

  private async createImageGotInstance(): Promise<GotScraping> {
    if (!this.apiGot) {
      throw new Error('GotManager: apiGot 必须先初始化')
    }

    const downloadTimeoutMs = this.config.downloadTimeout * 1000
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: downloadTimeoutMs,
      scheduling: 'lifo' as const,
    }
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

    destroyAgent(this.apiGot)
    destroyAgent(this.imageGot)

    this.apiGot = null
    this.imageGot = null
    this.sessionTokens.clear()
    this.initialized = false

    if (this.config.debug) {
      logger.info('Got 实例已清理')
    }
  }
}

export class ApiService {
  private cache: InMemoryCache | null = null
  private gotManager: GotManager

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

  private getCache(): InMemoryCache {
    if (!this.cache) {
      this.cache = new InMemoryCache({
        maxSize: 500,
        defaultTTL: this.config.cache.apiCacheTTL * 60 * 1000,
      })
      if (this.config.debug) {
        logger.info('API 缓存已初始化')
      }
    }
    return this.cache
  }

  async getGallery(id: string): Promise<Gallery | null> {
    const cacheKey = `nhentai:gallery:${id}`

    if (this.config.cache.enableApiCache) {
      const cache = this.getCache()
      const cached = await cache.get<Gallery>(cacheKey)
      if (cached) {
        if (this.config.debug) logger.info(`命中画廊缓存: ${id}`)
        return cached
      }
    }

    try {
      if (this.config.debug) logger.info(`请求画廊: ${id}`)

      const url = `${API_BASE}/gallery/${id}`
      const data = await this.gotManager.apiGot!.get(url).json<Gallery>()

      if (!data || typeof data.id === 'undefined') {
        throw new Error('无效的API响应')
      }

      if (this.config.debug) logger.info(`获取画廊 ${id} 成功`)

      if (this.config.returnApiJson) {
        logger.info(`[API响应] 画廊 ${id}:\n${JSON.stringify(data, null, 2)}`)
      }

      if (this.config.cache.enableApiCache) {
        const cache = this.getCache()
        await cache.set(cacheKey, data, this.config.cache.apiCacheTTL * 60 * 1000)
      }

      return data
    } catch (error) {
      logger.error(`请求画廊 ${id} 失败: %s`, JSON.stringify(error.response?.body || error.message))
      return null
    }
  }

  async searchGalleries(query: string, page = 1, sort?: string): Promise<SearchResult | null> {
    const cacheKey = `nhentai:search:${query}:${page}:${sort || ''}`

    if (this.config.cache.enableApiCache) {
      const cache = this.getCache()
      const cached = await cache.get<SearchResult>(cacheKey)
      if (cached) {
        if (this.config.debug) logger.info(`命中搜索缓存: "${query}" (第 ${page} 页)`)
        return cached
      }
    }

    try {
      // 规范化 sort 参数: API 端点可能只支持 'popular', 细分的时间范围参数可能被忽略
      let normalizedSort = sort
      if (sort && (sort === 'popular-today' || sort === 'popular-week' || sort === 'popular-month')) {
        if (this.config.debug) {
          logger.warn(`sort 参数 "${sort}" 可能不被 API 完全支持，将尝试原样传递`)
        }
        // 保持原值，让 API 自行处理（可能会被忽略或降级为 popular）
        normalizedSort = sort
      }

      if (this.config.debug) logger.info(`搜索: "${query}" (第 ${page} 页, sort: ${normalizedSort || '无'})`)

      const searchParams = new URLSearchParams({ query, page: page.toString() })
      if (normalizedSort) searchParams.set('sort', normalizedSort)

      const url = `${API_BASE}/galleries/search?${searchParams.toString()}`
      if (this.config.debug) logger.info(`请求 URL: ${url}`)

      const data = await this.gotManager.apiGot!.get(url).json<SearchResult>()

      if (this.config.debug) logger.info(`搜索完成，找到 ${data.result.length} 个结果`)

      if (this.config.returnApiJson) {
        logger.info(`[API响应] 搜索 "${query}" (第 ${page} 页, ${sort || '默认排序'}):\n${JSON.stringify(data, null, 2)}`)
      }

      if (this.config.cache.enableApiCache) {
        const cache = this.getCache()
        await cache.set(cacheKey, data, this.config.cache.apiCacheTTL * 60 * 1000)
      }

      return data
    } catch (error) {
      logger.error(`搜索 "${query}" 失败: %s`, JSON.stringify(error.response?.body || error.message))
      return null
    }
  }

  dispose(): void {
    if (this.cache) {
      this.cache.dispose()
      this.cache = null
    }
    this.gotManager.dispose()
    if (this.config.debug) logger.info('ApiService 已清理')
  }
}
