// src/services/nhentai.ts
import { Config } from '../config'
import { logger, sleep } from '../utils'
// [FIX] 修正导入，移除不再存在的 IMAGE_BASE 和 THUMB_BASE，并导入新的主域名常量
import { ApiService, Gallery, THUMB_HOST_PRIMARY, IMAGE_HOST_PRIMARY, imageExtMap, SearchResult } from './api'
import { Processor, DownloadedImage } from '../processor'
import { PassThrough } from 'stream'

export interface GalleryWithCover {
  gallery: Gallery;
  cover?: {
    buffer: Buffer;
    extension: string;
  };
}

export type DownloadOutput = 
  | { type: 'pdf'; path: string; filename: string }
  | { type: 'zip'; buffer: Buffer; filename: string }
  | { type: 'images'; images: DownloadedImage[]; filename: string; failedIndexes: number[] }

export class NhentaiService {
  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
  ) {}

  public async getGalleryWithCover(id: string): Promise<GalleryWithCover | null> {
    const gallery = await this.apiService.getGallery(id);
    if (!gallery) return null;

    const thumb = gallery.images?.thumbnail;
    if (thumb && gallery.media_id) {
      try {
        // [FIX] 使用新的主域名常量构建 URL，并添加协议头
        const thumbUrl = `https://${THUMB_HOST_PRIMARY}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`;
        const result = await this.processor.downloadImage(this.apiService.imageGot, thumbUrl, 0, gallery.id, 1);
        if ('buffer' in result) {
          const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
          return { gallery, cover: { buffer: processedBuffer, extension: result.extension } };
        }
      } catch (e) {
        logger.warn(`[Service] 下载画廊 ${id} 的缩略图失败: %o`, e);
      }
    }
    return { gallery };
  }
  
  public async getCoversForGalleries(galleries: Partial<Gallery>[]): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    const covers = new Map<string, { buffer: Buffer; extension: string }>();
    if (galleries.length === 0) return covers;

    const galleryQueue = [...galleries];
    
    const workerTasks = Array.from({ length: Math.min(this.config.downloadConcurrency, galleries.length) }, async () => {
      let gallery: Partial<Gallery>;
      while ((gallery = galleryQueue.shift())) {
        if (!gallery?.id || !gallery.title) continue;
        const thumb = gallery.images?.thumbnail;
        if (thumb && gallery.media_id) {
          try {
            // [FIX] 使用新的主域名常量构建 URL，并添加协议头
            const thumbUrl = `https://${THUMB_HOST_PRIMARY}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`;
            const result = await this.processor.downloadImage(this.apiService.imageGot, thumbUrl, 0, gallery.id as string, 1);
            if ('buffer' in result) {
              const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
              covers.set(gallery.id as string, { buffer: processedBuffer, extension: result.extension });
            }
          } catch (itemError) {
            logger.error(`[Service] 处理画廊 ${gallery?.id} 缩略图时出错: %o`, itemError);
          }
        }
      }
    });
    
    await Promise.all(workerTasks);
    return covers;
  }

  public async getRandomGalleryId(): Promise<string | null> {
    try {
      const got = await this.apiService.imageGot;
      const response = await got.get('https://nhentai.net/random', {
        throwHttpErrors: false,
        timeout: { request: 15000 },
      });
      
      const finalUrl = response.url;
      if (!finalUrl) {
        throw new Error('请求随机画廊失败，无法获取最终 URL。');
      }

      const galleryIdRegex = /\/g\/(\d+)/;
      const match = finalUrl.match(galleryIdRegex);
      if (!match || !match[1]) {
        throw new Error(`无法从最终 URL (${finalUrl}) 中解析画廊ID`);
      }

      const randomId = match[1];
      if (this.config.debug) logger.info(`[Service] 获取到随机画廊ID: ${randomId}`);
      return randomId;

    } catch (error) {
      logger.error(`[Service] 获取随机画廊ID时出错: %o`, error);
      return null;
    }
  }

  public async downloadGallery(
    id: string,
    outputType: 'pdf' | 'zip' | 'img',
    password?: string,
    onProgress: (status: string) => Promise<void> = async () => {}
  ): Promise<DownloadOutput | { error: string }> {
    const gallery = await this.apiService.getGallery(id);
    if (!gallery) {
      return { error: `获取画廊 ${id} 信息失败，请检查ID或链接是否正确。` };
    }

    const imageUrls = gallery.images.pages.map((p, i) => ({
      // [FIX] 使用新的主域名常量构建 URL，并添加协议头
      url: `https://${IMAGE_HOST_PRIMARY}/galleries/${gallery.media_id}/${i + 1}.${imageExtMap[p.t] || 'jpg'}`,
      index: i
    }));
    await onProgress(`画廊信息获取成功，共 ${imageUrls.length} 页图片。`);
    
    let baseFilename = (gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'untitled').replace(/[\\/:\*\?"<>\|]/g, '_');
    if (this.config.prependIdToFile) {
      baseFilename = `[${id}] ${baseFilename}`;
    }

    if (outputType === 'img') {
      const successfulDownloads: DownloadedImage[] = [];
      const failedIndexes: number[] = [];
      const imageQueue = [...imageUrls];
      let processedCount = 0;
      let lastProgressUpdate = 0;
      const throttledUpdate = async () => {
        const now = Date.now();
        if (now - lastProgressUpdate > 1500) {
          await onProgress(`正在下载图片: ${processedCount} / ${imageUrls.length} ...`);
          lastProgressUpdate = now;
        }
      };
      const worker = async () => {
        while (imageQueue.length > 0) {
          const item = imageQueue.shift();
          if (!item) continue;
          const result = await this.processor.downloadImage(this.apiService.imageGot, item.url, item.index, id);
          processedCount++;
          if ('buffer' in result) {
            const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `${id}-page-${result.index + 1}`);
            successfulDownloads.push({ ...result, buffer: processedBuffer });
          } else {
            failedIndexes.push(item.index);
          }
          await throttledUpdate();
        }
      };
      const workerPromises = Array.from({ length: this.config.downloadConcurrency }, () => worker());
      await Promise.all(workerPromises);
      await onProgress(`正在下载图片: ${processedCount} / ${imageUrls.length} ...`);
      
      successfulDownloads.sort((a, b) => a.index - b.index);
      if (successfulDownloads.length === 0) return { error: '所有图片下载失败。' };

      return { type: 'images', images: successfulDownloads, filename: baseFilename, failedIndexes };
    }

    const imageQueue = [...imageUrls];
    const imageStream = new PassThrough({ objectMode: true });
    let processedCount = 0;
    let successfulCount = 0;
    const failedIndexes: number[] = [];
    
    let lastProgressUpdate = 0;
    const throttledUpdate = async () => {
      const now = Date.now();
      if (now - lastProgressUpdate > 1500) {
        await onProgress(`已处理: ${processedCount} / ${imageUrls.length} ...`);
        lastProgressUpdate = now;
      }
    };

    const downloadWorker = async () => {
      while (imageQueue.length > 0) {
        const item = imageQueue.shift();
        if (!item) continue;
        const result = await this.processor.downloadImage(this.apiService.imageGot, item.url, item.index, id);
        processedCount++;

        if ('buffer' in result) {
          const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `${id}-page-${result.index + 1}`);
          imageStream.write({ ...result, buffer: processedBuffer });
          successfulCount++;
        } else {
          failedIndexes.push(item.index);
        }
        await throttledUpdate();
      }
    };
    
    let packagingPromise: Promise<any>;
    if (outputType === 'pdf') {
      packagingPromise = this.processor.createPdf(imageStream, id, onProgress, password);
    } else { // zip
      packagingPromise = this.processor.createZip(imageStream, password);
    }

    const downloadPromises = Array.from({ length: this.config.downloadConcurrency }, () => downloadWorker());
    
    Promise.all(downloadPromises).then(() => {
      imageStream.end();
      onProgress(`所有图片处理完成，正在完成打包...`);
    });

    const packageResult = await packagingPromise;
    
    if (successfulCount === 0) {
      return { error: '所有图片下载失败，无法生成文件。' };
    }

    if (outputType === 'pdf') {
      return { type: 'pdf', path: packageResult, filename: `${baseFilename}.pdf` };
    } else { // zip
      return { type: 'zip', buffer: packageResult, filename: `${baseFilename}.zip` };
    }
  }
}