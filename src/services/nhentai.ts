/**
 * 对外服务：把接口层与处理器组装成「查画廊、取封面、下载」三件事。
 */
import type { Config } from '../config'
import { logger, getErrorMessage } from '../utils'
import { DEFAULT_THUMB_CDN, COVER_DOWNLOAD_TIMEOUT_MS } from '../constants'
import { Processor } from '../processor'
import type { Gallery, SearchGallery, MenuGallery } from '../types'
import { ApiService } from './api'
import { DownloadManager } from './download'

// 超时控制辅助函数
async function downloadWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = '下载超时'
): Promise<T> {
  let timeoutId: NodeJS.Timeout

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId!)
  }
}

export interface GalleryWithCover {
  gallery: Gallery
  cover?: {
    buffer: Buffer
    extension: string
  }
}

export interface DownloadedImage {
  path?: string
  buffer?: Buffer
  extension: string
  index: number
}

export type DownloadOutput =
  | { type: 'pdf'; path: string; filename: string; isTemporary: boolean }
  | { type: 'zip'; buffer: Buffer; filename: string }
  | { type: 'images'; images: DownloadedImage[]; filename: string; failedIndexes: number[] }

interface CdnServers {
  image: string[]
  thumb: string[]
}

export class CoverService {
  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
  ) {}

  /** 用缩略图主机拼出缩略图 URL（失败时由 downloadImage 切换到其余缩略图主机） */
  private buildThumbUrl(path: string, servers: CdnServers): string {
    const host = servers.thumb[0] || DEFAULT_THUMB_CDN
    return `https://${host}/${path}`
  }

  /**
   * 列表项（SearchGallery）只有字符串 thumbnail，详情（Gallery）同时有 thumbnail 与 cover。
   *
   * 详情卡片按 400×600 显示，thumbnail 是 250×350（放大约 1.6 倍），
   * cover 是 350×490（放大约 1.2 倍），所以单张封面优先取 cover 更清晰。
   */
  private resolveThumbPath(gallery: MenuGallery, prefer: 'thumb' | 'cover' = 'thumb'): string | null {
    if (typeof (gallery as any).thumbnail === 'string') {
      return (gallery as SearchGallery).thumbnail || null
    }
    const fullGallery = gallery as Gallery
    const thumb = fullGallery.images?.thumbnail?.path
    const cover = fullGallery.images?.cover?.path
    return prefer === 'cover' ? cover || thumb || null : thumb || cover || null
  }

  private async processDownloadResult(
    result: any,
    galleryId: string,
  ): Promise<{ buffer: Buffer; extension: string } | null> {
    try {
      if (!('buffer' in result)) {
        // 检查是否是错误对象
        if ('error' in result && result.error instanceof Error) {
          logger.warn(`画廊 ${galleryId} 缩略图下载失败: ${result.error.message}`)
        } else if (this.config.debug) {
          logger.warn(`画廊 ${galleryId} 下载结果无 buffer 属性: ${JSON.stringify(Object.keys(result))}`)
        } else {
          logger.warn(`画廊 ${galleryId} 下载结果无效（无 buffer 属性）`)
        }
        return null
      }

      if (!result.buffer) {
        logger.warn(`画廊 ${galleryId} 下载结果 buffer 为空: ${result.buffer}`)
        return null
      }

      if (!Buffer.isBuffer(result.buffer)) {
        logger.warn(`画廊 ${galleryId} 下载结果 buffer 类型错误: ${typeof result.buffer}`)
        return null
      }

      // 缩略图只用于菜单预览：加完水印用 webp 低质量输出，避免体积翻几倍
      const processed = await this.processor.applyAntiGzip(result.buffer, `thumb-${galleryId}`, 'webp', 80)
      const extension = processed.format === 'original' ? result.extension : processed.format
      return { buffer: processed.buffer, extension }
    } catch (error) {
      const errorMsg = getErrorMessage(error)
      logger.error(`处理画廊 ${galleryId} 下载结果失败: ${errorMsg}`)
      // AntiGzip 失败时返回原始 buffer
      if ('buffer' in result && result.buffer && Buffer.isBuffer(result.buffer)) {
        return { buffer: result.buffer, extension: result.extension || 'jpg' }
      }
      return null
    }
  }

  /** 下载单张缩略图；servers 由调用方批量获取一次后复用 */
  private async fetchCover(
    gallery: MenuGallery,
    servers: CdnServers,
    timeoutMs?: number,
    prefer: 'thumb' | 'cover' = 'thumb',
  ): Promise<{ buffer: Buffer; extension: string } | null> {
    const galleryId = String(gallery.id)
    const path = this.resolveThumbPath(gallery, prefer)
    if (!path) {
      if (this.config.debug) logger.debug(`画廊 ${galleryId} 缺少缩略图或封面`)
      return null
    }

    const download = this.processor.downloadImage({
      http: this.apiService.imageHttp,
      url: this.buildThumbUrl(path, servers),
      index: 0,
      galleryId,
      mediaId: String(gallery.media_id),
      retries: Math.min(this.config.downloadRetries, 3),
      fallbackHosts: servers.thumb,
      onHostResult: (host, ok, latencyMs) => this.apiService.reportCdnResult(host, ok, latencyMs),
    })

    const result = timeoutMs ? await downloadWithTimeout(download, timeoutMs, '缩略图下载超时') : await download
    return this.processDownloadResult(result, galleryId)
  }

  async downloadCover(gallery: Gallery): Promise<{ buffer: Buffer; extension: string } | null> {
    try {
      const servers = await this.apiService.getCdnServers()
      // 单张封面用于详情卡片，取分辨率更高的 cover
      return await this.fetchCover(gallery, servers, undefined, 'cover')
    } catch (e) {
      const errorMsg = getErrorMessage(e)
      logger.warn(`下载画廊 ${gallery.id} 的缩略图失败: ${errorMsg}`)
      return null
    }
  }

  async downloadCoversForGalleries(
    galleries: MenuGallery[],
  ): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    const covers = new Map<string, { buffer: Buffer; extension: string }>()
    if (galleries.length === 0) return covers

    // 一次性取得 CDN 配置（内部有缓存），避免在每个 worker 循环里反复 await
    let servers: CdnServers
    try {
      servers = await this.apiService.getCdnServers()
    } catch (error) {
      logger.warn(`获取 CDN 配置失败，缩略图将使用默认主机: ${getErrorMessage(error)}`)
      servers = { image: [], thumb: [DEFAULT_THUMB_CDN] }
    }

    const galleryQueue = [...galleries]
    const concurrency = Math.min(Math.min(this.config.downloadConcurrency, 10), galleries.length)

    const workerTasks = Array.from({ length: concurrency }, async () => {
      try {
        let gallery: MenuGallery | undefined

        while ((gallery = galleryQueue.shift())) {
          if (!gallery?.id || !gallery?.media_id) continue

          try {
            const processed = await this.fetchCover(gallery, servers, COVER_DOWNLOAD_TIMEOUT_MS)
            if (processed) {
              covers.set(String(gallery.id), processed)
            }
          } catch (itemError) {
            const errorMsg = getErrorMessage(itemError)
            logger.warn(`处理画廊 ${gallery?.id} 缩略图时出错: ${errorMsg}`)
            // 继续处理下一个，不中断整个队列
          }
        }
      } catch (workerError) {
        const errorMsg = getErrorMessage(workerError)
        logger.error(`Worker 线程异常: ${errorMsg}`)
      }
    })

    try {
      await Promise.all(workerTasks)
    } catch (error) {
      const errorMsg = getErrorMessage(error)
      logger.error(`批量下载封面失败: ${errorMsg}`)
    }
    return covers
  }
}

