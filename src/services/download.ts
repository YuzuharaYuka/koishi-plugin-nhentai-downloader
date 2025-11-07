import { Config } from '../config'
import { logger, sleep } from '../utils'
import { IMAGE_HOST_PRIMARY, imageExtMap } from '../constants'
import { Processor, DownloadedImage } from '../processor'
import type { Gallery } from '../types'
import { ApiService } from './api'
import type { DownloadOutput } from './nhentai'

interface ImageUrl {
  url: string
  index: number
}

// 扩展的下载图片类型，用于缓存处理结果
interface CachedDownloadedImage extends DownloadedImage {
  processedBuffer?: Buffer // 缓存的处理后缓冲区
  finalFormat?: string // 最终格式
}

function createThrottledProgressUpdate(
  onProgress: (status: string) => Promise<void>,
  intervalMs: number = 1500,
) {
  let lastProgressUpdate = 0
  return async (downloaded: number, processed: number, total: number) => {
    const now = Date.now()
    if (now - lastProgressUpdate > intervalMs) {
      await onProgress(`下载: ${downloaded}/${total} | 处理: ${processed}/${total}`)
      lastProgressUpdate = now
    }
  }
}

function handleDownloadError(error: Error, operationType: string): { error: string } {
  logger.error(`${operationType}失败: ${error.message}`)
  return { error: `${operationType}失败: ${error.message}` }
}

