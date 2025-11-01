// src/processor.ts
import { Context } from 'koishi'
import { Config } from './config'
import { logger, sleep } from './utils'
import { PassThrough } from 'stream'
import { mkdir, rm, writeFile } from 'fs/promises'
import * as path from 'path'
import * as fs from 'fs'

import PDFDocument from 'pdfkit'
import archiver from 'archiver'
import type { GotScraping } from 'got-scraping'
import { ImageCache } from './services/image-cache'

if (!archiver.isRegisteredFormat('zip-encrypted')) {
  archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
}

// WASM module interface
interface WasmImageProcessor {
  convert_to_jpeg(buffer: Uint8Array, quality: number): Uint8Array;
  webp_to_jpeg(buffer: Uint8Array, quality: number): Uint8Array;
  apply_anti_censorship(buffer: Uint8Array, noise_intensity: number, add_border: boolean): Uint8Array;
  apply_anti_censorship_jpeg(buffer: Uint8Array, noise_intensity: number, add_border: boolean, quality: number): Uint8Array;
  compress_jpeg(buffer: Uint8Array, quality: number, skip_threshold: number): Uint8Array;
  get_dimensions(buffer: Uint8Array): { width: number; height: number };
  process_for_pdf(buffer: Uint8Array, enable_compression: boolean, quality: number, skip_threshold: number): Uint8Array;
  process_image(buffer: Uint8Array, target_format: string, quality: number, apply_anti_censor: boolean, noise_intensity: number, add_border: boolean): Uint8Array;
  batch_apply_anti_censorship_jpeg(buffers: Uint8Array[], noise_intensity: number, add_border: boolean, quality: number): Uint8Array[];
}

let wasmModule: WasmImageProcessor | null = null;

/**
 * Initialize WASM image processor
 * Must be called before using Processor class
 */
export async function initWasmProcessor(): Promise<void> {
  if (wasmModule) {
    return; // Already initialized
  }

  try {
    const wasmJsPath = path.join(__dirname, '../wasm-dist/wasm_image_processor.js');

    if (!fs.existsSync(wasmJsPath)) {
      throw new Error(
        'WASM module not found. Please ensure the plugin is properly installed.\n' +
        'If building from source, run: cd wasm-image-processor && npm run build'
      );
    }

    delete require.cache[wasmJsPath]; // Clear cache to ensure fresh load
    const wasm = require(wasmJsPath);

    // Initialize WASM if init function exists
    if (typeof wasm.init === 'function') {
      wasm.init();
    }

    wasmModule = wasm as WasmImageProcessor;

  } catch (error) {
    throw new Error(`Failed to initialize WASM processor: ${error.message}`);
  }
}

function ensureWasmLoaded(): WasmImageProcessor {
  if (!wasmModule) {
    throw new Error('WASM module not initialized. Call initWasmProcessor() first in ctx.on("ready", ...)');
  }
  return wasmModule;
}

export interface DownloadedImage {
  index: number;
  buffer: Buffer;
  extension: string;
}

export class Processor {
  private wasm: WasmImageProcessor;
  private imageCache: ImageCache | null = null;

  constructor(
    private ctx: Context,
    private config: Config
  ) {
    this.wasm = ensureWasmLoaded();
    if (this.config.cache.enableImageCache) {
      this.imageCache = new ImageCache(this.config, this.ctx.app.baseDir);
    }
  }

  /**
   * 初始化图片缓存
   */
  async initializeCache(): Promise<void> {
    if (this.imageCache) {
      await this.imageCache.initialize();
    }
  }

  private async convertToJpeg(buffer: Buffer, quality: number = 85): Promise<Buffer> {
    try {
      const uint8Array = new Uint8Array(buffer);
      const result = this.wasm.webp_to_jpeg(uint8Array, quality);
      return Buffer.from(result);
    } catch (error) {
      logger.error(`[Processor] JPEG转换失败: ${error.message}`);
      throw error;
    }
  }

