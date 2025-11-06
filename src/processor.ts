/**
 * 图片处理器,封装了所有图片处理操作。
 */
import { Context } from 'koishi'
import { GotScraping } from 'got-scraping'
import { Config } from './config'
import { ImageCache, PdfCache } from './services/cache'

// 保持向后兼容的类型和函数重导出
import { WasmImageProcessor, DownloadedImage, ProcessedImage } from './processors/types'
import { initWasmProcessor, ensureWasmLoaded } from './processors/wasm'
import {
  convertImageForMode,
  conditionallyCompressJpeg,
  applyAntiGzip as applyAntiGzipHelper,
  batchApplyAntiGzip as batchApplyAntiGzipHelper,
  downloadImage as downloadImageHelper,
} from './processors/images'
import { createZip as createZipHelper } from './processors/zip'
import { createPdf as createPdfHelper } from './processors/pdf'

export { WasmImageProcessor, DownloadedImage, ProcessedImage }
export { initWasmProcessor }

/**
 * 图片处理器主类，作为所有图片操作的统一入口。
 */
export class Processor {
  public wasm: WasmImageProcessor
  private imageCache: ImageCache | null = null
  private pdfCache: PdfCache | null = null
  private successfulHosts: Map<string, string> = new Map()

  constructor(private ctx: Context, private config: Config) {
    this.wasm = ensureWasmLoaded()
    if (this.config.cache.enableImageCache) {
      this.imageCache = new ImageCache(this.config, this.ctx.app.baseDir)
    }
    if (this.config.cache.enablePdfCache) {
      this.pdfCache = new PdfCache(this.config, this.ctx.app.baseDir)
    }
  }

  /**
   * 初始化图片缓存和 PDF 缓存。
   */
  async initializeCache(): Promise<void> {
    if (this.imageCache) {
      await this.imageCache.initialize()
    }
    if (this.pdfCache) {
      await this.pdfCache.initialize()
    }
  }

  /**
   * 获取 PDF 缓存实例。
   */
  getPdfCache(): PdfCache | null {
    return this.pdfCache
  }

  /**
   * 获取图片缓存实例。
   */
  getImageCache(): ImageCache | null {
    return this.imageCache
  }

  public applyAntiGzip(buffer: Buffer, identifier?: string): { buffer: Buffer; format: string } {
    return applyAntiGzipHelper(this.wasm, buffer, this.config, identifier)
  }

  public batchApplyAntiGzip(images: Array<{ buffer: Buffer; identifier?: string }>): Array<{ buffer: Buffer; format: string }> {
    return batchApplyAntiGzipHelper(this.wasm, images, this.config)
  }

  public async convertImageForMode(
    buffer: Buffer,
    format: string,
    mode: 'pdf' | 'zip' | 'image',
  ): Promise<{ buffer: Buffer; finalFormat: string }> {
    return convertImageForMode(this.wasm, buffer, format, mode, this.config)
  }

  public async conditionallyCompressJpeg(
    buffer: Buffer,
    format: string,
    threshold: number,
    quality: number,
    enableCompression: boolean,
  ): Promise<Buffer> {
    return conditionallyCompressJpeg(
      this.wasm,
      buffer,
      format,
      threshold,
      quality,
      enableCompression,
      this.config.debug,
    )
  }

  async downloadImage(
    got: GotScraping,
    url: string,
    index: number,
    gid: string,
    mediaId?: string,
    retries = this.config.downloadRetries,
    sessionToken?: object,
  ): Promise<DownloadedImage | { index: number; error: Error }> {
    return downloadImageHelper(
      got,
      url,
      index,
      gid,
      this.config,
      this.imageCache,
      this.successfulHosts,
      mediaId,
      retries,
      sessionToken,
    )
  }

  async createZip(imageStream: AsyncIterable<DownloadedImage>, password?: string, folderName?: string): Promise<Buffer> {
    return createZipHelper(imageStream, password, this.config.zipCompressionLevel, folderName)
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

  /**
   * 清理图片缓存和 PDF 缓存等资源。
   */
  dispose(): void {
    this.imageCache?.dispose()
    this.pdfCache?.dispose()
  }
}