export class StreamProcessor {
  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
  ) {}

  private lastFailedIndexes: number[] = [] // 存储最后一次流生成的失败索引

  generateImageUrls(gallery: Gallery): ImageUrl[] {
    return gallery.images.pages.map((p, i) => ({
      url: `https://${IMAGE_HOST_PRIMARY}/galleries/${gallery.media_id}/${i + 1}.${imageExtMap[p.t] || 'jpg'}`,
      index: i,
    }))
  }

  // 获取最后一次下载的失败索引
  getLastFailedIndexes(): number[] {
    return this.lastFailedIndexes
  }

  // 处理下载的图片，应用 antiGzip 并返回处理后的结果
  private processDownloadedImage(result: DownloadedImage, galleryId: string): DownloadedImage {
    const processed = this.processor.applyAntiGzip(result.buffer, `${galleryId}-page-${result.index + 1}`)
    return {
      ...result,
      buffer: processed.buffer,
      extension: processed.format === 'webp' ? 'webp' : result.extension,
    }
  }

  async *createImageStream(
    galleryId: string,
    mediaId: string,
    imageUrls: ImageUrl[],
    onProgress?: (processed: number, total: number) => Promise<void>,
  ): AsyncGenerator<DownloadedImage> {
    const failedIndexes: number[] = []
    const imageQueue = [...imageUrls]
    const downloadedImages = new Map<number, DownloadedImage>()
    let nextExpectedIndex = 0
    let processedCount = 0
    const sessionToken = this.apiService.getSessionToken(galleryId)

    const worker = async () => {
      while (imageQueue.length > 0) {
        const item = imageQueue.shift()
        if (!item) continue

        try {
          const result = await this.processor.downloadImage(
            this.apiService.imageGot,
            item.url,
            item.index,
            galleryId,
            mediaId,
            this.config.downloadRetries,
            sessionToken,
          )

          processedCount++
          if (onProgress) await onProgress(processedCount, imageUrls.length)

          if ('buffer' in result) {
            const processedImage = this.processDownloadedImage(result, galleryId)
            downloadedImages.set(result.index, processedImage)
          } else {
            failedIndexes.push(item.index)
          }
        } catch (error) {
          logger.error(`下载图片 ${item.index + 1} 时出错: ${error.message}`)
          failedIndexes.push(item.index)
          processedCount++
        }
      }
    }

    const workerPromises = Array.from({ length: this.config.downloadConcurrency }, () => worker())

    while (nextExpectedIndex < imageUrls.length) {
      while (!downloadedImages.has(nextExpectedIndex)) {
        await sleep(50)

        const allWorkersFinished = (await Promise.allSettled(workerPromises)).every(
          (p) => p.status === 'fulfilled',
        )

        if (allWorkersFinished && !downloadedImages.has(nextExpectedIndex)) {
          nextExpectedIndex++
          break
        }
      }

      const image = downloadedImages.get(nextExpectedIndex)
      if (image) {
        yield image
        downloadedImages.delete(nextExpectedIndex)
      }

      nextExpectedIndex++
    }

    await Promise.all(workerPromises)

    // 保存失败索引供后续使用，并记录日志
    this.lastFailedIndexes = failedIndexes
    const successCount = processedCount - failedIndexes.length
    logger.info(`图片下载完成: ${successCount}/${imageUrls.length} 成功${failedIndexes.length > 0 ? `, ${failedIndexes.length} 失败` : ''}`)
  }

  async *createPackageStream(
    galleryId: string,
    mediaId: string,
    imageUrls: ImageUrl[],
    onProgress?: (downloaded: number, processed: number, total: number) => Promise<void>,
  ): AsyncGenerator<DownloadedImage> {
    const downloadQueue = [...imageUrls]
    const processedBuffer = new Map<number, CachedDownloadedImage>()

    let nextYieldIndex = 0
    let downloadedCount = 0
    let successCount = 0
    let allDownloaded = false

    const imageCache = this.processor.getImageCache?.()
    const sessionToken = this.apiService.getSessionToken(galleryId)

    const downloadWorker = async () => {
      while (downloadQueue.length > 0) {
        const item = downloadQueue.shift()
        if (!item) continue

        try {
          const result = await this.processor.downloadImage(
            this.apiService.imageGot,
            item.url,
            item.index,
            galleryId,
            mediaId,
            this.config.downloadRetries,
            sessionToken,
          )

          downloadedCount++
          if (onProgress) await onProgress(downloadedCount, downloadedCount, imageUrls.length)

          if (this.config.debug && downloadedCount % 10 === 0) {
            logger.info(`下载进度: ${downloadedCount}/${imageUrls.length} (${((downloadedCount / imageUrls.length) * 100).toFixed(1)}%)`)
          }

          if ('buffer' in result) {
            successCount++
            const cachedImage: CachedDownloadedImage = { ...result }
            if (imageCache) {
              const cachedProcessed = await imageCache.getProcessed(galleryId, mediaId, result.index)
              if (cachedProcessed) {
                cachedImage.processedBuffer = cachedProcessed.buffer
                cachedImage.finalFormat = cachedProcessed.extension
                if (this.config.debug) logger.info(`处理缓存命中: 图片 ${result.index + 1} (gid: ${galleryId})`)
              }
            }
            processedBuffer.set(result.index, cachedImage)
          }
        } catch (error) {
          logger.warn(`下载图片 ${item.index + 1} 失败: ${error.message}`)
        }
      }
    }

    const downloadWorkers = Array.from({ length: this.config.downloadConcurrency }, downloadWorker)

    // 使用 Promise 来跟踪所有下载工作完成
    const downloadPromise = Promise.all(downloadWorkers)

    // 等待下载完成，同时产出已准备好的图片
    let yielded = 0
    const downloadCompleted = downloadPromise.then(() => {
      allDownloaded = true
      const failedCount = downloadedCount - successCount
      logger.info(`图片下载完成: ${successCount}/${imageUrls.length} 成功${failedCount > 0 ? `, ${failedCount} 失败` : ''} (${((successCount / imageUrls.length) * 100).toFixed(1)}%)`)
    })

    // 产出图片直到所有下载完成且缓冲区为空
    while (yielded < imageUrls.length) {
      if (processedBuffer.has(nextYieldIndex)) {
        const image = processedBuffer.get(nextYieldIndex)!
        processedBuffer.delete(nextYieldIndex)
        yield image
        nextYieldIndex++
        yielded++
      } else {
        await sleep(50)
        // 检查是否所有工作都已完成但仍有缺失的图片
        if (allDownloaded && yielded < imageUrls.length && !processedBuffer.has(nextYieldIndex)) {
          logger.warn(`跳过未能下载的图片 ${nextYieldIndex + 1}`)
          nextYieldIndex++
          yielded++
        }
      }
    }

    await downloadCompleted
  }
}

