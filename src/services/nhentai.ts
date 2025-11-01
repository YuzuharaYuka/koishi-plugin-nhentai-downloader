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
        const result = await this.processor.downloadImage(this.apiService.imageGot, thumbUrl, 0, gallery.id, gallery.media_id, 1);
        if ('buffer' in result) {
          const processedBuffer = this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
          return { gallery, cover: { buffer: processedBuffer, extension: result.extension } };
        }
      } catch (e) {
        logger.warn(`下载画廊 ${id} 的缩略图失败: %o`, e);
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
            const result = await this.processor.downloadImage(this.apiService.imageGot, thumbUrl, 0, gallery.id as string, gallery.media_id as string, 1);
            if ('buffer' in result) {
              const processedBuffer = this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
              covers.set(gallery.id as string, { buffer: processedBuffer, extension: result.extension });
            }
          } catch (itemError) {
            logger.error(`处理画廊 ${gallery?.id} 缩略图时出错: %o`, itemError);
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
      if (this.config.debug) logger.info(`获取到随机画廊ID: ${randomId}`);
      return randomId;

    } catch (error) {
      logger.error(`获取随机画廊ID时出错: %o`, error);
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
      const retryQueue: Array<{ url: string; index: number }> = []; // 重试队列
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
        while (imageQueue.length > 0 || retryQueue.length > 0) {
          // 优先处理重试队列
          const item = retryQueue.shift() || imageQueue.shift();
          if (!item) continue;

          try {
            const result = await this.processor.downloadImage(this.apiService.imageGot, item.url, item.index, id, gallery.media_id);
            processedCount++;
            if ('buffer' in result) {
              // 立即处理并释放原始buffer
              const processedBuffer = this.processor.applyAntiGzip(result.buffer, `${id}-page-${result.index + 1}`);
              successfulDownloads.push({ ...result, buffer: processedBuffer });
              // 立即清理原始buffer引用
              (result as any).buffer = null;
            } else {
              // 失败但不阻塞，加入重试队列（限制重试次数）
              const retryCount = (item as any).retryCount || 0;
              if (retryCount < this.config.downloadRetries) {
                (item as any).retryCount = retryCount + 1;
                setTimeout(() => retryQueue.push(item), this.config.downloadRetryDelay * 1000);
              } else {
                failedIndexes.push(item.index);
              }
            }
            await throttledUpdate();
          } catch (error) {
            logger.error(`下载图片 ${item.index + 1} 时出错: ${error.message}`);
            const retryCount = (item as any).retryCount || 0;
            if (retryCount < this.config.downloadRetries) {
              (item as any).retryCount = retryCount + 1;
              setTimeout(() => retryQueue.push(item), this.config.downloadRetryDelay);
            } else {
              failedIndexes.push(item.index);
              processedCount++;
            }
          }
        }
      };
      const workerPromises = Array.from({ length: this.config.downloadConcurrency }, () => worker());
      await Promise.all(workerPromises);

      // 等待所有任务完成（包括重试）
      let retryWaitCount = 0;
      while (retryQueue.length > 0 && retryWaitCount < 100) {
        await sleep(100);
        retryWaitCount++;
      }

      await onProgress(`正在下载图片: ${processedCount} / ${imageUrls.length} ...`);

      successfulDownloads.sort((a, b) => a.index - b.index);
      if (successfulDownloads.length === 0) return { error: '所有图片下载失败。' };

      return { type: 'images', images: successfulDownloads, filename: baseFilename, failedIndexes };
    }

    const imageQueue = [...imageUrls];
    const processingQueue: Array<{ index: number; buffer: Buffer; extension: string }> = [];
    const MAX_PROCESSING_QUEUE_SIZE = Math.max(10, this.config.downloadConcurrency * 2); // 增大队列缓冲
    const imageStream = new PassThrough({ objectMode: true });
    let downloadedCount = 0;
    let processedCount = 0;
    let successfulCount = 0;
    const failedIndexes: number[] = [];
    let downloadComplete = false;
    let processingComplete = false;

    let lastProgressUpdate = 0;
    const throttledUpdate = async () => {
      const now = Date.now();
      if (now - lastProgressUpdate > 1500) {
        await onProgress(`下载: ${downloadedCount}/${imageUrls.length} | 处理: ${processedCount}/${imageUrls.length}`);
        lastProgressUpdate = now;
      }
    };

    // 下载worker：只负责下载，下载完立即放入处理队列
    const downloadWorker = async () => {
      while (imageQueue.length > 0) {
        const item = imageQueue.shift();
        if (!item) continue;

        // 如果处理队列满了，等待处理完一些再继续下载（背压控制）
        while (processingQueue.length >= MAX_PROCESSING_QUEUE_SIZE) {
          await new Promise(resolve => setTimeout(resolve, 50)); // 减少等待时间
        }

        try {
          const result = await this.processor.downloadImage(this.apiService.imageGot, item.url, item.index, id, gallery.media_id);
          downloadedCount++;

          if ('buffer' in result) {
            processingQueue.push(result);
          } else {
            // 失败不阻塞，记录但继续处理其他图片
            failedIndexes.push(item.index);
            processedCount++; // 失败也算处理完
          }
          await throttledUpdate();
        } catch (error) {
          logger.error(`下载图片 ${item.index + 1} 时出错: ${error.message}`);
          failedIndexes.push(item.index);
          downloadedCount++;
          processedCount++;
          await throttledUpdate();
        }
      }
    };

    // 处理worker：从处理队列取图片，批量处理提升性能
    // 批量处理大小：设置为并发数的1/2到1倍，平衡内存和性能
    const BATCH_SIZE = Math.max(5, Math.min(20, Math.floor(this.config.downloadConcurrency * 1.5)));
    const processingWorker = async () => {
      const batch: Array<{ index: number; buffer: Buffer; extension: string; originalItem: any }> = [];

      while (true) {
        // 收集一批图片进行批量处理
        while (batch.length < BATCH_SIZE && (processingQueue.length > 0 || !downloadComplete)) {
          if (processingQueue.length > 0) {
            const item = processingQueue.shift();
            if (item) {
              batch.push({
                index: item.index,
                buffer: item.buffer,
                extension: item.extension,
                originalItem: item
              });
            }
          } else if (!downloadComplete) {
            // 如果下载未完成，等待更多图片
            await new Promise(resolve => setTimeout(resolve, 10));
          } else {
            // 下载完成，处理剩余批次
            break;
          }
        }

        // 如果批次为空且下载完成，退出
        if (batch.length === 0) {
          if (downloadComplete && processedCount >= downloadedCount) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }

        // 批量处理图片
        try {
          const imagesForBatch = batch.map(({ buffer, index }) => ({
            buffer,
            identifier: `${id}-page-${index + 1}`
          }));

          // 使用批量处理（如果可用）
          const processedBuffers = this.processor.batchApplyAntiGzip(imagesForBatch);

          // 将处理后的图片写入流
          for (let i = 0; i < batch.length; i++) {
            const { index, extension, originalItem } = batch[i];
            const processedBuffer = processedBuffers[i];

            try {
              imageStream.write({ index, buffer: processedBuffer, extension });
              successfulCount++;
            } catch (streamError) {
              logger.error(`写入流失败 (index ${index}): ${streamError.message}`);
              failedIndexes.push(index);
            }

            // 立即清理原始buffer引用，释放内存
            (originalItem as any).buffer = null;
          }
        } catch (error) {
          // 批量处理失败，回退到逐个处理
          if (this.config.debug) {
            logger.warn(`批量处理失败，回退到逐个处理: ${error.message}`);
          }
          for (const { index, buffer, extension, originalItem } of batch) {
            try {
              const processedBuffer = this.processor.applyAntiGzip(buffer, `${id}-page-${index + 1}`);
              imageStream.write({ index, buffer: processedBuffer, extension });
              successfulCount++;
            } catch (itemError) {
              logger.error(`图片处理失败 (index ${index}): ${itemError.message}`);
              failedIndexes.push(index);
            }
            (originalItem as any).buffer = null;
          }
        }

        processedCount += batch.length;
        batch.length = 0; // 清空批次

        // 强制触发垃圾回收提示（如果可用）
        if (global.gc && typeof global.gc === 'function' && processedCount % 50 === 0) {
          try {
            global.gc();
          } catch {}
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

    // 启动下载workers
    const downloadPromises = Array.from({ length: this.config.downloadConcurrency }, () => downloadWorker());

    // 启动处理workers（批量处理模式下可以减少worker数量，因为每个worker处理多张图片）
    // 批量处理时，worker数量可以较少，因为每个worker处理BATCH_SIZE张图片
    const processingWorkerCount = Math.max(2, Math.floor(this.config.downloadConcurrency / 2));
    const processingPromises = Array.from({ length: processingWorkerCount }, () => processingWorker());

    // 等待所有下载完成
    Promise.all(downloadPromises).then(() => {
      downloadComplete = true;
      if (this.config.debug) logger.info(`所有图片下载完成，等待处理...`);
    });

    // 等待所有处理完成
    Promise.all(processingPromises).then(() => {
      processingComplete = true;
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