  public applyAntiGzip(buffer: Buffer, identifier?: string): Buffer {
    if (!this.config.antiGzip.enabled) {
      return buffer;
    }

    const logPrefix = `[Processor]${identifier ? ` (${identifier})` : ''}`;
    if (this.config.debug) {
      logger.info(`${logPrefix} 开始处理...`);
    }

    try {
      const uint8Array = new Uint8Array(buffer);

      const jpegResult = this.wasm.apply_anti_censorship_jpeg(
        uint8Array,
        0.0005, // 0.05% of pixels
        true,   // add border
        85      // JPEG quality
      );

      const finalBuffer = Buffer.from(jpegResult);

      if (this.config.debug) {
        logger.info(`${logPrefix} 处理成功 (原始: ${buffer.length} bytes → 处理后: ${finalBuffer.length} bytes)`);
      }

      return finalBuffer;
    } catch (error) {
      logger.warn(`${logPrefix} 处理失败，返回原图: ${error.message}`);
      return buffer;
    }
  }

  public batchApplyAntiGzip(images: Array<{ buffer: Buffer; identifier?: string }>): Buffer[] {
    if (!this.config.antiGzip.enabled) {
      return images.map(img => img.buffer);
    }

    if (images.length === 0) {
      return [];
    }

    try {
      // 使用WASM批量处理接口（如果可用），否则回退到逐个处理
      if (typeof this.wasm.batch_apply_anti_censorship_jpeg === 'function') {
        const buffers = images.map(img => new Uint8Array(img.buffer));
        const results = this.wasm.batch_apply_anti_censorship_jpeg(
          buffers as any, // 转换为JsValue数组
          0.0001, // 0.01% of pixels
          true,   // add border
          85      // JPEG quality
        );
        // 转换结果回Buffer
        return results.map((result: any) => {
          if (result instanceof Uint8Array) {
            return Buffer.from(result);
          } else if (result && result.buffer) {
            return Buffer.from(result);
          }
          // 如果返回的是原始buffer，直接使用
          const idx = results.indexOf(result);
          return images[idx]?.buffer || Buffer.alloc(0);
        });
      } else {
        // 回退到逐个处理
        return images.map(({ buffer, identifier }) => {
          try {
            const uint8Array = new Uint8Array(buffer);
          const jpegResult = this.wasm.apply_anti_censorship_jpeg(
            uint8Array,
            0.0005, // 0.05% of pixels (5x stronger)
            true,   // add border
            85      // JPEG quality
          );
            return Buffer.from(jpegResult);
          } catch (error) {
            if (this.config.debug) {
              logger.warn(`[Processor]${identifier ? ` (${identifier})` : ''} 批量处理失败: ${error.message}`);
            }
            return buffer;
          }
        });
      }
    } catch (error) {
      if (this.config.debug) {
        logger.warn(`[Processor]批量处理失败，回退到逐个处理: ${error.message}`);
      }
      // 回退到逐个处理
      return images.map(({ buffer, identifier }) => {
        try {
          const uint8Array = new Uint8Array(buffer);
          const jpegResult = this.wasm.apply_anti_censorship_jpeg(
            uint8Array,
            0.0001,
            true,
            85
          );
          return Buffer.from(jpegResult);
        } catch (err) {
          if (this.config.debug) {
            logger.warn(`[Processor]${identifier ? ` (${identifier})` : ''} 处理失败: ${err.message}`);
          }
          return buffer;
        }
      });
    }
  }

  /**
   * Download image with retry logic
   */
  private async _attemptDownload(got: GotScraping, url: string, gid: string, retries: number): Promise<Buffer | null> {
    for (let i = 0; i <= retries; i++) {
      try {
        // 将秒转换为毫秒
        const timeoutMs = this.config.downloadTimeout * 1000;
        const response = await got.get(url, {
          headers: { 'Referer': `https://nhentai.net/g/${gid}/` },
          timeout: { request: timeoutMs },
          retry: { limit: 0 },
          throwHttpErrors: true,
        });

        const contentType = response.headers['content-type'];
        if (!contentType || !contentType.startsWith('image/')) {
          throw new Error(`返回的不是图片 (Content-Type: ${contentType || 'N/A'})`);
        }

        return response.rawBody;

      } catch (error) {
        if (this.config.debug) {
          logger.warn(`URL ${url} 下载失败: ${error.message}`);
        }
        if (i < retries) {
          if (this.config.debug) logger.warn(`${url} (第 ${i + 1} 次重试), ${this.config.downloadRetryDelay}秒 后进行...`);
          await sleep(this.config.downloadRetryDelay * 1000);
        }
      }
    }
    return null;
  }

