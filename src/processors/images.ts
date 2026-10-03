import * as path from 'path'
import type { CanvasImageProcessor, DownloadedImage } from './types'
import type { Config } from '../config'
import { logger, sleep } from '../utils'
import { ANTI_GZIP_TIMEOUT_MS } from '../constants'
import { ImageCache } from '../services/cache'
import type { HttpManager } from '../services/http'

// 辅助函数：从 URL 提取文件扩展名
function getFileExtension(url: string): string {
  return path.extname(new URL(url).pathname).slice(1)
}

// 辅助函数：尝试从缓存获取图片，缓存不可用时返回 null
async function getCachedImageIfExists(
  imageCache: ImageCache | null,
  gid: string,
  mediaId: string | undefined,
  index: number,
  url: string,
  debugLog: boolean,
): Promise<{ buffer: Buffer; extension: string } | null> {
  if (!imageCache || !mediaId || !gid) return null

  const isThumb = url.includes('/thumb.')
  const cachedBuffer = await imageCache.get(gid, mediaId, index, isThumb)
  if (cachedBuffer) {
    const ext = getFileExtension(url)
    debugLog && logger.info(`缓存命中: ${isThumb ? '缩略图' : `图片 ${index + 1}`} (gid: ${gid})`)
    return { buffer: cachedBuffer, extension: ext }
  }
  return null
}

// 辅助函数：保存图片到缓存
async function saveCacheIfPossible(
  imageCache: ImageCache | null,
  gid: string,
  mediaId: string | undefined,
  index: number,
  buffer: Buffer,
  extension: string,
  url: string,
  debugLog: boolean,
): Promise<void> {
  if (!imageCache || !mediaId || !gid) return

  const isThumb = url.includes('/thumb.')
  await imageCache.set(gid, mediaId, index, buffer, extension, isThumb).catch((err) => {
    debugLog && logger.warn(`保存缓存失败: ${err.message}`)
  })
}

