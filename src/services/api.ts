// src/services/api.ts
import { Context } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { API_BASE } from '../constants'
import { Gallery, SearchResult } from '../types'

export * from '../constants'
export * from '../types'

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

  constructor(private ctx: Context, private config: Config) {
    this.cache = new InMemoryCache()
    ctx.on('dispose', () => this.dispose())
  }

  private dispose() {
    this.cache.dispose()
    if (this.config.debug) logger.info('[API] ApiService 已清理。')
  }

  async getGallery(id: string): Promise<Gallery | null> {
    const cacheKey = `nhentai:gallery:${id}`
    if (this.config.cache.enableApiCache) {
      const cached = await this.cache.get<Gallery>(cacheKey)
      if (cached) {
        if (this.config.debug) logger.info(`[Cache] 命中画廊缓存: ${id}`)
        if (this.config.debug && this.config.returnApiJson) {
            // [修正] 使用 JSON.stringify 进行格式化输出，避免日志被截断
            logger.info(`[API Response (Cache)] Gallery ${id}:\n${JSON.stringify(cached, null, 2)}`);
        }
        return cached
      }
    }
    try {
      if (this.config.debug) logger.info(`[API] 请求画廊: ${id}`)
      const url = `${API_BASE}/gallery/${id}`
      const data = await this.ctx.http.get<Gallery>(url)
      if (!data || typeof data.id === 'undefined') throw new Error('无效的API响应')
      
      if (this.config.debug) logger.info(`[API] 获取画廊 ${id} 成功。`)

      if (this.config.debug && this.config.returnApiJson) {
        // [修正] 使用 JSON.stringify 进行格式化输出，避免日志被截断
        logger.info(`[API Response] Gallery ${id}:\n${JSON.stringify(data, null, 2)}`);
      }

      if (this.config.cache.enableApiCache) {
        this.cache.set(cacheKey, data, this.config.cache.apiCacheTTL)
      }
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.data || error.message, null, 2)
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
            // [修正] 使用 JSON.stringify 进行格式化输出，避免日志被截断
            logger.info(`[API Response (Cache)] Search "${query}" Page ${page}:\n${JSON.stringify(cached, null, 2)}`);
        }
        return cached
      }
    }
    try {
      if (this.config.debug) logger.info(`[API] 搜索: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`)
      let url = `${API_BASE}/galleries/search?query=${encodeURIComponent(query)}&page=${page}`
      if (sort) url += `&sort=${sort}`
      const data = await this.ctx.http.get<SearchResult>(url)

      if (this.config.debug) logger.info(`[API] 搜索成功，找到 ${data.result.length} 个原始结果。`)

      if (this.config.debug && this.config.returnApiJson) {
        // [修正] 使用 JSON.stringify 进行格式化输出，避免日志被截断
        logger.info(`[API Response] Search "${query}" Page ${page}:\n${JSON.stringify(data, null, 2)}`);
      }
      
      if (this.config.cache.enableApiCache) {
        this.cache.set(cacheKey, data, this.config.cache.apiCacheTTL)
      }
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.data || error.message, null, 2)
      logger.error(`[API] 搜索 "${query}" 失败: \n%s`, errorMessage)
      return null
    }
  }
}