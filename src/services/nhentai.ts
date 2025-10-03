// src/services/nhentai.ts
import { Config } from '../config'
import { logger, sleep } from '../utils'
import { ApiService, Gallery, IMAGE_BASE, THUMB_BASE, galleryUrlRegex, imageExtMap, SearchResult } from './api'
import { Processor, DownloadedImage } from '../processor'
import { PuppeteerManager } from '../puppeteer'
import type { Page } from 'puppeteer-core'

export interface GalleryWithCover {
  gallery: Gallery;
  cover?: {
    buffer: Buffer;
    extension: string;
  };
}

// [移除] 不再需要这个接口
// export interface SearchResultWithCovers { ... }

export type DownloadOutput = 
  | { type: 'pdf'; path: string; filename: string }
  | { type: 'zip'; buffer: Buffer; filename: string }
  | { type: 'images'; images: DownloadedImage[]; filename: string; failedIndexes: number[] }

export class NhentaiService {
  constructor(
    private config: Config,
    private apiService: ApiService,
    private processor: Processor,
    private puppeteerManager: PuppeteerManager,
  ) {}

  public async getGalleryWithCover(id: string): Promise<GalleryWithCover | null> {
    const gallery = await this.apiService.getGallery(id);
    if (!gallery) return null;

    const thumb = gallery.images?.thumbnail;
    if (thumb && gallery.media_id) {
      let page: Page | null = null;
      try {
        const thumbUrl = `${THUMB_BASE}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`;
        page = await this.puppeteerManager.getPage();
        const result = await this.processor.downloadImage(page, thumbUrl, 0, gallery.id, 1);
        if ('buffer' in result) {
          const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
          return { gallery, cover: { buffer: processedBuffer, extension: result.extension } };
        }
      } catch (e) {
        logger.warn(`[Service] 下载画廊 ${id} 的缩略图失败: %o`, e);
      } finally {
        if (page) await this.puppeteerManager.releasePage(page);
      }
    }
    return { gallery };
  }
  
  // [新增] 专门为给定的画廊列表下载封面
  public async getCoversForGalleries(galleries: Partial<Gallery>[]): Promise<Map<string, { buffer: Buffer; extension: string }>> {
    const covers = new Map<string, { buffer: Buffer; extension: string }>();
    if (galleries.length === 0) return covers;

    const galleryQueue = [...galleries];
    const workerPages: Page[] = await Promise.all(
      Array.from({ length: Math.min(this.config.downloadConcurrency, galleries.length) }, () => this.puppeteerManager.getPage())
    );

    const workerTasks = workerPages.map(page => (async () => {
      let gallery: Partial<Gallery>;
      while ((gallery = galleryQueue.shift())) {
        if (!gallery?.id || !gallery.title) continue;
        const thumb = gallery.images?.thumbnail;
        if (thumb && gallery.media_id) {
          try {
            const thumbUrl = `${THUMB_BASE}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`;
            const result = await this.processor.downloadImage(page, thumbUrl, 0, gallery.id as string, 1);
            if ('buffer' in result) {
              const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
              covers.set(gallery.id as string, { buffer: processedBuffer, extension: result.extension });
            }
          } catch (itemError) {
            logger.error(`[Service] 处理画廊 ${gallery?.id} 缩略图时出错: %o`, itemError);
          }
        }
      }
    })());
    
    await Promise.all(workerTasks);
    for (const p of workerPages) await this.puppeteerManager.releasePage(p);

    return covers;
  }

  // [移除] searchByKeywordWithCovers 方法已被 getCoversForGalleries 替代，以实现更好的逻辑解耦

  public async getRandomGalleryId(): Promise<string | null> {
    let page: Page | null = null;
    try {
      page = await this.puppeteerManager.getPage();
      await page.goto('https://nhentai.net/random', { waitUntil: 'domcontentloaded' });
      const finalUrl = page.url();
      const match = finalUrl.match(galleryUrlRegex);
      if (!match || !match[1]) {
        throw new Error('无法从重定向后的URL中解析画廊ID');
      }
      const randomId = match[1];
      if (this.config.debug) logger.info(`[Service] 获取到随机画廊ID: ${randomId}`);
      return randomId;
    } finally {
      if (page) {
        await this.puppeteerManager.releasePage(page);
      }
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
      url: `${IMAGE_BASE}/galleries/${gallery.media_id}/${i + 1}.${imageExtMap[p.t] || 'jpg'}`,
      index: i
    }));
    await onProgress(`画廊信息获取成功，共 ${imageUrls.length} 页图片。`);

    let pages: Page[] = [];
    try {
      pages = await Promise.all(Array.from({ length: this.config.downloadConcurrency }, () => this.puppeteerManager.getPage()));
      const successfulDownloads: DownloadedImage[] = [];
      const failedIndexes: number[] = [];
      const imageQueue = [...imageUrls];
      let processedCount = 0;

      const worker = async (page: Page) => {
        while (imageQueue.length > 0) {
          const item = imageQueue.shift();
          if (!item) continue;
          const result = await this.processor.downloadImage(page, item.url, item.index, id);
          processedCount++;
          if ('buffer' in result) successfulDownloads.push(result);
          else failedIndexes.push(item.index);
          await onProgress(`正在下载图片: ${processedCount} / ${imageUrls.length} ...`);
        }
      };
      await Promise.all(pages.map(page => worker(page)));

      successfulDownloads.sort((a, b) => a.index - b.index);
      if (successfulDownloads.length === 0) {
        return { error: '所有图片下载失败，无法生成文件。' };
      }
      
      const safeFilename = (gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'untitled').replace(/[\\/:\*\?"<>\|]/g, '_');
      
      switch(outputType) {
        case 'pdf':
          await onProgress('所有图片下载完成，正在生成 PDF 文件...');
          const tempPdfPath = await this.processor.createPdf(successfulDownloads, id, onProgress, password);
          return { type: 'pdf', path: tempPdfPath, filename: `${safeFilename}.pdf` };

        case 'zip':
          await onProgress('所有图片下载完成，正在生成 ZIP 压缩包...');
          const zipBuffer = await this.processor.createZip(successfulDownloads, password);
          return { type: 'zip', buffer: zipBuffer, filename: `${safeFilename}.zip` };

        case 'img':
          return { type: 'images', images: successfulDownloads, filename: safeFilename, failedIndexes };
      }

    } finally {
      for (const page of pages) {
        await this.puppeteerManager.releasePage(page);
      }
    }
  }
}