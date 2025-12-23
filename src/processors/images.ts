import { GotScraping } from 'got-scraping'
import * as path from 'path'
import { CanvasImageProcessor, DownloadedImage, ProcessedImage } from './types'
import { Config } from '../config'
import { logger, sleep } from '../utils'
import { IMAGE_HOST_FALLBACK, THUMB_HOST_FALLBACK } from '../constants'
import { ImageCache } from '../services/cache'

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

// 辅助函数：对主机列表进行优先级排序，将成功的主机置于首位
function prioritizeSuccessfulHost(
  hostsToTry: string[],
  successfulHosts: Map<string, string>,
  gid: string,
): void {
  if (hostsToTry.length <= 1) return

  const preferredHost = successfulHosts.get(gid)
  if (preferredHost && hostsToTry.includes(preferredHost)) {
    const idx = hostsToTry.indexOf(preferredHost)
    if (idx > 0) {
      hostsToTry.splice(idx, 1)
      hostsToTry.unshift(preferredHost)
    }
  }
}

// 辅助函数：构建请求选项对象
function buildRequestOptions(gid: string, config: Config, sessionToken?: object): any {
  const options: any = {
    headers: { Referer: `https://nhentai.net/g/${gid}/` },
    timeout: { request: config.downloadTimeout * 1000 },
    throwHttpErrors: true,
  }
  if (sessionToken) {
    options.sessionToken = sessionToken
  }
  return options
}

// 根据输出模式和配置转换图片格式
export async function convertImageForMode(
  processor: CanvasImageProcessor,
  buffer: Buffer,
  format: string,
  mode: 'pdf' | 'zip' | 'image',
  config: Config,
): Promise<{ buffer: Buffer; finalFormat: string }> {
  // 图片模式：直接返回原始格式
  if (mode === 'image') {
    return { buffer, finalFormat: format }
  }

  // PDF 和 ZIP 模式：根据配置转换格式以便压缩
  if ((mode === 'pdf' || mode === 'zip') && config.imageCompression.enabled) {
    // 已经是目标格式，无需转换
    const targetFormat = config.imageCompression.targetFormat
    if (format === targetFormat || (targetFormat === 'jpeg' && format === 'jpg')) {
      return { buffer, finalFormat: format }
    }

    // 转换为目标格式
    try {
      const quality = config.imageCompression.quality
      if (targetFormat === 'jpeg') {
        const result = await processor.convertToJpeg(new Uint8Array(buffer), quality)
        return { buffer: Buffer.from(result), finalFormat: 'jpeg' }
      } else {
        const result = await processor.convertToPng(new Uint8Array(buffer))
        return { buffer: Buffer.from(result), finalFormat: 'png' }
      }
    } catch (error) {
      logger.error(`格式转换失败 (${format} → ${targetFormat}): ${error.message}`)
      throw new Error(`无法转换图片格式: ${error.message}`)
    }
  }

  return { buffer, finalFormat: format }
}

// 根据配置对 JPEG 图片进行条件压缩
export async function conditionallyCompressJpeg(
  processor: CanvasImageProcessor,
  buffer: Buffer,
  format: string,
  threshold: number,
  quality: number,
  enableCompression: boolean,
  debug: boolean,
): Promise<Buffer> {
  if (!enableCompression || (format !== 'jpeg' && format !== 'jpg')) {
    return buffer
  }

  const sizeKB = buffer.length / 1024
  if (threshold > 0 && sizeKB <= threshold) {
    debug && logger.debug(`JPEG ${sizeKB.toFixed(1)}KB ≤ ${threshold}KB，跳过压缩`)
    return buffer
  }

  try {
    const finalQuality = Math.min(Math.max(quality, 1), 100)
    const result = await processor.compressJpeg(new Uint8Array(buffer), finalQuality, 0)
    if (debug) {
      const compressedSize = result.length / 1024
      const savedSize = ((1 - compressedSize / sizeKB) * 100).toFixed(1)
      logger.debug(`JPEG 压缩: ${sizeKB.toFixed(1)}KB → ${compressedSize.toFixed(1)}KB (节省 ${savedSize}%)`)
    }
    return Buffer.from(result)
  } catch (error) {
    logger.error(`JPEG 压缩失败，使用原图: ${error.message}`)
    return buffer
  }
}

// 对单张图片应用反和谐处理，返回处理后的 buffer 和新格式
export async function applyAntiGzip(
  processor: CanvasImageProcessor,
  buffer: Buffer,
  config: Config,
  identifier?: string,
  preserveFormat?: boolean,
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
    // 检测原始格式
    let detectedFormat = 'jpeg'
    if (preserveFormat) {
      if (buffer.length > 12 && buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') {
        detectedFormat = 'webp'
      } else if (buffer.length > 4 && buffer[0] === 0x89 && buffer.slice(1, 4).toString() === 'PNG') {
        detectedFormat = 'png'
      }
    }

    // 添加超时保护
    const processPromise = processor.applyAntiCensorshipJpeg(new Uint8Array(buffer))
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AntiGzip 处理超时')), 10000)
    })

    const result = await Promise.race([processPromise, timeoutPromise])
    const formatLabel = preserveFormat ? detectedFormat.toUpperCase() : 'JPEG'
    debugLog && logger.info(`${logPrefix} 处理成功: ${buffer.length} -> ${result.length} bytes (${formatLabel})`)
    return { buffer: Buffer.from(result), format: detectedFormat }
  } catch (error) {
    logger.warn(`${logPrefix} 处理失败，返回原图: ${error.message}`)
    return { buffer, format: 'original' }
  }
}