  async downloadImage(got: GotScraping, url: string, index: number, gid: string, mediaId?: string, retries = this.config.downloadRetries): Promise<DownloadedImage | { index: number; error: Error }> {
    // 尝试从缓存获取
    if (this.imageCache && mediaId) {
      const cachedBuffer = await this.imageCache.get(mediaId, index);
      if (cachedBuffer) {
        const originalUrl = new URL(url);
        const originalExt = path.extname(originalUrl.pathname).slice(1);
        if (this.config.debug) logger.info(`缓存命中: 图片 ${index + 1} (media_id: ${mediaId})`);
        return { index, buffer: cachedBuffer, extension: originalExt };
      }
    }

    const originalUrl = new URL(url);
    const originalExt = path.extname(originalUrl.pathname).slice(1);
    const fallbackExts = ['jpg', 'png'].filter(ext => ext !== originalExt);

    const baseHostname = originalUrl.hostname;

    const fallbackHosts = baseHostname.startsWith('t')
      ? require('./constants').THUMB_HOST_FALLBACK
      : require('./constants').IMAGE_HOST_FALLBACK;
    const hostsToTry = [baseHostname, ...fallbackHosts];

    for (const host of hostsToTry) {
      if (host !== baseHostname && this.config.debug) {
        logger.info(`主域名 ${baseHostname} 失败，尝试备用域名: ${host}`);
      }

      originalUrl.hostname = host;
      const urlsWithHost = [
        originalUrl.href,
        ...fallbackExts.map(ext => originalUrl.href.replace(`.${originalExt}`, `.${ext}`))
      ];

      for (const currentUrl of urlsWithHost) {
        try {
          const buffer = await this._attemptDownload(got, currentUrl, gid, retries);
          if (buffer) {
            const finalExt = path.extname(new URL(currentUrl).pathname).slice(1);
            if (this.config.debug) logger.info(`图片 ${index + 1} (${currentUrl}) 下载成功。`);

            // 保存到缓存
            if (this.imageCache && mediaId) {
              await this.imageCache.set(mediaId, index, buffer, finalExt).catch(err => {
                if (this.config.debug) logger.warn(`保存缓存失败: ${err.message}`);
              });
            }

            return { index, buffer, extension: finalExt };
          }
        } catch (error) {
          if (this.config.debug) logger.warn(`尝试 ${currentUrl} 时发生意外错误: ${error.message}`);
        }
      }
    }

    logger.error(`图片 ${index + 1} (${url}) 在所有域名和格式尝试后最终失败。`);
    return { index, error: new Error('所有主备域名和图片格式均下载失败') };
  }

  /**
   * Create ordered image stream from unordered downloads
   * Fixes page order issue in PDFs and ZIPs caused by concurrent downloads
   */
  private async * _createOrderedImageStream(imageStream: AsyncIterable<DownloadedImage>): AsyncGenerator<DownloadedImage> {
    let nextIndex = 0;
    const buffer = new Map<number, DownloadedImage>();

    for await (const image of imageStream) {
      buffer.set(image.index, image);
      while (buffer.has(nextIndex)) {
        yield buffer.get(nextIndex)!;
        buffer.delete(nextIndex);
        nextIndex++;
      }
    }

    // Flush remaining items
    while (buffer.has(nextIndex)) {
      yield buffer.get(nextIndex)!;
      buffer.delete(nextIndex);
      nextIndex++;
    }
  }

