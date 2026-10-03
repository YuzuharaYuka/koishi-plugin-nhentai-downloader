// 图片处理器，封装了所有图片处理操作
import * as path from 'path'
import { promises as fs } from 'fs'
import { Context } from 'koishi'
import type { Config } from './config'
import { logger } from './utils'
import { ImageCache, PdfCache } from './services/cache'
import type { HttpManager } from './services/http'

import type { CanvasImageProcessor, DownloadedImage, ProcessedImage } from './processors/types'
import { initCanvasProcessor, ensureCanvasLoaded } from './processors/canvas-processor'
import {
  applyAntiGzip as applyAntiGzipHelper,
  downloadImage as downloadImageHelper,
} from './processors/images'
import { createZip as createZipHelper } from './processors/zip'
import { createPdf as createPdfHelper } from './processors/pdf'

export { CanvasImageProcessor, DownloadedImage, ProcessedImage }
export { initCanvasProcessor }

export class Processor {
  public processor: CanvasImageProcessor
  private imageCache: ImageCache | null = null
  private pdfCache: PdfCache | null = null

  constructor(private ctx: Context, private config: Config) {
    this.processor = ensureCanvasLoaded()

    if (this.config.cache.enableImageCache) {
      this.imageCache = new ImageCache(this.config, this.ctx.app.baseDir)
    }
    if (this.config.cache.enablePdfCache) {
      this.pdfCache = new PdfCache(this.config, this.ctx.app.baseDir)
    }
  }

  /** 获取下载/缓存根目录（不存在时创建） */
  async ensureDownloadDir(): Promise<string> {
    const downloadDir = path.resolve(this.ctx.app.baseDir, this.config.downloadPath)
    await fs.mkdir(downloadDir, { recursive: true })
    return downloadDir
  }

  // 初始化缓存
  async initializeCache(): Promise<void> {
    // 无论缓存是否启用，都要保证下载目录存在：
    // PDF / ZIP 的临时文件都写在这里，而缓存目录只是它的子目录
    try {
      await this.ensureDownloadDir()
    } catch (error) {
      logger.warn(`创建下载目录失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    await Promise.all([
      this.imageCache?.initialize(),
      this.pdfCache?.initialize(),
    ])
  }

  getPdfCache(): PdfCache | null {
    return this.pdfCache
  }

  getImageCache(): ImageCache | null {
    return this.imageCache
  }

  /** Koishi 根目录，供需要落地临时文件的模块（如官方压缩包）使用 */
  getBaseDir(): string {
    return this.ctx.app.baseDir
  }

  /**
   * 反和谐处理：加水印后按 targetFormat 重新编码。
   * 缩略图用 webp/较低质量即可（它们只是菜单里的预览图），
   * 逐张发送则用 jpeg，保证各平台都能直接识别。
   */
  async applyAntiGzip(
    buffer: Buffer,
    identifier?: string,
    targetFormat: 'jpeg' | 'webp' | 'png' = 'jpeg',
    quality = 90,
  ): Promise<{ buffer: Buffer; format: string }> {
    return applyAntiGzipHelper(this.processor, buffer, this.config, identifier, targetFormat, quality)
  }

  /** 下载单张图片（CDN 切换、重试与缓存由 images 模块统一处理） */
  async downloadImage(options: {
    http: HttpManager
    url: string
    index: number
    galleryId: string | number
    mediaId?: string
    retries?: number
    fallbackHosts?: string[]
    onHostResult?: (host: string, ok: boolean, latencyMs: number) => void
  }): Promise<DownloadedImage | { index: number; error: Error }> {
    return downloadImageHelper({
      ...options,
      config: this.config,
      imageCache: this.imageCache,
    })
  }

  async createZip(imageStream: AsyncIterable<DownloadedImage>, password?: string, folderName?: string): Promise<Buffer> {
    return createZipHelper(imageStream, password, folderName)
  }

  async createPdf(
    imageStream: AsyncIterable<DownloadedImage>,
    galleryId: string,
    onProgress: (message: string) => void,
    password?: string,
  ): Promise<string> {
    return createPdfHelper(
      imageStream,
      galleryId,
      onProgress,
      password,
      this,
      this.config,
      this.ctx.app.baseDir,
    )
  }

  // 清理图片缓存和 PDF 缓存等资源
  dispose(): void {
    this.imageCache?.dispose()
    this.pdfCache?.dispose()
  }
}
