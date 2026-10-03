/**
 * 下载编排。
 *
 * 取图有两条路：官方打包直链（下载压缩包后解压）与 CDN 逐页下载；
 * 两条路都产出同一套 DownloadedImage 流，再交给 PDF / ZIP / 逐张图片输出。
 */
import * as path from 'path'
import { mkdir, rm } from 'fs/promises'
import type { Config } from '../config'
import { logger, getErrorMessage } from '../utils'
import { DEFAULT_IMAGE_CDN, DEFAULT_THUMB_CDN, IMAGE_SEND_QUALITY, PROGRESS_UPDATE_INTERVAL_MS } from '../constants'
import { Processor, DownloadedImage } from '../processor'
import type { Gallery } from '../types'
import { ApiService } from './api'
import { readArchiveImages } from './archive'
import { pdfProcessVariant } from '../processors/images'
import type { DownloadOutput } from './nhentai'

interface ImageUrl {
  url: string
  index: number
}

// 下载图片与缓存
interface CachedDownloadedImage extends DownloadedImage {
  processedBuffer?: Buffer // 缓存的处理后缓冲区
  finalFormat?: string // 最终格式
}

/**
 * 批量通知器：worker 完成时唤醒等待者，代替原先每 50ms 轮询一次 Map 的做法。
 */
class BatchNotifier {
  private version = 0
  private waiters: Array<() => void> = []
  private scheduled = false

  get current(): number {
    return this.version
  }

  notify(): void {
    this.version++
    if (this.scheduled) return
    this.scheduled = true
    // 合并同一批完成事件，避免为每张图片各唤醒一次
    setImmediate(() => {
      this.scheduled = false
      const waiters = this.waiters
      this.waiters = []
      for (const resolve of waiters) resolve()
    })
  }

  /** 等待 version 变化；若在读取 seen 之后已经变化则立即返回，不会丢失唤醒 */
  async waitFor(seen: number): Promise<number> {
    if (this.version !== seen) return this.version
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return this.version
  }
}