// 辅助函数：从 URL 提取主机名
function getHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// 辅助函数：把 URL 的 CDN 主机替换为另一台（路径与查询串保持不变）
function withHost(url: string, host: string): string {
  if (!host) return url
  try {
    const parsed = new URL(url)
    parsed.hostname = host
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * 生成重试时依次尝试的完整 URL 列表。
 * 官方 /api/v2/config 会下发多台图片服务器，enableSmartRetry 打开时按顺序切换，
 * 从而在单台 CDN 故障时自动转移到其他主机。
 */
function buildCandidates(
  url: string,
  primaryHost: string,
  fallbackHosts: string[] | undefined,
  smartRetry: boolean,
): string[] {
  if (!smartRetry || !fallbackHosts || fallbackHosts.length <= 1) return [url]
  const hosts = [primaryHost, ...fallbackHosts.filter((host) => host && host !== primaryHost)]
  return hosts.map((host) => withHost(url, host))
}

// 执行单次图片请求
async function fetchImage(http: HttpManager, url: string, gid: string, config: Config): Promise<Buffer> {
  return http.binary(url, {
    timeoutMs: config.downloadTimeout * 1000,
    referer: `https://nhentai.net/g/${gid}/`,
  })
}

// PDF 能直接嵌入的图片格式
const PDF_EMBEDDABLE_FORMATS = new Set(['jpeg', 'png'])

function normalizeImageFormat(format: string): string {
  const value = (format || '').toLowerCase()
  return value === 'jpg' ? 'jpeg' : value
}

/**
 * PDF 内页处理结果的参数指纹。
 *
 * 处理缓存必须带上它：否则用户改了 quality / maxEdge 之后，
 * 已缓存页面仍按旧参数命中，配置看起来「不生效」。
 */
export function pdfProcessVariant(config: Config): string {
  const compression = config.imageCompression
  return `q${compression.quality}-e${compression.maxEdge}${compression.enabled ? '' : '-keepjpeg'}`
}

/**
 * 把一页图片处理成打包所需的最终 Buffer。
 *
 * 已按目标格式且体积在阈值内的图片直接原样返回；其余情况只解码一次就编码到目标格式，
 * 不像早期实现那样「先转格式、再压一次」——那样 webp 页面要经历两次完整编解码。
 * 目标格式固定 JPEG：实测同一批页面编码成 PNG 会得到源体积的 5.7 倍、耗时 4.4 倍。
 */
export async function convertImageForMode(
  processor: CanvasImageProcessor,
  buffer: Buffer,
  format: string,
  mode: 'pdf' | 'zip' | 'image',
  config: Config,
): Promise<{ buffer: Buffer; finalFormat: string }> {
  // 类型守卫：验证 buffer 是否为有效的 Buffer 对象
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError(`无效的图片 buffer: ${typeof buffer}, length=${buffer?.length ?? 0}`)
  }

  const source = normalizeImageFormat(format)
  const target = 'jpeg'

  // 逐张发送：原图直出
  if (mode === 'image') {
    return { buffer, finalFormat: format }
  }

  // ZIP：图片本身已是压缩格式，重新编码只会更大更慢，原样存入即可
  if (mode === 'zip') {
    return { buffer, finalFormat: format }
  }

  const maxEdge = config.imageCompression.maxEdge
  const needsResize = maxEdge > 0 && (await processor.exceedsEdge(new Uint8Array(buffer), maxEdge))

  // PDF 只认 JPEG / PNG，源是 webp 等格式时必须转换（与压缩开关无关，否则 pdfkit 无法嵌入）
  const mustConvert = !PDF_EMBEDDABLE_FORMATS.has(source)

  // 已经是 JPEG、体积在阈值内、且不需要缩放 → 原样嵌入，一个像素都不动
  if (!mustConvert && !needsResize) {
    if (!config.imageCompression.enabled) {
      return { buffer, finalFormat: format }
    }
    if (source === target && buffer.length / 1024 <= config.imageCompression.threshold) {
      return { buffer, finalFormat: format }
    }
  }

  // 一次性解码并编码到目标格式：不再“先转格式再压一次”
  const quality = config.imageCompression.quality
  try {
    const result = await processor.processImage(new Uint8Array(buffer), target, quality, false, maxEdge)
    return { buffer: Buffer.from(result), finalFormat: target }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    logger.error(`格式转换失败 (${format} → ${target}): ${err.message}`)
    throw new Error(`无法转换图片格式: ${err.message}`)
  }
}

/**
 * 对单张图片应用反和谐处理（加水印后重新编码）。
 *
 * 返回的 format 是**实际编码格式**，调用方据此决定扩展名 / MIME。
 * 原实现固定输出 JPEG 却按输入格式（如 webp）上报，导致 MIME 与实际内容不符，
 * 缩略图还会被 JPEG@90 撑到原体积的 3~4 倍。
 */
export async function applyAntiGzip(
  processor: CanvasImageProcessor,
  buffer: Buffer,
  config: Config,
  identifier?: string,
  targetFormat: 'jpeg' | 'webp' | 'png' = 'jpeg',
  quality = 90,
): Promise<{ buffer: Buffer; format: string }> {
  if (!config.antiGzip.enabled) return { buffer, format: 'original' }

  const logPrefix = `[AntiGzip]${identifier ? ` (${identifier})` : ''}`
  const debugLog = config.debug

  // 数据验证
  if (!buffer || buffer.length === 0) {
    logger.warn(`${logPrefix} Buffer 为空,跳过处理`)
    return { buffer, format: 'original' }
  }

  try {
    const processPromise = processor.applyAntiCensorship(new Uint8Array(buffer), targetFormat, quality)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AntiGzip 处理超时')), ANTI_GZIP_TIMEOUT_MS)
    })

    const result = await Promise.race([processPromise, timeoutPromise])
    const format = normalizeImageFormat(targetFormat)
    debugLog &&
      logger.info(`${logPrefix} 处理成功: ${buffer.length} -> ${result.length} bytes (${format.toUpperCase()})`)
    return { buffer: Buffer.from(result), format }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    logger.warn(`${logPrefix} 处理失败，返回原图: ${err.message}`)
    return { buffer, format: 'original' }
  }
}

