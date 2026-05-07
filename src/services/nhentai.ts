import { Config } from '../config'
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

export class CoverService {
  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
  ) {}

  private async buildThumbUrl(gallery: Partial<Gallery>): Promise<string | null> {
    // 优先缩略图，回退到封面
    const thumb = gallery.images?.thumbnail || (gallery as any).thumbnail
    const cover = gallery.images?.cover || (gallery as any).cover

    const path = (thumb as any)?.path || (cover as any)?.path
    if (!path) return null

    try {
      const cdnServers = await this.apiService.getCdnServers()
      // 缩略图使用 thumb 服务器
      const host = cdnServers.thumb && cdnServers.thumb.length > 0 ? cdnServers.thumb[0] : DEFAULT_THUMB_CDN
      return `https://${host}/${path}`
    } catch (e) {
      return `https://${DEFAULT_THUMB_CDN}/${path}`
    }
  }

  private async processDownloadResult(result: any, galleryId: string): Promise<{ buffer: Buffer; extension: string } | null> {
    try {
      if (!('buffer' in result)) {
        // 检查是否是错误对象
        if ('error' in result && result.error instanceof Error) {
          logger.warn(`画廊 ${galleryId} 缩略图下载失败: ${result.error.message}`)
        } else {
          if (this.config.debug) {
            logger.warn(`画廊 ${galleryId} 下载结果无 buffer 属性: ${JSON.stringify(Object.keys(result))}`)
          } else {
            logger.warn(`画廊 ${galleryId} 下载结果无效（无 buffer 属性）`)
          }
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

      const processed = await this.processor.applyAntiGzip(result.buffer, `thumb-${galleryId}`, true)
      const extension = processed.format === 'original' ? result.extension : (processed.format === 'webp' ? 'webp' : (processed.format === 'png' ? 'png' : 'jpg'))
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

  async downloadCover(
    gallery: Gallery,
  ): Promise<{ buffer: Buffer; extension: string } | null> {
    try {
      const thumbUrl = await this.buildThumbUrl(gallery)
      if (!thumbUrl) {
        if (this.config.debug) logger.debug(`画廊 ${gallery.id} 缺少缩略图或封面`)
        return null
      }

      if (!this.apiService.imageGot) throw new Error('imageGot 服务未初始化')
      const result = await this.processor.downloadImage(
        this.apiService.imageGot,
        thumbUrl,
        0,
        gallery.id,
        gallery.media_id,
        1,
      )

      return this.processDownloadResult(result, gallery.id)
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

    const galleryQueue = [...galleries]
    const concurrency = Math.min(Math.min(this.config.downloadConcurrency, 10), galleries.length)

    const workerTasks = Array.from({ length: concurrency }, async () => {
      try {
        let gallery: MenuGallery | undefined

        while ((gallery = galleryQueue.shift())) {
          if (!gallery?.id || !gallery?.media_id) continue

          try {
            const isSearchGallery = typeof (gallery as any).thumbnail === 'string'
            let thumbUrl: string | null = null
            let galleryId: string

            if (isSearchGallery) {
              const searchGallery = gallery as SearchGallery
              galleryId = String(searchGallery.id)
              const thumbPath = searchGallery.thumbnail
              if (thumbPath) {
                // 使用 CDN 配置
                const cdnServers = await this.apiService.getCdnServers()
                const host = cdnServers.thumb && cdnServers.thumb.length > 0 ? cdnServers.thumb[0] : DEFAULT_THUMB_CDN
                thumbUrl = `https://${host}/${thumbPath}`
              }
            } else {
              const fullGallery = gallery as Gallery
              galleryId = fullGallery.id
              thumbUrl = await this.buildThumbUrl(fullGallery)
            }

            if (!thumbUrl) {
              if (this.config.debug) {
                logger.debug(`画廊 ${galleryId} 无有效的缩略图路径，跳过`)
              }
              continue
            }

            // 使用带超时控制的下载，确保定时器被正确清理
            if (!this.apiService.imageGot) throw new Error('imageGot 服务未初始化')
            const downloadPromise = this.processor.downloadImage(
              this.apiService.imageGot,
              thumbUrl,
              0,
              galleryId,
              String(gallery.media_id),
              1,
            )

            const result = await downloadWithTimeout(downloadPromise, COVER_DOWNLOAD_TIMEOUT_MS, '缩略图下载超时')
            const processed = await this.processDownloadResult(result, galleryId)
            if (processed) {
              covers.set(galleryId, processed)
            }
          } catch (itemError) {
            const errorMsg = getErrorMessage(itemError)
            logger.warn(`处理画廊 ${gallery?.id} 缩略图时出错: ${errorMsg}`)
            // 继续处理下一个,不中断整个队列
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
    private processor: Processor,
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