export class NhentaiService {
  private coverService: CoverService
  private downloadManager: DownloadManager

  constructor(
    private apiService: ApiService,
    private config: Config,
    processor: Processor,
  ) {
    this.coverService = new CoverService(config, apiService, processor)
    this.downloadManager = new DownloadManager(config, apiService, processor)
  }

  async getGalleryWithCover(id: string): Promise<GalleryWithCover | null> {
    const gallery = await this.apiService.getGallery(id)
    if (!gallery) return null

    // 如果是文本模式且禁用缩略图，则不下载封面
    if (this.config.searchMode === 'text' && !this.config.textMode.showThumbnails) {
      return { gallery }
    }

    const cover = await this.coverService.downloadCover(gallery)
    return cover ? { gallery, cover } : { gallery }
  }

  async getCoversForGalleries(
    galleries: MenuGallery[],
  ): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    return this.coverService.downloadCoversForGalleries(galleries)
  }

  // 获取随机画廊 ID
  async getRandomGalleryId(): Promise<string | null> {
    try {
      const randomGallery = await this.apiService.getRandomGallery()

      if (!randomGallery || !randomGallery.id) {
        throw new Error('获取随机画廊失败')
      }

      logger.debug(`获取到随机画廊ID: ${randomGallery.id}`)
      return randomGallery.id
    } catch (error) {
      const errorMsg = getErrorMessage(error)
      logger.error(`获取随机画廊ID时出错: ${errorMsg}`)
      return null
    }
  }

  async downloadGallery(
    id: string,
    outputType: 'pdf' | 'zip' | 'img',
    password?: string,
    onProgress: (status: string) => Promise<void> = async () => {},
  ): Promise<DownloadOutput | { error: string }> {
    return this.downloadManager.downloadGallery(id, outputType, password, onProgress)
  }
}