function createThrottledProgressUpdate(
  onProgress: (status: string) => Promise<void>,
  intervalMs: number = PROGRESS_UPDATE_INTERVAL_MS,
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

/** 官方压缩包下载进度（按字节），同样做节流 */
function createArchiveProgressUpdate(
  onProgress: (status: string) => Promise<void>,
  intervalMs = 3000,
): (downloaded: number, total: number | null) => void {
  let last = 0
  return (downloaded, total) => {
    const now = Date.now()
    if (now - last < intervalMs) return
    last = now
    const mb = (downloaded / 1024 / 1024).toFixed(1)
    const status = total
      ? `正在下载官方压缩包: ${((downloaded / total) * 100).toFixed(0)}% (${mb}/${(total / 1024 / 1024).toFixed(1)} MB)`
      : `正在下载官方压缩包: ${mb} MB`
    // 进度回调是异步的，这里不阻塞下载流
    void onProgress(status)
  }
}

function handleDownloadError(error: Error, operationType: string): { error: string } {
  logger.error(`${operationType}失败: ${error.message}`)
  return { error: `${operationType}失败: ${error.message}` }
}

export class StreamProcessor {
  /** 官方下发的主机列表（按健康度与延迟排序），同时用作失败切换的候选 */
  private cdnServers: { image: string[]; thumb: string[] } = {
    image: [DEFAULT_IMAGE_CDN],
    thumb: [DEFAULT_THUMB_CDN],
  }

  private lastFailedIndexes: number[] = []

  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
  ) {}

  // 生成图片 URL
  async generateImageUrls(gallery: Gallery): Promise<ImageUrl[]> {
    // 一次批量任务只取一次 CDN 配置，主机列表用于失败时切换
    this.cdnServers = await this.apiService.getCdnServers()
    const host = this.cdnServers.image[0] || DEFAULT_IMAGE_CDN

    return gallery.images.pages.map((page, index) => ({
      url: `https://${host}/${page.path}`,
      index,
    }))
  }

  getLastFailedIndexes(): number[] {
    return this.lastFailedIndexes
  }

  /** 统一的单张下载入口：附带回退主机与健康度回报 */
  private async downloadOne(
    url: string,
    index: number,
    galleryId: string,
    mediaId: string,
    maxRetries: number,
  ) {
    const got = this.apiService.imageHttp

    return this.processor.downloadImage({
      http: got,
      url,
      index,
      galleryId,
      mediaId,
      retries: maxRetries,
      fallbackHosts: this.cdnServers.image,
      onHostResult: (host, ok, latencyMs) => this.apiService.reportCdnResult(host, ok, latencyMs),
    })
  }

  // 处理下载图片
  private async processDownloadedImage(result: DownloadedImage, galleryId: string): Promise<DownloadedImage> {
    // 逐张发送用 jpeg 输出，扩展名与 MIME 同实际内容一致。
    // 质量 82：实测 q90 会把 54 页从 11.8MB 撑到 23.7MB，而画质差别不可见
    const processed = await this.processor.applyAntiGzip(
      result.buffer,
      `${galleryId}-page-${result.index + 1}`,
      'jpeg',
      IMAGE_SEND_QUALITY,
    )
    return {
      ...result,
      buffer: processed.buffer,
      extension: processed.format === 'original' ? result.extension : processed.format,
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
    const notifier = new BatchNotifier()

    let nextExpectedIndex = 0
    let processedCount = 0
    let allWorkersDone = false

    const worker = async () => {
      while (imageQueue.length > 0) {
        const item = imageQueue.shift()
        if (!item) continue

        try {
          const result = await this.downloadOne(
            item.url,
            item.index,
            galleryId,
            mediaId,
            this.config.downloadRetries,
          )
          processedCount++
          if (onProgress) await onProgress(processedCount, imageUrls.length)

          if ('buffer' in result) {
            downloadedImages.set(result.index, await this.processDownloadedImage(result, galleryId))
          } else {
            failedIndexes.push(item.index)
          }
        } catch (error: any) {
          logger.error(
            `下载图片失败 [galleryId=${galleryId}, index=${item.index + 1}, url=${item.url}]: ${error.message}`,
            error,
          )
          failedIndexes.push(item.index)
          processedCount++
        } finally {
          notifier.notify()
        }
      }
    }

    const concurrency = Math.max(1, this.config.downloadConcurrency)
    const allDone = Promise.all(Array.from({ length: concurrency }, () => worker())).then(() => {
      allWorkersDone = true
      notifier.notify()
    })

    while (nextExpectedIndex < imageUrls.length) {
      const image = downloadedImages.get(nextExpectedIndex)
      if (image) {
        downloadedImages.delete(nextExpectedIndex)
        yield image
        nextExpectedIndex++
        continue
      }

      // 所有 worker 结束后该页仍未出现，说明下载确实失败
      if (allWorkersDone) {
        nextExpectedIndex++
        continue
      }

      const seen = notifier.current
      if (downloadedImages.has(nextExpectedIndex) || allWorkersDone) continue
      await notifier.waitFor(seen)
    }

    await allDone

    // 保存失败索引供后续使用，并记录日志
    this.lastFailedIndexes = failedIndexes
    const successCount = processedCount - failedIndexes.length
    logger.info(
      `图片下载完成: ${successCount}/${imageUrls.length} 成功${failedIndexes.length > 0 ? `, ${failedIndexes.length} 失败` : ''}`,
    )
  }

  async *createPackageStream(
    galleryId: string,
    mediaId: string,
    imageUrls: ImageUrl[],
    onProgress?: (downloaded: number, processed: number, total: number) => Promise<void>,
  ): AsyncGenerator<DownloadedImage> {
    const downloadQueue = [...imageUrls]
    const processedBuffer = new Map<number, CachedDownloadedImage>()
    const notifier = new BatchNotifier()

    let nextYieldIndex = 0
    let downloadedCount = 0
    let successCount = 0
    let allDownloaded = false

    const imageCache = this.processor.getImageCache?.()

    const downloadWorker = async () => {
      while (downloadQueue.length > 0) {
        const item = downloadQueue.shift()
        if (!item) continue

        try {
          const result = await this.downloadOne(
            item.url,
            item.index,
            galleryId,
            mediaId,
            this.config.downloadRetries,
          )

          downloadedCount++
          if (onProgress) await onProgress(downloadedCount, downloadedCount, imageUrls.length)

          if (this.config.debug && downloadedCount % 10 === 0) {
            logger.info(
              `下载进度: ${downloadedCount}/${imageUrls.length} (${((downloadedCount / imageUrls.length) * 100).toFixed(1)}%)`,
            )
          }

          if ('buffer' in result) {
            successCount++
            const cachedImage: CachedDownloadedImage = { ...result }
            if (imageCache) {
              const cachedProcessed = await imageCache.getProcessed(
            galleryId,
            mediaId,
            result.index,
            pdfProcessVariant(this.config),
          )
              if (cachedProcessed) {
                cachedImage.processedBuffer = cachedProcessed.buffer
                cachedImage.finalFormat = cachedProcessed.extension
                if (this.config.debug) logger.info(`处理缓存命中: 图片 ${result.index + 1} (gid: ${galleryId})`)
              }
            }
            processedBuffer.set(result.index, cachedImage)
          }
        } catch (error: any) {
          logger.warn(`下载图片失败 [galleryId=${galleryId}, index=${item.index + 1}]: ${error.message}`)
        } finally {
          notifier.notify()
        }
      }
    }

    const concurrency = Math.max(1, this.config.downloadConcurrency)
    const downloadCompleted = Promise.all(Array.from({ length: concurrency }, downloadWorker)).then(() => {
      allDownloaded = true
      const failedCount = downloadedCount - successCount
      logger.info(
        `图片下载完成: ${successCount}/${imageUrls.length} 成功${failedCount > 0 ? `, ${failedCount} 失败` : ''} (${((successCount / imageUrls.length) * 100).toFixed(1)}%)`,
      )
      notifier.notify()
    })

    // 按页序产出：已完成的页立即交出，未完成的页等待 worker 通知
    while (nextYieldIndex < imageUrls.length) {
      const image = processedBuffer.get(nextYieldIndex)
      if (image) {
        processedBuffer.delete(nextYieldIndex)
        nextYieldIndex++
        yield image
        continue
      }

      if (allDownloaded) {
        logger.warn(`跳过未能下载的图片 [galleryId=${galleryId}, index=${nextYieldIndex + 1}]`)
        nextYieldIndex++
        continue
      }

      const seen = notifier.current
      if (processedBuffer.has(nextYieldIndex) || allDownloaded) continue
      await notifier.waitFor(seen)
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

    const filename = this.generateFilename(gallery, id)

    // ① 优先走官方打包直链（可用时）：官方服务端打包 → 本地解压 → 复用同一套 PDF/ZIP/图片流程
    if (this.shouldUseOfficialArchive(gallery)) {
      const result = await this.tryOfficialArchive(gallery, outputType, password, filename, onProgress)
      if (result) return result
      logger.warn(`画廊 ${id}: 官方压缩包不可用，回退到 CDN 逐页下载`)
    }

    // ② CDN 逐页下载
    const imageUrls = await this.streamProcessor.generateImageUrls(gallery)
    await onProgress(`画廊信息获取成功，共 ${imageUrls.length} 页图片。`)

    const galleryId = String(gallery.id)
    const throttled = createThrottledProgressUpdate(onProgress)

    if (outputType === 'img') {
      const stream = this.streamProcessor.createImageStream(
        galleryId,
        gallery.media_id,
        imageUrls,
        async (processed, total) => throttled(0, processed, total),
      )
      return this.downloadAsImages(
        stream,
        filename,
        imageUrls.length,
        () => this.streamProcessor.getLastFailedIndexes(),
        onProgress,
      )
    }

    const stream = this.streamProcessor.createPackageStream(galleryId, gallery.media_id, imageUrls, throttled)
    return outputType === 'pdf'
      ? this.downloadAsPdf(stream, galleryId, filename, password, onProgress)
      : this.downloadAsZip(stream, filename, password)
  }

  // ─── 官方打包直链 ──────────────────────────────────────────

  /** 是否尝试官方直链：需要 API Key、非 cdn 模式、且本页尚未全部缓存 */
  private shouldUseOfficialArchive(gallery: Gallery): boolean {
    const source = this.config.downloadSource ?? 'auto'
    if (source === 'cdn') return false

    if (!this.config.apiKey) {
      if (source === 'official') {
        logger.warn('downloadSource = official 但未配置 API Key；官方下载接口需要鉴权，改用 CDN')
      }
      return false
    }

    const pageCount = gallery.images.pages.length
    if (pageCount <= 0) return false

    // 页面已全部缓存在本地时无需消耗官方签发配额
    const imageCache = this.processor.getImageCache()
    if (imageCache?.hasCachedPages(String(gallery.id), gallery.media_id, pageCount)) {
      logger.debug(`画廊 ${gallery.id}: 全部 ${pageCount} 页已缓存，跳过官方直链签发`)
      return false
    }
    return true
  }

  /** 官方压缩包 → 解压 → 走与 CDN 相同的输出流程；任何环节失败都返回 null 以便回退 */
  private async tryOfficialArchive(
    gallery: Gallery,
    outputType: 'pdf' | 'zip' | 'img',
    password: string | undefined,
    filename: string,
    onProgress: (status: string) => Promise<void>,
  ): Promise<DownloadOutput | { error: string } | null> {
    const galleryId = String(gallery.id)

    const issued = await this.apiService.getGalleryDownloadUrl(galleryId, 'zip')
    if (!issued) return null

    const expiresInMs = issued.expires_at * 1000 - Date.now()
    if (expiresInMs < 10_000) {
      logger.warn(`画廊 ${galleryId}: 官方直链仅剩 ${Math.round(expiresInMs / 1000)}s 有效期，改用 CDN`)
      return null
    }

    const dir = path.resolve(this.processor.getBaseDir(), this.config.downloadPath, 'official-archive')
    const archivePath = path.join(dir, `${galleryId}-${Date.now()}.zip`)

    try {
      await mkdir(dir, { recursive: true })
      await onProgress('正在从官方直链获取压缩包...')

      const startedAt = Date.now()
      const size = await this.apiService.imageHttp.download(issued.url, archivePath, {
        timeoutMs: this.config.officialArchiveTimeout * 1000,
        referer: `https://nhentai.net/g/${galleryId}/`,
        onProgress: createArchiveProgressUpdate(onProgress),
      })
      const seconds = (Date.now() - startedAt) / 1000
      logger.info(
        `画廊 ${galleryId}: 官方压缩包 ${(size / 1024 / 1024).toFixed(2)} MB，用时 ${seconds.toFixed(1)}s ` +
          `(${(size / 1024 / 1024 / Math.max(seconds, 0.001)).toFixed(2)} MB/s)，开始解压`,
      )

      const stream = this.createOfficialImageStream(gallery, archivePath)
      return await this.writeOutput(stream, gallery, outputType, password, filename, onProgress, () => [])
    } catch (error) {
      logger.warn(`画廊 ${galleryId}: 官方压缩包处理失败（${getErrorMessage(error)}）`)
      return null
    } finally {
      await rm(archivePath, { force: true }).catch(() => undefined)
    }
  }

  /** 把官方压缩包内的页面按顺序产出，同时回写图片缓存 */
  private async *createOfficialImageStream(
    gallery: Gallery,
    archivePath: string,
  ): AsyncGenerator<DownloadedImage> {
    const galleryId = String(gallery.id)
    const imageCache = this.processor.getImageCache()

    for await (const image of readArchiveImages(archivePath, { expectedPages: gallery.num_pages })) {
      if (imageCache) {
        await imageCache
          .set(galleryId, gallery.media_id, image.index, image.buffer, image.extension, false)
          .catch(() => undefined)
      }
      yield {
        index: image.index,
        buffer: image.buffer,
        extension: image.extension,
        galleryId,
        mediaId: gallery.media_id,
      }
    }
  }

  // ─── 输出流程（两种取图方式共用） ──────────────────────────

  private async writeOutput(
    stream: AsyncIterable<DownloadedImage>,
    gallery: Gallery,
    outputType: 'pdf' | 'zip' | 'img',
    password: string | undefined,
    filename: string,
    onProgress: (status: string) => Promise<void>,
    failures: () => number[],
  ): Promise<DownloadOutput | { error: string }> {
    if (outputType === 'img') {
      return this.downloadAsImages(stream, filename, gallery.images.pages.length, failures, onProgress)
    }
    return outputType === 'pdf'
      ? this.downloadAsPdf(stream, String(gallery.id), filename, password, onProgress)
      : this.downloadAsZip(stream, filename, password)
  }

  private generateFilename(gallery: Gallery, id: string): string {
    // 根据配置的标题类型获取标题，如果不存在则按优先级回退：日文 > 英文 > pretty
    let title: string
    const titleType = this.config.titleType || 'japanese'

    if (titleType === 'japanese') {
      title = gallery.title?.japanese || gallery.title?.english || gallery.title?.pretty || 'untitled'
    } else if (titleType === 'english') {
      title = gallery.title?.english || gallery.title?.japanese || gallery.title?.pretty || 'untitled'
    } else { // pretty
      title = gallery.title?.pretty || gallery.title?.japanese || gallery.title?.english || 'untitled'
    }

    // 清理文件名中的非法字符
    let filename = title.replace(/[\\/:\*\?"<>\|]/g, '_')

    if (this.config.prependIdToFile) {
      filename = `[${id}] ${filename}`
    }

    return filename
  }

  private async downloadAsImages(
    stream: AsyncIterable<DownloadedImage>,
    filename: string,
    totalPages: number,
    failures: () => number[],
    onProgress: (status: string) => Promise<void>,
  ): Promise<DownloadOutput | { error: string }> {
    const images: DownloadedImage[] = []
    const throttledUpdate = createThrottledProgressUpdate(onProgress)

    try {
      let processed = 0
      for await (const image of stream) {
        images.push(image)
        processed++
        await throttledUpdate(0, processed, totalPages)
      }

      if (images.length === 0) {
        return { error: '所有图片下载失败。' }
      }

      return {
        type: 'images',
        images,
        filename,
        failedIndexes: failures(),
      }
    } catch (error: any) {
      return handleDownloadError(error, '下载图片')
    }
  }

  private async downloadAsPdf(
    stream: AsyncIterable<DownloadedImage>,
    galleryId: string,
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

    try {
      const pdfPath = await this.processor.createPdf(stream, galleryId, onProgress, password)

      if (!pdfPath) {
        return { error: 'PDF 生成失败。' }
      }

      if (pdfCache) {
        const cachedPath = await pdfCache.set(galleryId, pdfPath, `${filename}.pdf`, password)
        if (cachedPath) {
          try {
            const { unlink } = await import('fs/promises')
            await unlink(pdfPath)
            if (this.config.debug) logger.info(`临时 PDF 已删除: ${pdfPath}`)
          } catch (err: any) {
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
    } catch (error: any) {
      return handleDownloadError(error, '生成 PDF')
    }
  }

  private async downloadAsZip(
    stream: AsyncIterable<DownloadedImage>,
    filename: string,
    password: string | undefined,
  ): Promise<DownloadOutput | { error: string }> {
    try {
      const zipBuffer = await this.processor.createZip(stream, password, filename)

      if (!zipBuffer) {
        return { error: 'ZIP 生成失败。' }
      }

      return {
        type: 'zip',
        buffer: zipBuffer,
        filename: `${filename}.zip`,
      }
    } catch (error: any) {
      return handleDownloadError(error, '生成 ZIP')
    }
  }
}
