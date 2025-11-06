import { GotScraping } from 'got-scraping'
import * as path from 'path'
import { WasmImageProcessor, DownloadedImage, ProcessedImage } from './types'
import { Config } from '../config'
import { logger, sleep } from '../utils'
import { IMAGE_HOST_FALLBACK, THUMB_HOST_FALLBACK } from '../constants'
import { ImageCache } from '../services/cache'

/**
 * 根据输出模式转换图片格式。
 */
export async function convertImageForMode(
  wasm: WasmImageProcessor,
  buffer: Buffer,
  format: string,
  mode: 'pdf' | 'zip' | 'image',
  config: Config,
): Promise<{ buffer: Buffer; finalFormat: string }> {
  if (mode === 'zip' || mode === 'image') {
    return { buffer, finalFormat: format }
  }

  if (mode === 'pdf' && format === 'webp') {
    try {
      const quality = config.pdfCompressionQuality || 85
      const wasmResult = wasm.webp_to_jpeg(new Uint8Array(buffer), quality)
      return { buffer: Buffer.from(wasmResult), finalFormat: 'jpeg' }
    } catch (error) {
      logger.error(`WebP to JPEG 转换失败: ${error.message}`)
      throw new Error(`无法转换 WebP 图片: ${error.message}`)
    }
  }

  return { buffer, finalFormat: format }
}

/**
 * 根据配置对 JPEG 图片进行条件压缩。
 */
export async function conditionallyCompressJpeg(
  wasm: WasmImageProcessor,
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
    if (debug) logger.debug(`JPEG ${(sizeKB).toFixed(1)}KB ≤ ${threshold}KB，跳过压缩`)
    return buffer
  }

  try {
    const wasmResult = wasm.compress_jpeg(new Uint8Array(buffer), Math.min(Math.max(quality, 1), 100), 0)
    if (debug) {
      const compressedSize = wasmResult.length / 1024
      const savedSize = ((1 - compressedSize / sizeKB) * 100).toFixed(1)
      logger.debug(`JPEG 压缩: ${sizeKB.toFixed(1)}KB → ${compressedSize.toFixed(1)}KB (节省 ${savedSize}%)`)
    }
    return Buffer.from(wasmResult)
  } catch (error) {
    logger.error(`JPEG 压缩失败，使用原图: ${error.message}`)
    return buffer
  }
}

/**
 * 对单张图片应用反和谐处理。
 * @returns 包含处理后的 buffer 和新格式的对象
 */
export function applyAntiGzip(
  wasm: WasmImageProcessor,
  buffer: Buffer,
  config: Config,
  identifier?: string,
): { buffer: Buffer; format: string } {
  if (!config.antiGzip.enabled) return { buffer, format: 'original' }

  const logPrefix = `[AntiGzip]${identifier ? ` (${identifier})` : ''}`
  try {
    const result = wasm.apply_anti_censorship_jpeg(new Uint8Array(buffer), 0.4)
    if (config.debug) logger.info(`${logPrefix} 处理成功: ${buffer.length} -> ${result.length} bytes (WebP)`)
    return { buffer: Buffer.from(result), format: 'webp' }
  } catch (error) {
    logger.warn(`${logPrefix} 处理失败，返回原图: ${error.message}`)
    return { buffer, format: 'original' }
  }
}

/**
 * 批量对图片应用反和谐处理。
 * @returns 包含处理后的 buffer 和格式信息的数组
 */
export function batchApplyAntiGzip(
  wasm: WasmImageProcessor,
  images: Array<{ buffer: Buffer; identifier?: string }>,
  config: Config,
): Array<{ buffer: Buffer; format: string }> {
  if (!config.antiGzip.enabled || images.length === 0) {
    return images.map((img) => ({ buffer: img.buffer, format: 'original' }))
  }

  return images.map((img) => applyAntiGzip(wasm, img.buffer, config, img.identifier))
}

