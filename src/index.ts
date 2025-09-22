// src/index.ts
import { Context, h, Argv, Session } from 'koishi'
import { Config } from './config'
import { logger, bufferToDataURI, sleep } from './utils'
import { API_BASE, IMAGE_BASE, THUMB_BASE, Gallery, SearchResult, galleryUrlRegex, imageExtMap } from './api'
import { DownloadedImage, Processor } from './processor'
import { PuppeteerManager } from './puppeteer'
import { readFile, rm } from 'fs/promises'
import { pathToFileURL } from 'url'
import * as path from 'path'
import type { Page } from 'puppeteer-core'

export * from './config'
export const name = 'nhentai-downloader'
export const inject = ['http']

export const usage = `
## 使用说明
本插件提供 **[nhentai](https://nhentai.net/)** 漫画搜索与下载功能（需要配置代理）。

---

### 指令用法
* **\`nh search <关键词/ID>\`**
    * 使用关键词搜索漫画，支持翻页和交互式选择下载。
    * 使用漫画 ID 查询特定漫画的详细信息，并提示是否下载。

* **\`nh download <ID/链接>\`**
    * 根据漫画 ID 或 nhentai 链接下载漫画。

* **\`nh random\`**
    * 随机推荐一本漫画。

* **\`nh popular\`**
    * 查看当前的热门漫画列表。

* 使用 \`help nh\` 指令可以获取更详细的指令用法和示例。

---

### 其他功能
*   **链接识别**: 在聊天中发送 nhentai 画廊链接，插件会自动触发下载指令。此功能可在配置中禁用。
`

const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot'];

interface DownloadOptions {
  pdf?: boolean;
  zip?: boolean;
  image?: boolean;
  key?: string;
}

class InMemoryCache {
  private store = new Map<string, { value: any; timer?: NodeJS.Timeout }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    return entry?.value;
  }

  async set(key: string, value: any, maxAge?: number): Promise<void> {
    const existing = this.store.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    let timer: NodeJS.Timeout | undefined;
    if (maxAge) {
      timer = setTimeout(() => this.store.delete(key), maxAge);
    }
    this.store.set(key, { value, timer });
  }

  dispose() {
    for (const { timer } of this.store.values()) {
      if (timer) clearTimeout(timer);
    }
    this.store.clear();
  }
}

class NhentaiPlugin {
  private puppeteerManager: PuppeteerManager;
  private processor: Processor;
  private memoryCache: InMemoryCache;

  constructor(private ctx: Context, private config: Config) {
    if (config.debug) {
      logger.info('调试模式已启用。');
    }
    this.memoryCache = new InMemoryCache();
    ctx.on('dispose', () => this.memoryCache.dispose());
    this.puppeteerManager = new PuppeteerManager(ctx, config);
    this.processor = new Processor(ctx, config);
  }

  public start() {
    this.ctx.on('ready', () => this.puppeteerManager.initialize());
    this.ctx.on('dispose', () => this.puppeteerManager.dispose());
    this.registerMiddleware();
    this.registerCommands();
  }

  private registerMiddleware() {
    this.ctx.middleware(async (session, next) => {
      if (session.content.startsWith(session.resolve('nh')) || session.content.startsWith(session.resolve('nhentai'))) {
        return next();
      }
      const match = session.stripped.content.match(galleryUrlRegex);
      if (this.config.enableLinkRecognition && match && match[1]) {
        if (this.config.debug) logger.info(`[链接识别] 发现 nhentai 链接: ${match[1]}，自动执行下载。`);
        return session.execute(`nh download ${match[1]}`);
      }
      return next();
    }, true);
  }