export class DownloadManager {
  private streamProcessor: StreamProcessor

  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
  ) {
    this.streamProcessor = new StreamProcessor(config, apiService, processor)
  }

  async downloadGallery(
    id: string,
    outputType: 'pdf' | 'zip' | 'img',
    password?: string,
    onProgress: (status: string) => Promise<void> = async () => {},
  ): Promise<DownloadOutput | { error: string }> {
    const gallery = await this.apiService.getGallery(id)
    if (!gallery) {
      return { error: `获取画廊 ${id} 信息失败，请检查ID或链接是否正确。` }
    }

    const imageUrls = this.streamProcessor.generateImageUrls(gallery)
    await onProgress(`画廊信息获取成功，共 ${imageUrls.length} 页图片。`)

    const baseFilename = this.generateFilename(gallery, id)

    if (outputType === 'img') {
      return this.downloadAsImages(id, gallery.media_id, imageUrls, baseFilename, onProgress)
    } else if (outputType === 'pdf') {
      return this.downloadAsPdf(id, gallery.media_id, imageUrls, baseFilename, password, onProgress)
    } else {
      return this.downloadAsZip(id, gallery.media_id, imageUrls, baseFilename, password, onProgress)
    }
  }

  private generateFilename(gallery: any, id: string): string {
    let filename = (gallery.title?.pretty || gallery.title?.english || 'untitled').replace(
      /[\\/:\*\?"<>\|]/g,
      '_',
    )

    if (this.config.prependIdToFile) {
      filename = `[${id}] ${filename}`
    }

    return filename
  }

  private async downloadAsImages(
    galleryId: string,
    mediaId: string,
    imageUrls: any[],
    filename: string,
    onProgress: (status: string) => Promise<void>,
  ): Promise<DownloadOutput | { error: string }> {
    const images: DownloadedImage[] = []
    const throttledUpdate = createThrottledProgressUpdate(onProgress)

    try {
      for await (const image of this.streamProcessor.createImageStream(
        galleryId,
        mediaId,
        imageUrls,
        async (processed, total) => {
          await throttledUpdate(0, processed, total)
        },
      )) {
        images.push(image)
      }

      if (images.length === 0) {
        return { error: '所有图片下载失败。' }
      }

      return {
        type: 'images',
        images,
        filename,
        failedIndexes: this.streamProcessor.getLastFailedIndexes(), // 从streamProcessor中获取失败索引
      }
    } catch (error) {
      return handleDownloadError(error, '下载图片')
    } finally {
      this.apiService.clearSessionToken(galleryId)
    }
  }

  private async downloadAsPdf(
    galleryId: string,
    mediaId: string,
    imageUrls: any[],
    filename: string,
    password: string | undefined,
    onProgress: (status: string) => Promise<void>,
  ): Promise<DownloadOutput | { error: string }> {
    const pdfCache = this.processor.getPdfCache()

    if (pdfCache) {
      const cachedPath = await pdfCache.get(galleryId, password)
      if (cachedPath) {
        await onProgress('从缓存加载 PDF')
        return {
          type: 'pdf',
          path: cachedPath,
          filename: `${filename}.pdf`,
          isTemporary: false,
        }
      }
    }

    const throttledUpdate = createThrottledProgressUpdate(onProgress)

    try {
      const imageStream = this.streamProcessor.createPackageStream(
        galleryId,
        mediaId,
        imageUrls,
        throttledUpdate,
      )

      const pdfPath = await this.processor.createPdf(imageStream, galleryId, onProgress, password)

      if (!pdfPath) {
        return { error: 'PDF 生成失败。' }
      }

      if (pdfCache) {
        await pdfCache.set(galleryId, pdfPath, `${filename}.pdf`, password)
        const cachedPath = await pdfCache.get(galleryId, password)
        if (cachedPath) {
          try {
            const { unlink } = await import('fs/promises')
            await unlink(pdfPath)
            if (this.config.debug) logger.info(`临时 PDF 已删除: ${pdfPath}`)
          } catch (err) {
            if (this.config.debug) logger.warn(`删除临时 PDF 失败: ${err.message}`)
          }
          return {
            type: 'pdf',
            path: cachedPath,
            filename: `${filename}.pdf`,
            isTemporary: false,
          }
        }
      }

      return {
        type: 'pdf',
        path: pdfPath,
        filename: `${filename}.pdf`,
        isTemporary: true,
      }
    } catch (error) {
      return handleDownloadError(error, '生成 PDF')
    } finally {
      this.apiService.clearSessionToken(galleryId)
    }
  }

  private async downloadAsZip(
    galleryId: string,
    mediaId: string,
    imageUrls: any[],
    filename: string,
    password: string | undefined,
    onProgress: (status: string) => Promise<void>,
  ): Promise<DownloadOutput | { error: string }> {
    const throttledUpdate = createThrottledProgressUpdate(onProgress)

    try {
      const imageStream = this.streamProcessor.createPackageStream(
        galleryId,
        mediaId,
        imageUrls,
        throttledUpdate,
      )

      const zipBuffer = await this.processor.createZip(imageStream, password, filename)

      if (!zipBuffer) {
        return { error: 'ZIP 生成失败。' }
      }

      return {
        type: 'zip',
        buffer: zipBuffer,
        filename: `${filename}.zip`,
      }
    } catch (error) {
      return handleDownloadError(error, '生成 ZIP')
    } finally {
      this.apiService.clearSessionToken(galleryId)
    }
  }
}