/**
 * 下载单张图片，支持缓存、重试和智能域名切换。
 */
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
  if (imageCache && mediaId && gid) {
    const isThumb = url.includes('/thumb.')
    const cachedBuffer = await imageCache.get(gid, mediaId, index, isThumb)
    if (cachedBuffer) {
      const originalExt = path.extname(new URL(url).pathname).slice(1)
      if (config.debug) logger.info(`缓存命中: ${isThumb ? '缩略图' : `图片 ${index + 1}`} (gid: ${gid})`)
      return { index, buffer: cachedBuffer, extension: originalExt, galleryId: gid, mediaId }
    }
  }

  const originalUrl = new URL(url)
  const originalExt = path.extname(originalUrl.pathname).slice(1)
  const fallbackExts = ['jpg', 'png'].filter((ext) => ext !== originalExt)
  const baseHostname = originalUrl.hostname

  const fallbackHosts = baseHostname.startsWith('t') ? THUMB_HOST_FALLBACK : IMAGE_HOST_FALLBACK
  const hostsToTry = [baseHostname, ...fallbackHosts]

  if (config.enableSmartRetry && hostsToTry.length > 1) {
    const preferredHost = successfulHosts.get(gid)
    if (preferredHost && hostsToTry.includes(preferredHost)) {
      const idx = hostsToTry.indexOf(preferredHost)
      if (idx > 0) {
        hostsToTry.splice(idx, 1)
        hostsToTry.unshift(preferredHost)
      }
    }
  }

  for (const host of hostsToTry) {
    const testUrl = new URL(url)
    testUrl.hostname = host
    const urlsWithHost = [testUrl.href, ...fallbackExts.map((ext) => testUrl.href.replace(`.${originalExt}`, `.${ext}`))]

    for (const currentUrl of urlsWithHost) {
      const buffer = await attemptDownload(got, currentUrl, gid, retries, config, sessionToken)
      if (buffer) {
        const finalExt = path.extname(new URL(currentUrl).pathname).slice(1)
        successfulHosts.set(gid, host)

        if (imageCache && mediaId && gid) {
          const isThumb = currentUrl.includes('/thumb.')
          await imageCache.set(gid, mediaId, index, buffer, finalExt, isThumb).catch((err) => {
            if (config.debug) logger.warn(`保存缓存失败: ${err.message}`)
          })
        }
        return { index, buffer, extension: finalExt, galleryId: gid, mediaId }
      }
    }
    if (config.debug) logger.info(`域名 ${host} 失败，切换到下一个`)
  }

  logger.error(`图片 ${index + 1} (${url}) 在所有尝试后下载失败。`)
  return { index, error: new Error('所有主备域名和图片格式均下载失败') }
}

/**
 * 内部辅助函数，执行单次下载尝试，利用 got-scraping 的内置重试机制。
 */
async function attemptDownload(
  got: GotScraping,
  url: string,
  gid: string,
  retries: number,
  config: Config,
  sessionToken?: object,
): Promise<Buffer | null> {
  const maxRetries = Math.max(0, retries - 2)

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const requestOptions: any = {
        headers: { Referer: `https://nhentai.net/g/${gid}/` },
        timeout: { request: config.downloadTimeout * 1000 },
        throwHttpErrors: true,
      }

      if (sessionToken) {
        requestOptions.sessionToken = sessionToken
      }

      const response = await got.get(url, requestOptions)

      const contentType = response.headers['content-type']
      if (!contentType?.startsWith('image/')) {
        throw new Error(`返回的不是图片 (Content-Type: ${contentType || 'N/A'})`)
      }
      return response.rawBody
    } catch (error) {
      if (config.debug) logger.warn(`URL ${url} 下载失败 [${error.name || 'Error'}]: ${error.message}`)

      if (i < maxRetries) {
        const isTimeout = error.name === 'TimeoutError'
        let delay = config.downloadRetryDelay
        if (config.enableSmartRetry) {
          delay = isTimeout ? Math.min(delay * Math.pow(2, i), 10) : Math.min(delay * 0.5 * Math.pow(1.5, i), 5)
        }
        if (config.debug) logger.info(`等待 ${delay.toFixed(1)}s 后重试... (${i + 1}/${maxRetries})`)
        await sleep(delay * 1000)
      }
    }
  }
  return null
}
