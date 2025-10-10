// --- START OF FILE src/services/api.ts ---

// src/services/api.ts
import { Context } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { API_BASE } from '../constants'
import { Gallery, SearchResult } from '../types'
import type { GotScraping } from 'got-scraping'

export * from '../constants'
export * from '../types'

let gotScraping: GotScraping;

class InMemoryCache {
  private store = new Map<string, { value: any; timer?: NodeJS.Timeout }>()

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key)
    return entry?.value
  }

  async set(key: string, value: any, maxAge?: number): Promise<void> {
    const existing = this.store.get(key)
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    let timer: NodeJS.Timeout | undefined
    if (maxAge) {
      timer = setTimeout(() => this.store.delete(key), maxAge)
    }
    this.store.set(key, { value, timer })
  }

  dispose() {
    for (const { timer } of this.store.values()) {
      if (timer) clearTimeout(timer)
    }
    this.store.clear()
  }
}

export class ApiService {
  private cache: InMemoryCache
  public apiGot: GotScraping | null = null;
  public imageGot: GotScraping | null = null;

  constructor(private ctx: Context, private config: Config) {
    this.cache = new InMemoryCache()
    ctx.on('ready', async () => {
      await this.ensureGotInstances();
    });
    ctx.on('dispose', () => this.dispose())
  }
  
  private async createApiGotInstance(): Promise<GotScraping> {
    gotScraping ??= (await import('got-scraping')).gotScraping;
    
    return gotScraping.extend({
      prefixUrl: API_BASE,
      timeout: { request: this.config.downloadTimeout },
      retry: { limit: this.config.downloadRetries },
      proxyUrl: this.config.proxy || undefined,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 100 }],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
    });
  }

  private async createImageGotInstance(): Promise<GotScraping> {
    const baseInstance = this.apiGot || await this.createApiGotInstance();
    return baseInstance.extend({
      prefixUrl: '', // Image URLs are absolute
      // No JSON parsing for images
    });
  }

  private dispose() {
    this.cache.dispose()
    if (this.config.debug) logger.info('[API] ApiService 已清理。')
  }

  private async ensureGotInstances(): Promise<void> {
    if (!this.apiGot) {
      this.apiGot = await this.createApiGotInstance();
    }
    if (!this.imageGot) {
      this.imageGot = await this.createImageGotInstance();
    }
  }

  async getGallery(id: string): Promise<Gallery | null> {
    const cacheKey = `nhentai:gallery:${id}`
    if (this.config.cache.enableApiCache) {
      const cached = await this.cache.get<Gallery>(cacheKey)
      if (cached) {
        if (this.config.debug) logger.info(`[Cache] 命中画廊缓存: ${id}`)
        if (this.config.debug && this.config.returnApiJson) {
            logger.info(`[API Response (Cache)] Gallery ${id}:\n${JSON.stringify(cached, null, 2)}`);
        }
        return cached
      }
    }
    try {
      if (this.config.debug) logger.info(`[API] 请求画廊: ${id}`)
      await this.ensureGotInstances();
      const url = `gallery/${id}`
      const data = await this.apiGot!.get(url).json<Gallery>()
      if (!data || typeof data.id === 'undefined') throw new Error('无效的API响应')
      
      if (this.config.debug) logger.info(`[API] 获取画廊 ${id} 成功。`)

      if (this.config.debug && this.config.returnApiJson) {
        logger.info(`[API Response] Gallery ${id}:\n${JSON.stringify(data, null, 2)}`);
      }

      if (this.config.cache.enableApiCache) {
        this.cache.set(cacheKey, data, this.config.cache.apiCacheTTL)
      }
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.body || error.message, null, 2)
      logger.error(`[API] 请求画廊 ${id} 失败: \n%s`, errorMessage)
      return null
    }
  }

  async searchGalleries(query: string, page = 1, sort?: string): Promise<SearchResult | null> {
    const cacheKey = `nhentai:search:${query}:${page}:${sort || ''}`
    if (this.config.cache.enableApiCache) {
      const cached = await this.cache.get<SearchResult>(cacheKey)
      if (cached) {
        if (this.config.debug) logger.info(`[Cache] 命中搜索缓存: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`)
        if (this.config.debug && this.config.returnApiJson) {
            logger.info(`[API Response (Cache)] Search "${query}" Page ${page}:\n${JSON.stringify(cached, null, 2)}`);
        }
        return cached
      }
    }
    try {
      if (this.config.debug) logger.info(`[API] 搜索: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`)
      await this.ensureGotInstances();
      
      const searchParams = new URLSearchParams({
        query,
        page: page.toString(),
      });
      if (sort) searchParams.set('sort', sort);
      
      const url = `galleries/search?${searchParams.toString()}`;
      const data = await this.apiGot!.get(url).json<SearchResult>();

      if (this.config.debug) logger.info(`[API] 搜索成功，找到 ${data.result.length} 个原始结果。`)

      if (this.config.debug && this.config.returnApiJson) {
        logger.info(`[API Response] Search "${query}" Page ${page}:\n${JSON.stringify(data, null, 2)}`);
      }
      
      if (this.config.cache.enableApiCache) {
        this.cache.set(cacheKey, data, this.config.cache.apiCacheTTL)
      }
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.body || error.message, null, 2)
      logger.error(`[API] 搜索 "${query}" 失败: \n%s`, errorMessage)
      return null
    }
  }
}
// --- END OF FILE src/services/api.ts ---