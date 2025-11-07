import { Config } from '../config'
import { logger } from '../utils'
import { THUMB_HOST_PRIMARY, imageExtMap } from '../constants'
import { Processor } from '../processor'
import type { Gallery } from '../types'
import { ApiService } from './api'
import { DownloadManager } from './download'

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

  private processDownloadResult(result: any, galleryId: string): { buffer: Buffer; extension: string } | null {
    if ('buffer' in result) {
      const processed = this.processor.applyAntiGzip(result.buffer, `thumb-${galleryId}`)
      const extension = processed.format === 'webp' ? 'webp' : result.extension
      return { buffer: processed.buffer, extension }
    }
    return null
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
      logger.warn(`下载画廊 ${gallery.id} 的缩略图失败: ${e.message}`)
      return null
    }
  }

  async downloadCoversForGalleries(
    galleries: Partial<Gallery>[],
  ): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    const covers = new Map<string, { buffer: Buffer; extension: string }>()
    if (galleries.length === 0) return covers

    const galleryQueue = [...galleries]
    const concurrency = Math.min(this.config.downloadConcurrency, galleries.length)

    const workerTasks = Array.from({ length: concurrency }, async () => {
      let gallery: Partial<Gallery> | undefined

      while ((gallery = galleryQueue.shift())) {
        if (!gallery?.id || !gallery.media_id || !gallery.images?.thumbnail) continue

        try {
          const thumbUrl = this.buildThumbUrl(gallery)
          const result = await this.processor.downloadImage(
            this.apiService.imageGot,
            thumbUrl,
            0,
            gallery.id as string,
            gallery.media_id as string,
            1,
          )

          const processed = this.processDownloadResult(result, gallery.id as string)
          if (processed) {
            covers.set(gallery.id as string, processed)
          }
        } catch (itemError) {
          logger.error(`处理画廊 ${gallery?.id} 缩略图时出错: ${itemError.message}`)
        }
      }
    })

    await Promise.all(workerTasks)
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
      if (this.config.debug) logger.info(`获取到随机画廊ID: ${randomId}`)
      return randomId
    } catch (error) {
      logger.error(`获取随机画廊ID时出错: ${error.message}`)
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