// 批量对图片应用反和谐处理，返回处理后的 buffer 和格式信息数组
export async function batchApplyAntiGzip(
  processor: CanvasImageProcessor,
  images: Array<{ buffer: Buffer; identifier?: string }>,
  config: Config,
  preserveFormat?: boolean,
): Promise<Array<{ buffer: Buffer; format: string }>> {
  if (!config.antiGzip.enabled || images.length === 0) {
    return images.map((img) => ({ buffer: img.buffer, format: 'original' }))
  }

  return Promise.all(images.map((img) => applyAntiGzip(processor, img.buffer, config, img.identifier, preserveFormat)))
}

// 下载单张图片，支持缓存、重试和智能域名切换
export async function downloadImage(
  got: GotScraping,
  url: string,
  index: number,
  gid: string,
  config: Config,
  imageCache: ImageCache | null,
  successfulHosts: Map<string, string>,
  mediaId?: string,
  retries: number = config.downloadRetries,
  sessionToken?: object,
): Promise<DownloadedImage | { index: number; error: Error }> {
  const debugLog = config.debug

  // 尝试从缓存获取
  const cached = await getCachedImageIfExists(imageCache, gid, mediaId, index, url, debugLog)
  if (cached) {
    return { index, buffer: cached.buffer, extension: cached.extension, galleryId: gid, mediaId }
  }

  const originalUrl = new URL(url)
  const originalExt = getFileExtension(url)
  const fallbackExts = ['jpg', 'png'].filter((ext) => ext !== originalExt)
  const baseHostname = originalUrl.hostname

  const fallbackHosts = baseHostname.startsWith('t') ? THUMB_HOST_FALLBACK : IMAGE_HOST_FALLBACK
  const hostsToTry = [baseHostname, ...fallbackHosts]

  // 优先使用之前成功过的主机
  if (config.enableSmartRetry) {
    prioritizeSuccessfulHost(hostsToTry, successfulHosts, gid)
  }

  for (const host of hostsToTry) {
    const testUrl = new URL(url)
    testUrl.hostname = host
    const urlsWithHost = [testUrl.href, ...fallbackExts.map((ext) => testUrl.href.replace(`.${originalExt}`, `.${ext}`))]

    for (const currentUrl of urlsWithHost) {
      const buffer = await attemptDownload(got, currentUrl, gid, retries, config, sessionToken)
      if (buffer) {
        const finalExt = getFileExtension(currentUrl)
        successfulHosts.set(gid, host)

        // 保存到缓存
        await saveCacheIfPossible(imageCache, gid, mediaId, index, buffer, finalExt, currentUrl, debugLog)
        return { index, buffer, extension: finalExt, galleryId: gid, mediaId }
      }
    }
    debugLog && logger.info(`域名 ${host} 失败，切换到下一个`)
  }

  logger.error(`图片 ${index + 1} (${url}) 在所有尝试后下载失败。`)
  return { index, error: new Error('所有主备域名和图片格式均下载失败') }
}

// 内部辅助：执行单次下载尝试，利用 got-scraping 的内置重试机制
async function attemptDownload(
  got: GotScraping,
  url: string,
  gid: string,
  retries: number,
  config: Config,
  sessionToken?: object,
): Promise<Buffer | null> {
  const maxRetries = Math.max(0, retries - 2)
  const debugLog = config.debug

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const requestOptions = buildRequestOptions(gid, config, sessionToken)
      const response = await got.get(url, requestOptions)

      const contentType = response.headers['content-type']
      if (!contentType?.startsWith('image/')) {
        throw new Error(`返回的不是图片 (Content-Type: ${contentType || 'N/A'})`)
      }
      return response.rawBody
    } catch (error) {
      debugLog && logger.warn(`URL ${url} 下载失败 [${error.name || 'Error'}]: ${error.message}`)

      if (i < maxRetries) {
        const isTimeout = error.name === 'TimeoutError'
        let delay = config.downloadRetryDelay
        if (config.enableSmartRetry) {
          delay = isTimeout ? Math.min(delay * Math.pow(2, i), 10) : Math.min(delay * 0.5 * Math.pow(1.5, i), 5)
        }
        debugLog && logger.info(`等待 ${delay.toFixed(1)}s 后重试... (${i + 1}/${maxRetries})`)
        await sleep(delay * 1000)
      }
    }
  }
  return null
}
