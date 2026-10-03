/**
 * 接口层。
 *
 * 统一负责端点封装、按官方配额的客户端限流、内存缓存与错误归类；
 * 出错一律返回 null，由调用方决定降级方式。
 */
import { Context } from 'koishi'
import type { Config } from '../config'
import { logger, getErrorMessage, sleep } from '../utils'
import {
  API_BASE,
  API_MAX_CONCURRENCY,
  API_RATE_LIMITS,
  API_REQUEST_TIMEOUT_MS,
  CDN_CONFIG_TTL_MS,
  DEFAULT_IMAGE_CDN,
  DEFAULT_THUMB_CDN,
  DOWNLOAD_FORMATS,
  GALLERY_INCLUDES,
  RATE_LIMIT_SAFETY_FACTOR,
  SORT_ALIASES,
  VALID_SORT_OPTIONS,
  type DownloadFormat,
  type GalleryInclude,
  type RateLimitKey,
  type RateLimitRule,
  type ValidSortOption,
} from '../constants'
import type {
  ApiAppConfig,
  ApiDownloadResponse,
  ApiGalleryDetail,
  ApiGalleryListItem,
  ApiPaginated,
  ApiRandomGallery,
  ApiRelatedGalleries,
  ApiTag,
  ApiValidationError,
  Gallery,
  SearchGallery,
  SearchResult,
  Tag,
} from '../types'
import { InMemoryCache } from './cache'
import { HttpManager } from './http'
import { Semaphore, SlidingWindowRateLimiter } from './rate-limiter'

/** CDN 主机健康度 */
interface CdnHostHealth {
  failures: number
  cooldownUntil: number
  /** 指数加权平均延迟 */
  latencyMs: number
  samples: number
}

export interface ApiMetrics {
  /** 真实发出的 HTTP 请求数（不含缓存命中） */
  requests: number
  cacheHits: number
  errors: number
  retries: number
  rateLimitPenalties: number
}

// ============================================================
// API 服务
// ============================================================

/** 把命令行/配置里的排序写法归一化为官方枚举值 */
export function normalizeSortOption(sort?: string | null): ValidSortOption | undefined {
  if (!sort) return undefined
  const value = sort.trim().toLowerCase()
  if (!value) return undefined
  if ((VALID_SORT_OPTIONS as readonly string[]).includes(value)) return value as ValidSortOption
  return SORT_ALIASES[value]
}

/** 值得重试的状态码（429 单独处理） */
const RETRYABLE_STATUS = new Set([408, 413, 500, 502, 503, 504, 521, 522, 524])

export class ApiService {
  private cache: InMemoryCache | null = null
  private http: HttpManager
  private limiter: SlidingWindowRateLimiter
  private apiGate: Semaphore

  // CDN 配置缓存
  private cdn: { image: string[]; thumb: string[] } | null = null
  private lastCdnUpdate = 0
  private cdnNextRetry = 0
  private announcement: string | null = null
  private hostHealth = new Map<string, CdnHostHealth>()

  private metrics: ApiMetrics = { requests: 0, cacheHits: 0, errors: 0, retries: 0, rateLimitPenalties: 0 }

  constructor(ctx: Context, private config: Config) {
    this.http = new HttpManager(ctx, config)

    // 按官方公布的限额建立逐端点配额（携带 API Key 时使用更高的一档）
    const rules: Record<string, RateLimitRule> = {}
    for (const [key, tiers] of Object.entries(API_RATE_LIMITS)) {
      rules[key] = config.apiKey ? tiers.auth : tiers.anon
    }
    this.limiter = new SlidingWindowRateLimiter(rules, RATE_LIMIT_SAFETY_FACTOR)
    this.apiGate = new Semaphore(API_MAX_CONCURRENCY)
  }

  async initialize(): Promise<void> {
    this.cache = new InMemoryCache({
      maxSize: 500,
      defaultTTL: this.config.cache.apiCacheTTL * 60_000,
    })
    logger.info(
      `HTTP 传输层就绪（ctx.http）；缓存 TTL ${this.config.cache.apiCacheTTL} 分钟；` +
        `限流档位：${this.config.apiKey ? 'API Key' : '匿名'}`,
    )
  }

  /** 图片下载共用同一套请求头与传输层 */
  get imageHttp(): HttpManager {
    return this.http
  }

