// --- START OF FILE src/services/api.ts ---

// src/services/api.ts
import { Context } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { API_BASE } from '../constants'
import { Gallery, SearchResult } from '../types'
import type { GotScraping } from 'got-scraping'
import { Agent as HttpAgent } from 'http'
import { Agent as HttpsAgent } from 'https'

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

    // 将秒转换为毫秒
    const downloadTimeoutMs = this.config.downloadTimeout * 1000;

    // 连接池优化：创建 HTTP Agent 实例
    const httpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: downloadTimeoutMs,
    });

    const httpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: downloadTimeoutMs,
      rejectUnauthorized: false, // 允许自签名证书（如果需要）
    });

    return gotScraping.extend({
      prefixUrl: API_BASE,
      timeout: { request: downloadTimeoutMs },
      retry: { limit: this.config.downloadRetries },
      proxyUrl: this.config.proxy || undefined,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 100 }],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
    });
  }

  private async createImageGotInstance(): Promise<GotScraping> {
    const baseInstance = this.apiGot || await this.createApiGotInstance();

    // 将秒转换为毫秒
    const downloadTimeoutMs = this.config.downloadTimeout * 1000;

    // 图片下载使用更大的连接池
    const imageHttpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: downloadTimeoutMs,
    });

    const imageHttpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 100,
      maxFreeSockets: 20,
      timeout: downloadTimeoutMs,
      rejectUnauthorized: false,
    });

    return baseInstance.extend({
      prefixUrl: '', // Image URLs are absolute
      // No JSON parsing for images
      agent: {
        http: imageHttpAgent,
        https: imageHttpsAgent,
      },
    });
  }

  private dispose() {
    this.cache.dispose()
    if (this.config.debug) logger.info('ApiService 已清理。')
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
        if (this.config.debug) logger.info(`命中画廊缓存: ${id}`)
        if (this.config.debug && this.config.returnApiJson) {
            logger.info(`[API Response (Cache)] Gallery ${id}:\n${JSON.stringify(cached, null, 2)}`);
        }
        return cached
      }
    }
    try {
      if (this.config.debug) logger.info(`请求画廊: ${id}`)
      await this.ensureGotInstances();
      const url = `gallery/${id}`
      const data = await this.apiGot!.get(url).json<Gallery>()
      if (!data || typeof data.id === 'undefined') throw new Error('无效的API响应')

      if (this.config.debug) logger.info(`获取画廊 ${id} 成功。`)

      if (this.config.debug && this.config.returnApiJson) {
        logger.info(`[API Response] Gallery ${id}:\n${JSON.stringify(data, null, 2)}`);
      }

      if (this.config.cache.enableApiCache) {
        // 将分钟转换为毫秒
        const apiCacheTTLMs = this.config.cache.apiCacheTTL * 60 * 1000;
        this.cache.set(cacheKey, data, apiCacheTTLMs)
      }
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.body || error.message, null, 2)
      logger.error(`请求画廊 ${id} 失败: \n%s`, errorMessage)
      return null
    }
  }

  async searchGalleries(query: string, page = 1, sort?: string): Promise<SearchResult | null> {
    const cacheKey = `nhentai:search:${query}:${page}:${sort || ''}`
    if (this.config.cache.enableApiCache) {
      const cached = await this.cache.get<SearchResult>(cacheKey)
      if (cached) {
        if (this.config.debug) logger.info(`命中搜索缓存: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`)
        if (this.config.debug && this.config.returnApiJson) {
            logger.info(`[API Response (Cache)] Search "${query}" Page ${page}:\n${JSON.stringify(cached, null, 2)}`);
        }
        return cached
      }
    }
    try {
      if (this.config.debug) logger.info(`搜索: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`)
      await this.ensureGotInstances();

      const searchParams = new URLSearchParams({
        query,
        page: page.toString(),
      });
      if (sort) searchParams.set('sort', sort);

      const url = `galleries/search?${searchParams.toString()}`;
      const data = await this.apiGot!.get(url).json<SearchResult>();

      if (this.config.debug) logger.info(`搜索成功，找到 ${data.result.length} 个原始结果。`)

      if (this.config.debug && this.config.returnApiJson) {
        logger.info(`[API Response] Search "${query}" Page ${page}:\n${JSON.stringify(data, null, 2)}`);
      }

      if (this.config.cache.enableApiCache) {
        // 将分钟转换为毫秒
        const apiCacheTTLMs = this.config.cache.apiCacheTTL * 60 * 1000;
        this.cache.set(cacheKey, data, apiCacheTTLMs)
      }
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.body || error.message, null, 2)
      logger.error(`搜索 "${query}" 失败: \n%s`, errorMessage)
      return null
    }
  }
}
// --- END OF FILE src/services/api.ts ---