  // [优化] 恢复指令的详细用法和示例，并添加更多别名
  private registerCommands() {
    const nhCmd = this.ctx.command('nh', 'Nhentai 漫画下载与搜索工具')
      .alias('nhentai');

    nhCmd.subcommand('.search <query:text>', '搜索漫画或根据ID获取漫画信息')
      .alias('搜索', 'search', 'nh搜索')
      .usage(
        '当输入为漫画ID时，将获取该漫画的详细信息，并提示是否下载。\n' +
        '当输入为关键词时，将搜索相关漫画，并支持分页浏览与互动式下载。'
      )
      .example('nh search touhou - 搜索关键词为 "touhou" 的漫画')
      .example('nh search 177013 - 获取 ID 为 177013 的漫画信息')
      .action(async ({ session }, query) => {
        if (!query) return session.send('请输入搜索关键词或漫画ID。');
        const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在搜索 ${query}...`);
        try {
          if (/^\d+$/.test(query)) {
            await this._handleIdSearch(session, query);
          } else {
            await this._handleKeywordSearch(session, query);
          }
        } catch (error) {
          logger.error(`[搜索] 命令执行失败: %o`, error);
          await session.send(`指令执行失败: ${error.message}`);
        } finally {
          try { await session.bot.deleteMessage(session.channelId, statusMessageId); } catch (e) {}
        }
      });

    nhCmd.subcommand('.download <idOrUrl>', '下载指定ID或链接的漫画')
      .alias('下载', 'download', 'nh下载')
      .option('pdf', '-p 以 PDF 文件形式发送。')
      .option('zip', '-z 以 ZIP 压缩包形式发送。')
      .option('image', '-i 以逐张图片形式发送。')
      .option('key', '-k <password:string> 为生成的 PDF 或 ZIP 文件设置密码。')
      .usage(
        '通过漫画ID或nhentai链接下载漫画。你可以选择输出格式和设置密码。\n' +
        '未指定输出格式时，将使用插件配置中的 `defaultOutput` 选项。'
      )
      .example('nh download 123456 -z - 下载 ID 123456 的漫画为 ZIP')
      .example('nh download https://nhentai.net/g/123456/ -i - 下载链接对应的漫画为逐张图片')
      .example('nh download 123456 -p -k mypassword - 下载 ID 123456 的漫画为 PDF，密码为 mypassword')
      .action(async ({ session, options }, idOrUrl) => {
        if (!idOrUrl) return session.send('请输入要下载的漫画ID或链接。');
        const match = idOrUrl.match(galleryUrlRegex) || idOrUrl.match(/^\d+$/);
        if (!match) return session.send('输入的ID或链接无效，请检查后重试。');
        const id = match[1] || match[0];
        const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在解析画廊 ${id}...`);
        try {
          await this._executeDownload(session, id, options, statusMessageId);
        } catch (error) {
          logger.error(`[下载] 任务 ID ${id} 失败: %o`, error);
          await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${error.message}`);
        } finally {
          try { await session.bot.deleteMessage(session.channelId, statusMessageId); } catch (e) {}
        }
      });

    nhCmd.subcommand('.random', '随机推荐一本漫画')
      .alias('随机', 'random', 'nh随机', '天降好运')
      .usage('随机获取一本 nhentai 漫画的详细信息，并提示是否下载。')
      .example('nh random')
      .action(async ({ session }) => {
        const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + '正在进行一次天降好运...');
        try {
          await this._handleRandomCommand(session);
        } catch (error) {
          logger.error(`[随机] 命令执行失败: %o`, error);
          await session.send(`指令执行失败: ${error.message}`);
        } finally {
          try { await session.bot.deleteMessage(session.channelId, statusMessageId); } catch (e) {}
        }
      });
      
    nhCmd.subcommand('.popular', '查看当前的热门漫画')
      .alias('热门', 'popular', 'nh热门')
      .usage('获取 nhentai 当前的热门漫画列表，支持翻页和交互式下载。')
      .example('nh popular')
      .action(async ({ session }) => {
        const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + '正在获取热门漫画...');
        try {
          await this._handleKeywordSearch(session, 'popular', 'popular');
        } catch (error) {
          logger.error(`[热门] 命令执行失败: %o`, error);
          await session.send(`指令执行失败: ${error.message}`);
        } finally {
          try { await session.bot.deleteMessage(session.channelId, statusMessageId); } catch (e) {}
        }
      });
  }

  private async getGallery(id: string): Promise<Gallery | null> {
    const cacheKey = `nhentai:gallery:${id}`;
    if (this.config.cache.enableApiCache) {
      const cached = await this.memoryCache.get<Gallery>(cacheKey);
      if (cached) {
        if (this.config.debug) logger.info(`[Cache] 命中画廊缓存: ${id}`);
        return cached;
      }
    }
    try {
      if (this.config.debug) logger.info(`[API] 请求画廊: ${id}`);
      const url = `${API_BASE}/gallery/${id}`;
      const data = await this.ctx.http.get<Gallery>(url);
      if (!data || typeof data.id === 'undefined') throw new Error('无效的API响应');
      if (this.config.debug) logger.info(`[API] 获取画廊 ${id} 成功。`);
      if (this.config.cache.enableApiCache) {
        this.memoryCache.set(cacheKey, data, this.config.cache.apiCacheTTL);
      }
      return data;
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.data || error.message, null, 2);
      logger.error(`[API] 请求画廊 ${id} 失败: \n%s`, errorMessage);
      return null;
    }
  }

  private async searchGalleries(query: string, page = 1, sort?: string): Promise<SearchResult | null> {
    const cacheKey = `nhentai:search:${query}:${page}:${sort || ''}`;
    if (this.config.cache.enableApiCache) {
      const cached = await this.memoryCache.get<SearchResult>(cacheKey);
      if (cached) {
        if (this.config.debug) logger.info(`[Cache] 命中搜索缓存: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`);
        return cached;
      }
    }
    try {
      if (this.config.debug) logger.info(`[API] 搜索: "${query}" (第 ${page} 页, 排序: ${sort || '默认'})`);
      let url = `${API_BASE}/galleries/search?query=${encodeURIComponent(query)}&page=${page}`;
      if (sort) url += `&sort=${sort}`;
      const data = await this.ctx.http.get<SearchResult>(url);
      if (this.config.debug) logger.info(`[API] 搜索成功，找到 ${data.result.length} 个原始结果。`);
      if (this.config.cache.enableApiCache) {
        this.memoryCache.set(cacheKey, data, this.config.cache.apiCacheTTL);
      }
      return data;
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.data || error.message, null, 2);
      logger.error(`[API] 搜索 "${query}" 失败: \n%s`, errorMessage);
      return null;
    }
  }

  private _formatGalleryInfo(gallery: Partial<Gallery>, globalIndex?: number): h {
    const getTags = (type: string) => gallery.tags?.filter(t => t.type === type).map(t => t.name).join(', ') || 'N/A';
    const artists = getTags('artist');
    const language = getTags('language')?.replace(/\b\w/g, l => l.toUpperCase()) || 'N/A';
    const generalTags = gallery.tags?.filter(t => t.type === 'tag').map(t => t.name).slice(0, 5).join(', ');
    let info = '';
    if (typeof globalIndex === 'number') info += `【${globalIndex + 1}】 `;
    info += `📘 ${gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'N/A'}\n`;
    info += `- ID: ${gallery.id || 'N/A'}\n`;
    info += `- 👤 作者: ${artists}\n`;
    info += `- 🌐 语言: ${language}\n`;
    info += `- 📄 页数: ${gallery.num_pages || 'N/A'}\n`;
    info += `- ⭐ 收藏: ${gallery.num_favorites || 'N/A'}\n`;
    if (gallery.upload_date) info += `- 📅 上传于: ${new Date(gallery.upload_date * 1000).toLocaleDateString('zh-CN')}\n`;
    if (this.config.showTagsInSearch && generalTags) info += `- 🏷️ 标签: ${generalTags}...\n`;
    if (this.config.showLinkInSearch && gallery.id) info += `🔗 链接: https://nhentai.net/g/${gallery.id}/`;
    return h('p', info.trim());
  }

  private async _handleIdSearch(session: Session, id: string) {
    const gallery = await this.getGallery(id);
    if (!gallery) {
      await session.send(`获取画廊 ${id} 信息失败，请检查ID或链接是否正确。`);
      return;
    }
    const galleryNode = this._formatGalleryInfo(gallery);
    let imageElement: h | null = null;
    const thumb = gallery.images?.thumbnail;
    let page: Page | null = null;
    if (thumb && gallery.media_id) {
        const thumbUrl = `${THUMB_BASE}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`;
        try {
          page = await this.puppeteerManager.getPage();
          const result = await this.processor.downloadImage(page, thumbUrl, 0, gallery.id as string, 1);
          if ('buffer' in result) {
            const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
            imageElement = h.image(bufferToDataURI(processedBuffer, `image/${result.extension}`));
          }
        } catch (e) {
          logger.warn(`[搜索][ID] 下载缩略图失败: %o`, e);
        } finally {
          if (page) await this.puppeteerManager.releasePage(page);
        }
    }
    const message = h('message', galleryNode);
    if(imageElement) message.children.push(imageElement);
    if (this.config.useForwardForSearch && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform)) {
      await session.send(h('figure', {}, message));
    } else {
      await session.send(message);
    }
    await session.send(`是否下载 ID ${id} 的漫画? (Y/N)`);
    const reply = await session.prompt(this.config.promptTimeout);
    if (!reply) {
      await session.send('操作超时，已自动取消。');
    } else if (reply.toLowerCase() === 'y') {
      await session.execute(`nh download ${id}`);
    } else {
      await session.send('操作已取消。');
    }
  }

  private async _handleKeywordSearch(session: Session, query: string, sort?: string) {
    let currentPage = 1;
    const limit = this.config.searchResultLimit > 0 ? this.config.searchResultLimit : 10;
    let currentSearchResult: SearchResult | null = null;
    let totalPages = 0;
    const fetchAndDisplayResults = async (page: number) => {
      currentSearchResult = await this.searchGalleries(query, page, sort);
      if (!currentSearchResult || !currentSearchResult.result || currentSearchResult.result.length === 0) {
        await session.send(`未找到与“${query}”相关的漫画。`);
        return null;
      }
      totalPages = Math.ceil((currentSearchResult.num_pages || 0) / currentSearchResult.per_page);
      if (currentSearchResult.num_pages === 0) totalPages = 0;
      else if (currentSearchResult.num_pages <= currentSearchResult.per_page) totalPages = 1;
      if (page > totalPages && totalPages > 0) {
        currentPage = 1;
        return fetchAndDisplayResults(currentPage);
      }
      const resultsToProcess = currentSearchResult.result.slice(0, limit);
      const galleryQueue = [...resultsToProcess.map((g, idx) => ({ g, originalIndex: idx }))];
      const messageNodes = new Map<string, h>();
      const workerPages: Page[] = await Promise.all(
        Array.from({ length: this.config.downloadConcurrency }, () => this.puppeteerManager.getPage())
      );
      const workerTasks = workerPages.map(page => (async () => {
        let item;
        while ((item = galleryQueue.shift())) {
          const { g: gallery, originalIndex } = item;
          if (!gallery?.id || !gallery.title) continue;
          try {
            const globalResultIndex = originalIndex + ((currentPage - 1) * limit);
            const galleryInfoNode = this._formatGalleryInfo(gallery, globalResultIndex);
            let imageElement: h | null = null;
            const thumb = gallery.images?.thumbnail;
            if (thumb && gallery.media_id) {
                const thumbUrl = `${THUMB_BASE}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`;
                const result = await this.processor.downloadImage(page, thumbUrl, 0, gallery.id as string, 1);
                if ('buffer' in result) {
                  const processedBuffer = await this.processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
                  imageElement = h.image(bufferToDataURI(processedBuffer, `image/${result.extension}`));
                }
            }
            const messageNode = h('message', galleryInfoNode);
            if(imageElement) messageNode.children.push(imageElement);
            messageNodes.set(gallery.id as string, messageNode);
          } catch (itemError) {
            logger.error(`[搜索][Worker] 处理画廊 ID ${gallery?.id || '未知'} 时出错: %o`, itemError);
          }
        }
      })());
      await Promise.all(workerTasks);
      for (const p of workerPages) await this.puppeteerManager.releasePage(p);
      const finalMessageNodes = resultsToProcess.map(g => messageNodes.get(g.id as string)).filter(Boolean);
      if (finalMessageNodes.length === 0) {
        await session.send('所有漫画处理失败，请稍后再试。');
        return null;
      }
      const header = h('message', h('p', `找到 ${finalMessageNodes.length} 个结果 (第 ${currentPage} / ${totalPages} 页)。`));
      if (this.config.useForwardForSearch && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform)) {
        await session.send(h('figure', {}, [header, ...finalMessageNodes]));
      } else {
        await session.send([header, ...finalMessageNodes.flatMap(m => m.children)]);
      }
      return currentSearchResult;
    };
    currentSearchResult = await fetchAndDisplayResults(currentPage);
    if (!currentSearchResult) return;
    while (true) {
      await session.send("回复序号下载，'F'翻页，'N'退出。");
      const reply = await session.prompt(this.config.promptTimeout);
      if (!reply) {
        await session.send('操作超时，已自动取消。');
        break;
      }
      const lowerReply = reply.toLowerCase();
      if (lowerReply === 'n') {
        await session.send('操作已取消。');
        break;
      } else if (lowerReply === 'f') {
        currentPage = (currentPage % totalPages) + 1;
        currentSearchResult = await fetchAndDisplayResults(currentPage);
        if (!currentSearchResult) break;
      } else if (/^\d+$/.test(reply)) {
        const selectedIndex = parseInt(reply, 10) - 1;
        const resultIndex = currentSearchResult.result.findIndex((_, i) => i + ((currentPage - 1) * limit) === selectedIndex);
        if (resultIndex !== -1) {
          const gallery = currentSearchResult.result[resultIndex];
          if (gallery?.id) return session.execute(`nh download ${gallery.id}`);
        }
        await session.send("无效的选择，请回复正确的序号、'F'或'N'。");
      } else {
        await session.send("无效的输入，请回复序号、'F'或'N'。");
      }
    }
  }