  async createZip(imageStream: AsyncIterable<DownloadedImage>, password?: string): Promise<Buffer> {
    const isEncrypted = password && password.length > 0;
    const format = isEncrypted ? 'zip-encrypted' : 'zip';

    const archiveOptions: archiver.ArchiverOptions & { encryptionMethod?: string; password?: string } = {
      zlib: { level: this.config.zipCompressionLevel },
    };

    if (isEncrypted) {
      archiveOptions.encryptionMethod = 'aes256';
      archiveOptions.password = password;
    }

    const zip = archiver(format as archiver.Format, archiveOptions);

    const stream = new PassThrough();
    const buffers: Buffer[] = [];
    stream.on('data', chunk => buffers.push(chunk));

    const archivePromise = new Promise<Buffer>((resolve, reject) => {
      stream.on('end', () => resolve(Buffer.concat(buffers)));
      zip.on('error', reject);
    });

    zip.pipe(stream);

    // Process images in correct order
    for await (const { index, buffer, extension } of this._createOrderedImageStream(imageStream)) {
      const pageNum = (index + 1).toString().padStart(3, '0');
      zip.append(buffer, { name: `${pageNum}.${extension}` });
    }

    await zip.finalize();
    return archivePromise;
  }

  async createPdf(imageStream: AsyncIterable<DownloadedImage>, galleryId: string, onProgress: (p: string) => void, password?: string): Promise<string> {
    const downloadDir = path.resolve(this.ctx.app.baseDir, this.config.downloadPath);
    const tempDir = path.resolve(downloadDir, `temp_pdf_${galleryId}_${Date.now()}`);
    const tempPdfPath = path.resolve(downloadDir, `temp_${galleryId}_${Date.now()}.pdf`);
    await mkdir(tempDir, { recursive: true });

    try {
      // Create PDF document with encryption if password is provided
      const pdfOptions: any = {
        autoFirstPage: false,
        bufferPages: true
      };

      if (password) {
        pdfOptions.userPassword = password;
        pdfOptions.ownerPassword = password;
        pdfOptions.permissions = {
          printing: 'highResolution',
          modifying: false,
          copying: false
        };
      }

      const doc = new PDFDocument(pdfOptions);
      const writeStream = fs.createWriteStream(tempPdfPath);
      doc.pipe(writeStream);

      let pageCount = 0;
      const recompressionThreshold = (this.config.pdfJpegRecompressionSize || 500) * 1024;

      // Process images from the ordered stream using WASM
      for await (const { index, buffer } of this._createOrderedImageStream(imageStream)) {
        pageCount++;
        onProgress(`正在处理第 ${pageCount} 张图片并写入PDF...`);
        const imagePath = path.resolve(tempDir, `${index}.jpg`);

        try {
          // Use WASM for high-performance processing
          const processedData = this.wasm.process_for_pdf(
            new Uint8Array(buffer),
            this.config.pdfEnableCompression,
            this.config.pdfCompressionQuality,
            recompressionThreshold
          );

          // Extract dimensions and buffer from packed result
          // Format: [width (4 bytes), height (4 bytes), ...buffer]
          const dataView = new DataView(processedData.buffer, processedData.byteOffset, processedData.byteLength);
          const width = dataView.getUint32(0, true); // little-endian
          const height = dataView.getUint32(4, true);
          const imageBuffer = Buffer.from(processedData.slice(8));

          // Write processed image to temp file
          await writeFile(imagePath, imageBuffer);

          // Add page with image dimensions
          doc.addPage({ size: [width, height] });
          doc.image(imagePath, 0, 0, { width, height });

        } catch (imgError) {
          logger.warn('[Processor] PDF生成失败，已跳过图片 %d: %s', index + 1, imgError.message);
          onProgress(`处理第 ${pageCount} 张图片失败，已跳过。`);
        }
      }

      if (pageCount === 0) {
        throw new Error("没有成功处理任何图片，无法生成PDF。");
      }

      // Finalize PDF
      doc.end();

      // Wait for the write stream to finish
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
      });

      if (this.config.debug) {
        logger.info(`[Processor] PDF生成成功: ${tempPdfPath} (${pageCount} 页)`);
      }

      return tempPdfPath;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(e => {
        logger.warn('[Processor] 清理PDF临时目录 %s 失败: %o', tempDir, e)
      });
    }
  }
}
