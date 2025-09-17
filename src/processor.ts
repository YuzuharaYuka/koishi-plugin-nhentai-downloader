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
import type { Page } from 'puppeteer-core'

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

  async downloadImage(page: Page, url: string, index: number, gid: string, retries = this.config.downloadRetries): Promise<DownloadedImage | { index: number; error: Error }> {
    const originalExt = path.extname(url).slice(1);
    const fallbackExts = ['jpg', 'png'].filter(ext => ext !== originalExt);
    const urlsToTry = [url, ...fallbackExts.map(ext => url.replace(`.${originalExt}`, `.${ext}`))]

    for (const [tryIndex, currentUrl] of urlsToTry.entries()) {
      for (let i = 0; i <= retries; i++) {
        try {
          if (tryIndex > 0 && this.config.debug) {
            logger.info(`[下载] 正在回退尝试: ${currentUrl}`);
          }
          await page.setExtraHTTPHeaders({ 'Referer': `https://nhentai.net/g/${gid}/` });
          
          const response = await page.goto(currentUrl, { 
            timeout: this.config.downloadTimeout, 
            waitUntil: 'domcontentloaded' 
          });
          
          if (response.ok()) {
            const headers = response.headers();
            const contentType = headers['content-type'];

            if (!contentType || !contentType.startsWith('image/')) {
              throw new Error(`下载的内容不是有效的图片 (Content-Type: ${contentType || 'N/A'})`);
            }

            const buffer = await response.buffer();
            const finalExt = path.extname(currentUrl).slice(1);
            if (this.config.debug) logger.info(`[下载] 图片 ${index + 1} (${currentUrl}) 下载成功。`);
            return { index, buffer, extension: finalExt };
          }

          if (response.status() === 404) {
             if (this.config.debug) logger.warn(`[下载] URL ${currentUrl} 返回 404，尝试下一种格式...`);
             break;
          }
          throw new Error(`请求失败，状态码: ${response.status()}`);
        } catch (error) {
          if (this.config.debug) {
            logger.warn(`[下载] 图片 ${index + 1} (${currentUrl}) 下载失败: ${error.message}`);
          }
          if (i < retries) {
            if (this.config.debug) logger.warn(`[下载] (第 ${i + 1} 次重试), ${this.config.downloadRetryDelay}ms 后进行...`);
            await sleep(this.config.downloadRetryDelay);
          } else {
            if (tryIndex < urlsToTry.length - 1) break;
            logger.error(`[下载] 图片 ${index + 1} (${url}) 在所有尝试后最终失败。`);
            return { index, error };
          }
        }
      }
    }
    return { index, error: new Error(`所有图片格式均返回 404`) };
  }
  
  async createZip(images: DownloadedImage[], password?: string): Promise<Buffer> {
    const isEncrypted = password && password.length > 0;
    const format = isEncrypted ? 'zip-encrypted' : 'zip';
    
    const archiveOptions: archiver.ArchiverOptions & { encryptionMethod?: string; password?: string } = {
      zlib: { level: this.config.zipCompressionLevel },
    };

    if (isEncrypted) {
      archiveOptions.encryptionMethod = 'aes256';
      archiveOptions.password = password;
    }

    // [最终修正] 对 format 变量本身进行类型断言，以解决编译时类型检查问题
    const zip = archiver(format as archiver.Format, archiveOptions);
    
    const stream = new PassThrough();
    const buffers: Buffer[] = [];
    stream.on('data', chunk => buffers.push(chunk));
    
    const archivePromise = new Promise<Buffer>((resolve, reject) => {
      stream.on('end', () => resolve(Buffer.concat(buffers)));
      zip.on('error', reject);
    });
    
    zip.pipe(stream);
    for (const { index, buffer, extension } of images) {
      const pageNum = (index + 1).toString().padStart(3, '0');
      zip.append(buffer, { name: `${pageNum}.${extension}` });
    }
    await zip.finalize();
    return archivePromise;
  }

  async createPdf(images: DownloadedImage[], galleryId: string, onProgress: (p: string) => void, password?: string): Promise<string> {
    const downloadDir = path.resolve(this.ctx.app.baseDir, this.config.downloadPath);
    const tempDir = path.resolve(downloadDir, `temp_pdf_${galleryId}_${Date.now()}`);
    const tempPdfPath = path.resolve(downloadDir, `temp_${galleryId}_${Date.now()}.pdf`);
    await mkdir(tempDir, { recursive: true });
    
    try {
      const recipe = new Recipe("new", tempPdfPath);
      for (const { index, buffer } of images) {
        onProgress(`⚙️ 正在处理第 ${index + 1} / ${images.length} 张图片...`);
        const imagePath = path.resolve(tempDir, `${index}.jpg`);
        try {
          const sharpInstance = sharp(buffer);
          const metadata = await sharpInstance.metadata();
          
          let imageToWrite = buffer;
          if (this.config.pdfEnableCompression || metadata.format !== 'jpeg') {
            imageToWrite = await sharpInstance.jpeg({ quality: this.config.pdfCompressionQuality }).toBuffer();
          }
          await writeFile(imagePath, imageToWrite);
          
          recipe.createPage(metadata.width, metadata.height)
                .image(imagePath, 0, 0, { width: metadata.width, height: metadata.height, keepAspectRatio: true })
                .endPage();

        } catch (imgError) {
          logger.warn('[Processor] PDF生成失败，已跳过图片 %d: %s', index + 1, imgError.message);
          onProgress(`❌ 处理第 ${index + 1} / ${images.length} 张图片失败，已跳过。`);
        }
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