export interface DownloadImageOptions {
  http: HttpManager
  url: string
  index: number
  galleryId: string | number
  config: Config
  imageCache?: ImageCache | null
  mediaId?: string
  /** 总尝试次数（含首次），默认取 config.downloadRetries */
  retries?: number
  /** 失败时可切换的备用 CDN 主机（按优先级排序） */
  fallbackHosts?: string[]
  /** 每次请求结果回调，用于全局 CDN 健康度统计 */
  onHostResult?: (host: string, ok: boolean, latencyMs: number) => void
}

/**
 * 下载单张图片：缓存命中直接返回，否则按 retries 次尝试下载，
 * 每次尝试可切换到下一台 CDN 主机，并把结果回报给主机健康度统计。
 */
export async function downloadImage(
  options: DownloadImageOptions,
): Promise<DownloadedImage | { index: number; error: Error }> {
  const { http, url, index, galleryId, config, imageCache = null, mediaId, fallbackHosts, onHostResult } = options
  const attempts = Math.max(1, options.retries ?? config.downloadRetries)
  const debugLog = config.debug

  // 类型守卫：验证并标准化 galleryId（支持数字自动转换为字符串）
  if (galleryId === undefined || galleryId === null) {
    return { index, error: new Error('galleryId 不能为空') }
  }
  const effectiveGid = String(galleryId)
  if (!effectiveGid || effectiveGid === 'undefined' || effectiveGid === 'null') {
    return { index, error: new Error('galleryId 无效') }
  }

  // 尝试从缓存获取
  const cached = await getCachedImageIfExists(imageCache, effectiveGid, mediaId, index, url, debugLog)
  if (cached) {
    return { index, buffer: cached.buffer, extension: cached.extension, galleryId: effectiveGid, mediaId }
  }

  const ext = getFileExtension(url)
  const candidates = buildCandidates(url, getHost(url), fallbackHosts, config.enableSmartRetry)

  for (let attempt = 0; attempt < attempts; attempt++) {
    const target = candidates[Math.min(attempt, candidates.length - 1)]
    const host = getHost(target)
    const startedAt = Date.now()

    try {
      const buffer = await fetchImage(http, target, effectiveGid, config)
      onHostResult?.(host, true, Date.now() - startedAt)
      // 保存到缓存（按原始 URL 判定是否为缩略图）
      await saveCacheIfPossible(imageCache, effectiveGid, mediaId, index, buffer, ext, url, debugLog)
      return { index, buffer, extension: ext, galleryId: effectiveGid, mediaId }
    } catch (error) {
      const err = error as any
      const status: number | undefined = err?.response?.status
      onHostResult?.(host, false, Date.now() - startedAt)

      // 4xx（429/408 除外）属于确定性失败，换主机或重试都没有意义
      if (status && status >= 400 && status < 500 && status !== 429 && status !== 408) {
        logger.warn(`图片 ${index + 1} 请求失败（HTTP ${status}），不再重试: ${target}`)
        break
      }

      if (debugLog) {
        logger.warn(
          `图片 ${index + 1} 第 ${attempt + 1}/${attempts} 次下载失败 [${err?.name || 'Error'}:${err?.code || ''}] ${err?.message || err}`,
        )
      }

      if (attempt < attempts - 1) {
        const delay = Math.min(config.downloadRetryDelay * Math.pow(2, attempt), 15)
        const nextHost = getHost(candidates[Math.min(attempt + 1, candidates.length - 1)])
        if (nextHost && nextHost !== host) {
          logger.debug(`图片 ${index + 1} 将在 ${delay.toFixed(1)}s 后改用 CDN ${nextHost} 重试`)
        }
        await sleep(delay * 1000)
      }
    }
  }

  logger.error(`图片 ${index + 1} (${url}) 下载失败。`)
  return { index, error: new Error('图片下载失败') }
}
