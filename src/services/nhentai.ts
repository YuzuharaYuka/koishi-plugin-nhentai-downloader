import { Config } from '../config'
import { logger, getErrorMessage } from '../utils'
import { THUMB_HOST_PRIMARY, imageExtMap } from '../constants'
import { Processor } from '../processor'
import type { Gallery } from '../types'
import { ApiService } from './api'
import { DownloadManager } from './download'

// 超时控制辅助函数，确保定时器被正确清理
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
    clearTimeout(timeoutId!)  // 关键：无论成功或失败都清理定时器
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

  private buildThumbUrl(gallery: Partial<Gallery>): string {
    const thumb = gallery.images?.thumbnail
    return `https://${THUMB_HOST_PRIMARY}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb?.t || ''] || 'jpg'}`
  }

  private async processDownloadResult(result: any, galleryId: string): Promise<{ buffer: Buffer; extension: string } | null> {
    try {
      if ('buffer' in result && result.buffer && Buffer.isBuffer(result.buffer)) {
        // 菜单缩略图保持原格式，避免不必要的转换
        const processed = await this.processor.applyAntiGzip(result.buffer, `thumb-${galleryId}`, true)
        const extension = processed.format === 'original' ? result.extension : (processed.format === 'webp' ? 'webp' : (processed.format === 'png' ? 'png' : 'jpg'))
        return { buffer: processed.buffer, extension }
      }
      logger.warn(`画廊 ${galleryId} 下载结果无效`)
      return null
    } catch (error) {
      const errorMsg = getErrorMessage(error)
      logger.error(`处理画廊 ${galleryId} 下载结果失败: ${errorMsg}`)
      // 如果 AntiGzip 失败,尝试返回原始 buffer
      if ('buffer' in result && result.buffer && Buffer.isBuffer(result.buffer)) {
        return { buffer: result.buffer, extension: result.extension || 'jpg' }
      }
      return null
    }
  }

  async downloadCover(
    gallery: Gallery,
  ): Promise<{ buffer: Buffer; extension: string } | null> {
    const thumb = gallery.images?.thumbnail
    if (!thumb || !gallery.media_id) return null

    try {
      const thumbUrl = this.buildThumbUrl(gallery)
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
    galleries: Partial<Gallery>[],
  ): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    const covers = new Map<string, { buffer: Buffer; extension: string }>()
    if (galleries.length === 0) return covers

    const galleryQueue = [...galleries]
    // 限制并发数以避免内存溢出,最大不超过 10
    const concurrency = Math.min(Math.min(this.config.downloadConcurrency, 10), galleries.length)

    const workerTasks = Array.from({ length: concurrency }, async () => {
      try {
        let gallery: Partial<Gallery> | undefined

        while ((gallery = galleryQueue.shift())) {
          if (!gallery?.id || !gallery.media_id || !gallery.images?.thumbnail) continue

          try {
            const thumbUrl = this.buildThumbUrl(gallery)

            // 使用带超时控制的下载，确保定时器被正确清理
            const downloadPromise = this.processor.downloadImage(
              this.apiService.imageGot,
              thumbUrl,
              0,
              gallery.id as string,
              gallery.media_id as string,
              1,
            )

            const result = await downloadWithTimeout(downloadPromise, 30000, '缩略图下载超时')
            const processed = await this.processDownloadResult(result, gallery.id as string)
            if (processed) {
              covers.set(gallery.id as string, processed)
            }
          } catch (itemError) {
            const errorMsg = getErrorMessage(itemError)
            logger.error(`处理画廊 ${gallery?.id} 缩略图时出错: ${errorMsg}`)
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
    galleries: Partial<Gallery>[],
  ): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    return this.coverService.downloadCoversForGalleries(galleries)
  }

  async getRandomGalleryId(): Promise<string | null> {
    try {
      const got = this.apiService.imageGot
      if (!got) throw new Error('ImageGot 未初始化')

      const response = await got.get('https://nhentai.net/random', {
        throwHttpErrors: false,
        timeout: { request: this.config.downloadTimeout * 1000 },
      })

      const match = response.url.match(/\/g\/(\d+)/)
      if (!match?.[1]) throw new Error(`无法从最终 URL (${response.url}) 中解析画廊ID`)

      const randomId = match[1]
      logger.debug(`获取到随机画廊ID: ${randomId}`)
      return randomId
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