  // ─── 缓存 ──────────────────────────────────────────────────

  private async getCached<T>(key: string): Promise<T | null> {
    if (!this.config.cache.enableApiCache || !this.cache) return null
    const cached = await this.cache.get<T>(key)
    if (cached === undefined) return null
    this.metrics.cacheHits++
    if (this.config.debug) logger.debug(`命中缓存: ${key}`)
    return cached
  }

  private async setCached<T>(key: string, data: T): Promise<void> {
    if (!this.config.cache.enableApiCache || !this.cache) return
    await this.cache.set(key, data, this.config.cache.apiCacheTTL * 60_000)
  }

  // ─── 请求执行 ──────────────────────────────────────────────

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${API_BASE}${path}`)
    for (const [name, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(name, String(value))
    }
    return url.toString()
  }

  /** Retry-After 可能是秒数或 HTTP 日期；ctx.http 给出的响应头是 Headers 对象 */
  private parseRetryAfter(headers: Headers | Record<string, unknown> | undefined): number {
    let raw: string | null | undefined
    if (headers && typeof (headers as Headers).get === 'function') {
      raw = (headers as Headers).get('retry-after')
    } else if (headers) {
      const record = headers as Record<string, unknown>
      raw = (record['retry-after'] ?? record['Retry-After']) as string | undefined
    }
    if (raw === undefined || raw === null) return 5000
    const value = String(raw).trim()
    if (/^\d+$/.test(value)) return Math.min(parseInt(value, 10) * 1000, 120_000)
    const at = Date.parse(value)
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), 120_000)
    return 5000
  }

  /**
   * 统一请求入口：缓存 → 限流配额 → 并发闸门 → 429 退避 → 错误归类。
   * 失败时返回 null，由调用方决定降级行为。
   */
  private async request<T>(options: {
    key: RateLimitKey
    path: string
    label: string
    method?: 'GET' | 'POST'
    query?: Record<string, string | number | undefined>
    cacheKey?: string
    /** 可选请求：配额不足时立即放弃（返回 null）而不是排队等待 */
    optional?: boolean
  }): Promise<T | null> {
    const { key, path, label, method = 'GET', query, cacheKey, optional = false } = options

    if (cacheKey) {
      const cached = await this.getCached<T>(cacheKey)
      if (cached !== null) return cached
    }

    if (optional) {
      if (!this.limiter.tryAcquire(key)) {
        const remaining = this.limiter.cooldownRemaining(key)
        logger.info(
          `${label}: 客户端配额已用尽${remaining > 0 ? `（冷却 ${Math.ceil(remaining / 1000)}s）` : ''}，跳过本次可选请求`,
        )
        return null
      }
    } else {
      await this.limiter.acquire(key, label)
    }

    try {
      const data = await this.apiGate.run(() => this.execute<T>(key, path, method, query, label, !optional))
      if (cacheKey) await this.setCached(cacheKey, data)
      return data
    } catch (error) {
      this.metrics.errors++
      this.logRequestError(label, error)
      return null
    }
  }

  private async execute<T>(
    key: RateLimitKey,
    path: string,
    method: 'GET' | 'POST',
    query: Record<string, string | number | undefined> | undefined,
    label: string,
    /** 可选请求不等待 Retry-After，直接失败以便上层降级 */
    allowRateLimitRetry: boolean,
  ): Promise<T> {
    const url = this.buildUrl(path, query)
    // 429 按 Retry-After 单独处理；其他可重试状态码与网络错误走指数退避
    const rateLimitAttempts = allowRateLimitRetry ? 2 : 1
    const maxAttempts = allowRateLimitRetry ? 3 : 1

    for (let attempt = 1; ; attempt++) {
      this.metrics.requests++
      try {
        return await this.http.json<T>(url, { method, timeoutMs: API_REQUEST_TIMEOUT_MS })
      } catch (error) {
        const status = this.statusOf(error)

        if (status === 429) {
          const retryAfterMs = this.parseRetryAfter(this.headersOf(error))
          this.metrics.rateLimitPenalties++
          this.limiter.penalize(key, retryAfterMs)
          if (attempt < rateLimitAttempts) {
            this.metrics.retries++
            logger.warn(`${label}: 触发官方速率限制（${key}），${(retryAfterMs / 1000).toFixed(1)}s 后重试`)
            await sleep(retryAfterMs)
            continue
          }
          throw error
        }

        if ((status === undefined || RETRYABLE_STATUS.has(status)) && attempt < maxAttempts) {
          this.metrics.retries++
          const delayMs = Math.min(1000 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 200)
          logger.debug(
            `${label}: 第 ${attempt} 次请求失败（${status ?? getErrorMessage(error)}），${delayMs}ms 后重试`,
          )
          await sleep(delayMs)
          continue
        }
        throw error
      }
    }
  }

  /** ctx.http 的错误对象上带有 response.status / response.headers */
  private statusOf(error: unknown): number | undefined {
    const status = (error as any)?.response?.status
    return typeof status === 'number' ? status : undefined
  }

  private headersOf(error: unknown): Headers | undefined {
    const headers = (error as any)?.response?.headers
    return headers && typeof headers.get === 'function' ? (headers as Headers) : undefined
  }

  private logRequestError(label: string, error: unknown): void {
    const status = this.statusOf(error)
    const body = (error as any)?.response?.data
    const apiMessage =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : undefined

    if (status === 404) return logger.warn(`${label}: ${apiMessage || '资源不存在或已被删除'}`)
    if (status === 401 || status === 403) {
      return logger.warn(`${label}: ${apiMessage || '未授权（请检查 API Key 是否正确）'}`)
    }
    if (status === 422) {
      const detail = (body as ApiValidationError)?.detail
        ?.map((item) => `${(item.loc || []).join('.')}: ${item.msg}`)
        .join('; ')
      return logger.warn(`${label}: 请求参数未通过校验${detail ? ` - ${detail}` : ''}`)
    }
    if (status === 429) return logger.warn(`${label}: 触发官方速率限制，请稍后重试`)
    if (status && status >= 500) return logger.warn(`${label}: 服务端错误 HTTP ${status}`)
    logger.error(`${label} 失败: ${getErrorMessage(error)}`)
  }

  // ─── 数据转换 ──────────────────────────────────────────────

  /** 官方 CDN 的封面路径会重复扩展名（galleries/xxx/cover.webp.webp），此处归一化 */
  private cleanPath(path: string): string {
    if (!path) return path
    return path.replace(/\.(webp|jpg|jpeg|png)\.(webp|jpg|jpeg|png)$/i, '.$1')
  }

  private transformTag(tag: ApiTag): Tag {
    return {
      id: tag.id,
      type: tag.type,
      name: tag.name,
      url: tag.url,
      count: tag.count,
      slug: tag.slug,
    }
  }

  private transformListItem(item: ApiGalleryListItem): SearchGallery {
    return {
      id: item.id,
      media_id: item.media_id,
      english_title: item.english_title || '',
      japanese_title: item.japanese_title ?? null,
      thumbnail: this.cleanPath(item.thumbnail),
      thumbnail_width: item.thumbnail_width,
      thumbnail_height: item.thumbnail_height,
      num_pages: item.num_pages ?? 0,
      num_favorites: item.num_favorites ?? 0,
      tag_ids: item.tag_ids ?? [],
      blacklisted: item.blacklisted ?? false,
    }
  }

  private transformGalleryResponse(raw: ApiGalleryDetail): Gallery {
    return {
      id: String(raw.id),
      media_id: raw.media_id,
      title: {
        english: raw.title?.english ?? '',
        japanese: raw.title?.japanese ?? '',
        pretty: raw.title?.pretty ?? '',
      },
      images: {
        pages: (raw.pages || []).map((page) => ({
          ...page,
          path: this.cleanPath(page.path),
          // v2 的 PageInfo.thumbnail 是字符串（旧版才是对象）
          thumbnail: this.cleanPath(page.thumbnail),
        })),
        cover: raw.cover
          ? { ...raw.cover, path: this.cleanPath(raw.cover.path) }
          : { path: '', width: 0, height: 0 },
        thumbnail: raw.thumbnail
          ? { ...raw.thumbnail, path: this.cleanPath(raw.thumbnail.path) }
          : { path: '', width: 0, height: 0 },
      },
      scanlator: raw.scanlator ?? '',
      upload_date: raw.upload_date,
      tags: (raw.tags || []).map((tag) => this.transformTag(tag)),
      num_pages: raw.num_pages,
      num_favorites: raw.num_favorites,
      related: raw.related ? raw.related.map((item) => this.transformListItem(item)) : undefined,
    }
  }

  private toSearchResult(
    items: ApiGalleryListItem[],
    numPages?: number,
    perPage?: number,
    total?: number | null,
  ): SearchResult {
    const result = items.map((item) => this.transformListItem(item))
    return {
      result,
      num_pages: numPages ?? (result.length > 0 ? 1 : 0),
      per_page: perPage ?? result.length,
      total: total ?? result.length,
    }
  }

  private normalizeGalleryId(id: string | number): string | null {
    const value = String(id ?? '').trim()
    return /^\d+$/.test(value) ? value : null
  }

  // ─── 画廊 ──────────────────────────────────────────────────

  /**
   * GET /api/v2/galleries/{id}
   *
   * @param options.include 官方 include 参数，取值 comments / related / favorite / suggestions。
   *   需要“详情 + 相关作品”时使用 include: ['related']，可比再请求 /related 少消耗一次配额。
   */
  async getGallery(id: string | number, options: { include?: GalleryInclude[] } = {}): Promise<Gallery | null> {
    const galleryId = this.normalizeGalleryId(id)
    if (!galleryId) {
      logger.warn(`无效的画廊 ID: ${id}`)
      return null
    }

    const includes = (options.include || []).filter((value): value is GalleryInclude =>
      (GALLERY_INCLUDES as readonly string[]).includes(value),
    )
    if ((options.include || []).length !== includes.length) {
      logger.warn(`include 参数包含官方不支持的值，已忽略：${options.include?.join(',')}`)
    }

    const suffix = includes.length ? `:${includes.join(',')}` : ''
    const raw = await this.request<ApiGalleryDetail>({
      key: 'gallery',
      path: `/galleries/${galleryId}`,
      query: includes.length ? { include: includes.join(',') } : undefined,
      cacheKey: `nhentai:gallery:${galleryId}${suffix}`,
      label: `画廊 ${galleryId}`,
    })

    if (!raw) return null
    if (typeof raw.id === 'undefined') {
      logger.warn(`画廊 ${galleryId} 返回了无效的响应结构`)
      return null
    }
    if (this.config.returnApiJson) {
      logger.info(`[API响应] 画廊 ${galleryId}:\n${JSON.stringify(raw, null, 2)}`)
    }
    return this.transformGalleryResponse(raw)
  }

  /** GET /api/v2/galleries/random —— 官方只返回 { id }，需再取一次详情 */
  async getRandomGallery(): Promise<Gallery | null> {
    const raw = await this.request<ApiRandomGallery>({
      key: 'random',
      path: '/galleries/random',
      label: '随机画廊',
    })
    if (!raw || typeof raw.id === 'undefined') return null
    // 随机结果不做缓存，否则会反复返回同一本
    return this.getGallery(raw.id)
  }

  /**
   * GET /api/v2/search
   *
   * 支持关键词、精确短语、取反、标签过滤、数值与日期过滤（详见官方文档），
   * sort 取值为 date / popular / popular-today / popular-week / popular-month。
   */
  async searchGalleries(query: string, page = 1, sort?: string): Promise<SearchResult | null> {
    const keyword = (query || '').trim()
    if (!keyword) {
      logger.warn('搜索关键词为空，已跳过请求')
      return null
    }

    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
    const normalizedSort = normalizeSortOption(sort)
    if (sort && !normalizedSort) {
      logger.warn(`排序选项 "${sort}" 不受官方 API 支持，已按默认（date）处理`)
    }

    const raw = await this.request<ApiPaginated<ApiGalleryListItem>>({
      key: 'search',
      path: '/search',
      query: { query: keyword, page: safePage, sort: normalizedSort },
      cacheKey: `nhentai:search:${keyword}:${safePage}:${normalizedSort || ''}`,
      label: `搜索 "${keyword}"`,
    })

    if (!raw) return null
    if (!Array.isArray(raw.result)) {
      logger.warn(`搜索 "${keyword}" 返回了意外的数据结构`)
      return { result: [], num_pages: 0, per_page: 25 }
    }
    logger.debug(`搜索 "${keyword}" 第 ${safePage} 页：${raw.result.length} 条 / 共 ${raw.num_pages} 页`)
    return this.toSearchResult(raw.result, raw.num_pages, raw.per_page, raw.total)
  }

  /**
   * GET /api/v2/galleries/popular
   *
   * 官方返回的是**数组**（GalleryListItem[]），没有分页参数，限额 8/分钟。
   */
  async getPopularGalleries(): Promise<SearchResult | null> {
    const raw = await this.request<ApiGalleryListItem[]>({
      key: 'popular',
      path: '/galleries/popular',
      cacheKey: 'nhentai:popular',
      label: '热门画廊',
    })

    if (!raw) return null
    if (!Array.isArray(raw)) {
      logger.warn('热门画廊返回了意外的数据结构')
      return { result: [], num_pages: 0, per_page: 0 }
    }
    return this.toSearchResult(raw)
  }

  /** GET /api/v2/galleries/{id}/related —— 返回 { result }，无分页字段 */
  async getRelatedGalleries(id: string | number): Promise<SearchResult | null> {
    const galleryId = this.normalizeGalleryId(id)
    if (!galleryId) {
      logger.warn(`无效的画廊 ID: ${id}`)
      return null
    }
    const raw = await this.request<ApiRelatedGalleries>({
      key: 'related',
      path: `/galleries/${galleryId}/related`,
      cacheKey: `nhentai:related:${galleryId}`,
      label: `画廊 ${galleryId} 的相关作品`,
    })

    if (!raw) return null
    if (!Array.isArray(raw.result)) {
      logger.warn(`画廊 ${galleryId} 的相关作品返回了意外的数据结构`)
      return { result: [], num_pages: 0, per_page: 0 }
    }
    return this.toSearchResult(raw.result)
  }

  /**
   * POST /api/v2/galleries/{id}/download
   *
   * 需要 API Key（官方还须开启 allow_downloads），返回带 expires_at 的短时效直链。
   * 该直链由官方打包，不经过插件的图片处理流程，仅在需要官方原始压缩包时使用。
   */
  async getGalleryDownloadUrl(
    id: string | number,
    format: DownloadFormat = 'zip',
  ): Promise<ApiDownloadResponse | null> {
    if (!this.config.apiKey) {
      logger.warn('官方下载接口需要 API Key，请在插件配置中填写')
      return null
    }
    const galleryId = this.normalizeGalleryId(id)
    if (!galleryId) {
      logger.warn(`无效的画廊 ID: ${id}`)
      return null
    }
    if (!(DOWNLOAD_FORMATS as readonly string[]).includes(format)) {
      logger.warn(`不支持的下载格式: ${format}`)
      return null
    }

    const data = await this.request<ApiDownloadResponse>({
      key: 'download',
      path: `/galleries/${galleryId}/download`,
      method: 'POST',
      query: { format },
      label: `画廊 ${galleryId} 下载直链`,
      // 官方签发限额很紧（实测 429 后需冷却 300s），配额不足时直接降级到 CDN，
      // 绝不把用户的下载请求卡住数分钟
      optional: true,
    })

    if (!data?.url) return null
    if (data.expires_at && data.expires_at * 1000 <= Date.now()) {
      logger.warn(`画廊 ${galleryId} 的下载直链已过期`)
      return null
    }
    return data
  }

  // ─── CDN ───────────────────────────────────────────────────

  private extractHosts(servers: unknown): string[] {
    if (!Array.isArray(servers)) return []
    const hosts: string[] = []
    for (const entry of servers) {
      if (typeof entry !== 'string' || !entry) continue
      let host = entry
      if (entry.includes('://')) {
        try {
          host = new URL(entry).hostname
        } catch {
          continue
        }
      }
      if (host && !hosts.includes(host)) hosts.push(host)
    }
    return hosts
  }

  private health(host: string): CdnHostHealth {
    let entry = this.hostHealth.get(host)
    if (!entry) {
      entry = { failures: 0, cooldownUntil: 0, latencyMs: 0, samples: 0 }
      this.hostHealth.set(host, entry)
    }
    return entry
  }

  /** 冷却中的主机排到最后，其余按实测延迟升序，未采样的保持官方顺序 */
  private orderHosts(hosts: string[]): string[] {
    const now = Date.now()
    return hosts
      .map((host, index) => ({ host, index, health: this.hostHealth.get(host) }))
      .sort((a, b) => {
        const aCooling = (a.health?.cooldownUntil ?? 0) > now ? 1 : 0
        const bCooling = (b.health?.cooldownUntil ?? 0) > now ? 1 : 0
        if (aCooling !== bCooling) return aCooling - bCooling
        const aLatency = a.health?.samples ? a.health.latencyMs : Number.POSITIVE_INFINITY
        const bLatency = b.health?.samples ? b.health.latencyMs : Number.POSITIVE_INFINITY
        if (aLatency !== bLatency) return aLatency - bLatency
        return a.index - b.index
      })
      .map((entry) => entry.host)
  }

  /**
   * GET /api/v2/config —— GET /api/v2/cdn 的超集（额外返回 announcement），
   * 因此只用这一个端点，一次请求同时拿到 CDN 列表与公告。
   */
  async getCdnServers(): Promise<{ image: string[]; thumb: string[] }> {
    const now = Date.now()
    if (this.cdn && now - this.lastCdnUpdate < CDN_CONFIG_TTL_MS && now >= this.cdnNextRetry) {
      return { image: this.orderHosts(this.cdn.image), thumb: this.orderHosts(this.cdn.thumb) }
    }

    const raw = await this.request<ApiAppConfig>({
      key: 'config',
      path: '/config',
      label: 'CDN 配置',
    })

    if (raw) {
      const image = this.extractHosts(raw.image_servers)
      const thumb = this.extractHosts(raw.thumb_servers)
      if (image.length > 0) {
        this.cdn = { image, thumb: thumb.length > 0 ? thumb : image }
        this.lastCdnUpdate = now
        this.cdnNextRetry = 0

        const message = raw.announcement?.message?.trim()
        if (message && message !== this.announcement) {
          this.announcement = message
          logger.info(`nhentai 公告: ${message}`)
        }
        logger.debug(`CDN 已更新 - 图片: ${image.join(', ')} | 缩略图: ${this.cdn.thumb.join(', ')}`)
        return { image: this.orderHosts(image), thumb: this.orderHosts(this.cdn.thumb) }
      }
      logger.warn(`CDN 配置为空或格式无效: ${JSON.stringify(raw).slice(0, 200)}`)
    }

    // 降级：保留上一次成功的列表，否则使用内置兜底主机；1 分钟后允许再次尝试
    this.cdnNextRetry = now + 60_000
    if (!this.cdn) {
      this.cdn = { image: [DEFAULT_IMAGE_CDN], thumb: [DEFAULT_THUMB_CDN] }
      this.lastCdnUpdate = now
      logger.warn(`CDN 配置获取失败，使用内置后备主机 [${DEFAULT_IMAGE_CDN} | ${DEFAULT_THUMB_CDN}]`)
    }
    return { image: this.orderHosts(this.cdn.image), thumb: this.orderHosts(this.cdn.thumb) }
  }

  /** 上报一次 CDN 请求结果，用于主机的冷却与延迟排序 */
  reportCdnResult(host: string, ok: boolean, latencyMs = 0): void {
    if (!host) return
    const entry = this.health(host)
    if (ok) {
      entry.failures = 0
      entry.cooldownUntil = 0
      entry.samples++
      entry.latencyMs = entry.samples === 1 ? latencyMs : entry.latencyMs * 0.7 + latencyMs * 0.3
      return
    }
    entry.failures++
    entry.cooldownUntil = Date.now() + Math.min(30_000 * entry.failures, 300_000)
    logger.debug(
      `CDN ${host} 连续失败 ${entry.failures} 次，冷却 ${Math.round((entry.cooldownUntil - Date.now()) / 1000)}s`,
    )
  }

  getMetrics(): ApiMetrics & { rateLimiterWaits: number; rateLimiterWaitMs: number; trackedCdnHosts: number } {
    return {
      ...this.metrics,
      rateLimiterWaits: this.limiter.totalWaits,
      rateLimiterWaitMs: this.limiter.totalWaitMs,
      trackedCdnHosts: this.hostHealth.size,
    }
  }

  dispose(): void {
    this.apiGate.drain()
    this.limiter.reset()
    this.hostHealth.clear()
    this.cache?.dispose()
    this.cache = null
    this.cdn = null
    this.lastCdnUpdate = 0
    this.http.dispose()
    if (this.config.debug) {
      logger.info(
        `ApiService 已释放（请求 ${this.metrics.requests} 次，缓存命中 ${this.metrics.cacheHits} 次，` +
          `失败 ${this.metrics.errors} 次，限流等待 ${this.limiter.totalWaits} 次）`,
      )
    }
  }
}
