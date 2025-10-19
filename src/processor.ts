// src/processor.ts
import { Context } from 'koishi'
import { Config } from './config'
import { logger, sleep } from './utils'
import { PassThrough } from 'stream'
import { mkdir, rm, writeFile } from 'fs/promises'
import * as path from 'path'
import { Recipe } from 'muhammara'
import archiver from 'archiver'
import sharp from 'sharp'
import type { GotScraping } from 'got-scraping'

if (!archiver.isRegisteredFormat('zip-encrypted')) {
  archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
}

export interface DownloadedImage {
  index: number;
  buffer: Buffer;
  extension: string;
}

export class Processor {
  constructor(
    private ctx: Context,
    private config: Config
  ) {}

  public async applyAntiGzip(buffer: Buffer, identifier?: string): Promise<Buffer> {
    if (!this.config.antiGzip.enabled) return buffer;
    
    const logPrefix = `[Processor][抗审查]${identifier ? ` (标识: ${identifier})` : ''}`;
    if (this.config.debug) logger.info(`${logPrefix} 开始处理...`);
    
    try {
      const metadata = await sharp(buffer).metadata();
      const { width, height } = metadata;

      if (!width || !height) {
        logger.warn(`${logPrefix} 无法获取图片尺寸，跳过处理。`);
        return buffer;
      }

      const watermarkText = String(Math.floor(Math.random() * 10));
      const fontSize = Math.max(8, Math.round(width / 150));
      const margin = Math.floor(fontSize / 2);
      const opacity = 0.15;
      const color = '#000000';

      const position = Math.floor(Math.random() * 4);
      let x: number, y: number, anchor: string;

      switch (position) {
        case 0: x = margin; y = margin + fontSize; anchor = 'start'; break;
        case 1: x = width - margin; y = margin + fontSize; anchor = 'end'; break;
        case 2: x = width - margin; y = height - margin; anchor = 'end'; break;
        case 3: x = margin; y = height - margin; anchor = 'start'; break;
      }

      const esc = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;' }[c] as string));
      const svgWatermark = Buffer.from(
        `<svg width="${width}" height="${height}"><text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(watermarkText)}</text></svg>`
      );

      const finalBuffer = await sharp(buffer)
        .composite([{ input: svgWatermark }])
        .toBuffer();
      
      if (this.config.debug) logger.info(`${logPrefix} 处理成功。`);
      return finalBuffer;

    } catch (e) {
      logger.warn(`${logPrefix} 处理失败，将返回原图: %s`, e.message);
      return buffer;
    }
  }

  private async _attemptDownload(got: GotScraping, url: string, gid: string, retries: number): Promise<Buffer | null> {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await got.get(url, {
          headers: { 'Referer': `https://nhentai.net/g/${gid}/` },
          timeout: { request: this.config.downloadTimeout },
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
          if (this.config.debug) logger.warn(`${url} (第 ${i + 1} 次重试), ${this.config.downloadRetryDelay}ms 后进行...`);
          await sleep(this.config.downloadRetryDelay);
        }
      }
    }
    return null;
  }

  async downloadImage(got: GotScraping, url: string, index: number, gid: string, retries = this.config.downloadRetries): Promise<DownloadedImage | { index: number; error: Error }> {
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
        logger.info(`[CDN回退] 主域名 ${baseHostname} 失败，尝试备用域名: ${host}`);
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
   * [FIX] Implements a sequencer buffer using an async generator.
   * This takes an unordered stream of downloaded images and yields them in the correct sequential order.
   * This fixes the page order issue in PDFs and ZIPs caused by concurrent downloads.
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
    // Final check for any remaining items in the buffer, in case the stream ends
    // but there's a contiguous sequence at the end.
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
    
    // [FIX] Process images from the ordered stream to ensure correct file order.
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
      const recipe = new Recipe("new", tempPdfPath);
      let pageCount = 0;
      const recompressionThreshold = (this.config.pdfJpegRecompressionSize || 500) * 1024;

      // [FIX] Process images from the ordered stream to ensure correct page order.
      for await (const { index, buffer } of this._createOrderedImageStream(imageStream)) {
        pageCount++;
        onProgress(`正在处理第 ${pageCount} 张图片并写入PDF...`);
        const imagePath = path.resolve(tempDir, `${index}.jpg`);
        try {
          const sharpInstance = sharp(buffer);
          const metadata = await sharpInstance.metadata();
          
          let imageToWrite = buffer;
          if (this.config.pdfEnableCompression) {
            // Smart Compression Logic
            if (metadata.format === 'jpeg' && recompressionThreshold > 0 && metadata.size < recompressionThreshold) {
              if (this.config.debug) logger.info(`[Processor][PDF] 图片 ${index + 1} 是小于 ${this.config.pdfJpegRecompressionSize}KB 的JPEG，跳过二次压缩。`);
            } else {
              imageToWrite = await sharpInstance.jpeg({ quality: this.config.pdfCompressionQuality }).toBuffer();
            }
          } else if (metadata.format !== 'jpeg') {
            // Convert to JPEG if not compressed, as PDF recipe needs it
            imageToWrite = await sharpInstance.jpeg({ quality: 100 }).toBuffer();
          }
          
          await writeFile(imagePath, imageToWrite);
          
          recipe.createPage(metadata.width, metadata.height)
                .image(imagePath, 0, 0, { width: metadata.width, height: metadata.height, keepAspectRatio: true })
                .endPage();

        } catch (imgError) {
          logger.warn('[Processor] PDF生成失败，已跳过图片 %d: %s', index + 1, imgError.message);
          onProgress(`处理第 ${pageCount} 张图片失败，已跳过。`);
        }
      }

      if (pageCount === 0) {
        throw new Error("没有成功处理任何图片，无法生成PDF。");
      }

      if (password) recipe.encrypt({ userPassword: password, ownerPassword: password });
      recipe.endPDF();
      return tempPdfPath;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(e => {
        logger.warn('[Processor] 清理PDF临时目录 %s 失败: %o', tempDir, e)
      });
    }
  }
}