  private async _handleRandomCommand(session: Session) {
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
      if (this.config.debug) logger.info(`[随机] 获取到随机画廊ID: ${randomId}`);
      await this._handleIdSearch(session, randomId);
    } finally {
      if (page) {
        await this.puppeteerManager.releasePage(page);
      }
    }
  }

  private async _executeDownload(session: Session, id: string, options: DownloadOptions, statusMessageId: string) {
    let tempPdfPath: string = '';
    let pages: Page[] = [];
    try {
      const gallery = await this.getGallery(id);
      if (!gallery) {
        await session.send(`获取画廊 ${id} 信息失败，请检查ID或链接是否正确。`);
        return;
      }
      const imageUrls = gallery.images.pages.map((p, i) => ({
          url: `${IMAGE_BASE}/galleries/${gallery.media_id}/${i + 1}.${imageExtMap[p.t] || 'jpg'}`,
          index: i
      }));
      const updateStatus = async (text: string) => {
        if (typeof session.bot.editMessage === 'function') {
          try { await session.bot.editMessage(session.channelId, statusMessageId, text); }
          catch (error) { if (this.config.debug) logger.warn('[下载] 编辑状态消息失败 (忽略): %o', error); }
        }
      };
      await updateStatus(`画廊信息获取成功，共 ${imageUrls.length} 页图片。`);
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
          await updateStatus(`正在下载图片: ${processedCount} / ${imageUrls.length} ...`);
        }
      };
      await Promise.all(pages.map(page => worker(page)));
      successfulDownloads.sort((a, b) => a.index - b.index);
      if(successfulDownloads.length === 0) {
        await session.send('所有图片下载失败，无法生成文件。');
        return;
      }
      const safeFilename = (gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'untitled').replace(/[\\/:\*\?"<>\|]/g, '_');
      let outputType: 'zip' | 'pdf' | 'img' = this.config.defaultOutput;
      if (options.pdf) outputType = 'pdf';
      else if (options.zip) outputType = 'zip';
      else if (options.image) outputType = 'img';
      const password = options.key || this.config.defaultPassword;
      if (outputType === 'pdf') {
        await updateStatus('所有图片下载完成，正在生成 PDF 文件...');
        tempPdfPath = await this.processor.createPdf(successfulDownloads, id, updateStatus, password);
        if (this.config.pdfSendMethod === 'buffer') {
          const pdfBuffer = await readFile(tempPdfPath);
          await session.send(h.file(pdfBuffer, 'application/pdf', { title: `${safeFilename}.pdf` }));
        } else {
          await session.send(h.file(pathToFileURL(tempPdfPath).href, { title: `${safeFilename}.pdf` }));
        }
      } else if (outputType === 'zip') {
        await updateStatus('所有图片下载完成，正在生成 ZIP 压缩包...');
        const zipBuffer = await this.processor.createZip(successfulDownloads, password);
        await session.send(h.file(zipBuffer, 'application/zip', { title: `${safeFilename}.zip` }));
      }
      let successMessage = `任务完成: ${safeFilename}`;
      if (['zip', 'pdf'].includes(outputType) && password) {
          successMessage += `，密码为: ${password}`;
      }
      if (outputType === 'img') {
        const useForward = this.config.useForwardForDownload && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform);
        const imageElements = await Promise.all(successfulDownloads.map(async item => {
          const processedBuffer = await this.processor.applyAntiGzip(item.buffer, `${id}-page-${item.index + 1}`);
          return { ...item, buffer: processedBuffer };
        }));
        if (useForward) {
          await session.send(h('figure', {}, imageElements.map(item => h.image(bufferToDataURI(item.buffer, `image/${item.extension}`)))));
        } else {
          for (const { index, buffer, extension } of imageElements) {
            await session.send(`正在发送图片: ${index + 1} / ${imageUrls.length}` + h.image(bufferToDataURI(buffer, `image/${extension}`)));
            await sleep(this.config.imageSendDelay);
          }
        }
      }
      await session.send(successMessage);
      if (failedIndexes.length > 0) {
        const failedPages = failedIndexes.map(i => i + 1).join(', ');
        await session.send(`有 ${failedIndexes.length} 张图片下载失败，页码为: ${failedPages}。`);
      }
    } finally {
      if (tempPdfPath) try { await rm(tempPdfPath, { force: true }); } catch(e) {}
      for (const page of pages) {
        await this.puppeteerManager.releasePage(page);
      }
    }
  }
}

export function apply(ctx: Context, config: Config) {
  new NhentaiPlugin(ctx, config).start();
}