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

本插件提供了 nhentai 漫画搜索与下载功能。

### 主要指令

*   **\`nh search <关键词/ID>\`**:
    *   使用关键词搜索漫画，支持翻页和交互式选择下载。
    *   使用漫画 ID 查询特定漫画的详细信息，并会提示是否立即下载。

*   **\`nh download <ID/链接>\`**:
    *   根据漫画 ID 或 nhentai 链接下载漫画。
    *   支持多种输出选项：
        *   \`-p, --pdf\`: 发送为 PDF 文件。
        *   \`-z, --zip\`: 发送为 ZIP 压缩包。
        *   \`-i, --image\`: 逐张发送图片。
    *   支持为 PDF 和 ZIP 文件设置密码：
        *   \`-k, --key <密码>\`

### 自动功能

*   **链接识别**: 在聊天中直接发送 nhentai 画廊链接，插件会自动触发下载指令。此功能可在配置中禁用。

使用 \`help nh\` 指令可以获取更详细的指令用法和示例。
`

const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot'];

/**
 * 格式化画廊信息为 Koishi 消息元素。
 * @param gallery 画廊数据。
 * @param config 插件配置。
 * @param globalIndex 可选：全局序号，用于搜索结果列表。
 * @returns 包含格式化信息的 Koishi 消息元素。
 */
function formatGalleryInfo(gallery: Partial<Gallery>, config: Config, globalIndex?: number): h {
  const getTags = (type: string) => gallery.tags?.filter(t => t.type === type).map(t => t.name).join(', ') || 'N/A';
  const artists = getTags('artist');
  const language = getTags('language')?.replace(/\b\w/g, l => l.toUpperCase()) || 'N/A';
  const generalTags = gallery.tags?.filter(t => t.type === 'tag').map(t => t.name).slice(0, 5).join(', ');

  let info = '';
  if (typeof globalIndex === 'number') {
    info += `【${globalIndex + 1}】 `
  }
  info += `📘 ${gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'N/A'}\n`
  info += `- ID: ${gallery.id || 'N/A'}\n`
  info += `- 👤 作者: ${artists}\n`
  info += `- 🌐 语言: ${language}\n`
  info += `- 📄 页数: ${gallery.num_pages || 'N/A'}\n`
  info += `- ⭐ 收藏: ${gallery.num_favorites || 'N/A'}\n`
  if (gallery.upload_date) {
    const uploadDate = new Date(gallery.upload_date * 1000).toLocaleDateString('zh-CN');
    info += `- 📅 上传于: ${uploadDate}\n`
  }
  if (config.showTagsInSearch && generalTags) {
    info += `- 🏷️ 标签: ${generalTags}...\n`
  }
  if (config.showLinkInSearch && gallery.id) {
    info += `🔗 链接: https://nhentai.net/g/${gallery.id}/`
  }

  return h('p', info.trim())
}

export function apply(ctx: Context, config: Config) {
  if (config.debug) {
    logger.info('调试模式已启用。');
  }

  ctx.i18n.define('zh-CN', require('../locales/zh-CN.yml'))

  const puppeteerManager = new PuppeteerManager(ctx, config);
  ctx.on('ready', () => puppeteerManager.initialize());
  ctx.on('dispose', () => puppeteerManager.dispose());

  const processor = new Processor(ctx, config)

  async function getGallery(id: string): Promise<Gallery | null> {
    try {
      if (config.debug) logger.info(`[API] 请求画廊: ${id}`)
      const url = `${API_BASE}/gallery/${id}`
      const data = await ctx.http.get<Gallery>(url)
      if (!data || typeof data.id === 'undefined') throw new Error('无效的API响应')
      if (config.debug) logger.info(`[API] 获取画廊 ${id} 成功。`);
      return data
    } catch (error) {
      const errorMessage = JSON.stringify(error.response?.data || error.message, null, 2);
      logger.error(`[API] 请求画廊 ${id} 失败: \n%s`, errorMessage);
      return null
    }
  }

  async function searchGalleries(query: string, page = 1): Promise<SearchResult | null> {
    try {
      if (config.debug) logger.info(`[API] 搜索: "${query}" (第 ${page} 页)`)
      const url = `${API_BASE}/galleries/search?query=${encodeURIComponent(query)}&page=${page}`
      const data = await ctx.http.get<SearchResult>(url)
      if (config.debug) logger.info(`[API] 搜索成功，找到 ${data.result.length} 个原始结果。`);
      if (config.debug && data.result.length > 0) logger.info(`[API] 搜索原始响应:\n%s`, JSON.stringify(data, null, 2));
      return data
    } catch (error)
    {
      const errorMessage = JSON.stringify(error.response?.data || error.message, null, 2);
      logger.error(`[API] 搜索 "${query}" 失败: \n%s`, errorMessage);
      return null
    }
  }

  const nhCmd = ctx.command('nh', 'Nhentai 漫画下载与搜索工具')
    .alias('nhentai')

  ctx.middleware(async (session, next) => {
    if (session.content.startsWith(session.resolve('nh')) || session.content.startsWith(session.resolve('nhentai'))) {
        return next();
    }
    const match = session.stripped.content.match(galleryUrlRegex);
    if (config.enableLinkRecognition && match && match[1]) {
      if (config.debug) logger.info(`[链接识别] 发现 nhentai 链接: ${match[1]}，自动执行下载。`);
      return session.execute(`nh download ${match[1]}`);
    }
    return next();
  }, true);

  nhCmd.subcommand('.search <query:text>', '搜索漫画或根据ID获取漫画信息')
    .alias('搜索', 'search', 'nh搜索')
    .usage(
      '当输入为漫画ID时，将获取该漫画的详细信息，并提示是否下载。\n' +
      '当输入为关键词时，将搜索相关漫画，并支持分页浏览与互动式下载。'
    )
    .example('nh search Konosuba - 搜索关键词为 "Konosuba" 的漫画')
    .example('nh search 123456 - 获取 ID 为 123456 的漫画信息，并提示下载')
    .action(async ({ session }, query) => {
      if (!query) return session.text('.prompt.search-query')

      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + session.text('commands.nh.messages.searching', [query]))
      
      try {
        const isIdSearch = /^\d+$/.test(query);

        if (isIdSearch) {
          const gallery = await getGallery(query);
          if (!gallery) {
            await session.bot.deleteMessage(session.channelId, statusMessageId);
            return session.text('commands.nh.messages.error-gallery-info-failed', [query]);
          }

          const useForward = config.useForwardForSearch && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform);
          const galleryNode = formatGalleryInfo(gallery, config);
          let imageElement: h | null = null;
          const thumb = gallery.images?.thumbnail;
          let page: Page | null = null;

          if (thumb && gallery.media_id) {
              const thumbUrl = `${THUMB_BASE}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`
              try {
                page = await puppeteerManager.getPage();
                const result = await processor.downloadImage(page, thumbUrl, 0, gallery.id as string, 1);
                if ('buffer' in result) {
                  const processedBuffer = await processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
                  imageElement = h.image(bufferToDataURI(processedBuffer, `image/${result.extension}`));
                }
              } catch (e) {
                logger.warn(`[搜索][ID] 下载缩略图失败: %o`, e);
              } finally {
                if (page) await puppeteerManager.releasePage(page);
              }
          }
          
          const messages: h[] = [h('message', galleryNode)];
          if(imageElement) messages[0].children.push(imageElement)

          if (useForward) {
            await session.send(h('figure', {}, messages));
          } else {
            await session.send(messages);
          }
          
          await session.send(session.text('commands.nh.messages.prompt-download-id', [query]));
          const reply = await session.prompt(config.promptTimeout);

          if (!reply) {
            return session.text('commands.nh.messages.timeout');
          } else if (reply.toLowerCase() === 'y') {
            await session.bot.deleteMessage(session.channelId, statusMessageId);
            return session.execute(`nh download ${query}`);
          } else {
            return session.text('commands.nh.messages.cancel');
          }
        } else {
          let currentPage = 1;
          const limit = config.searchResultLimit > 0 ? config.searchResultLimit : 10;
          let currentSearchResult: SearchResult | null = null;
          let totalPages = 0;
          
          const fetchAndDisplayResults = async (page: number) => {
            currentSearchResult = await searchGalleries(query, page);
            if (!currentSearchResult || !currentSearchResult.result || currentSearchResult.result.length === 0) {
              await session.send(session.text('commands.nh.messages.error-not-found', [query]));
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
            const useForward = config.useForwardForSearch && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform);
            const galleryQueue = [...resultsToProcess.map((g, idx) => ({ g, originalIndex: idx }))];
            const messageNodes = new Map<string, h>();
            const workerPages: Page[] = await Promise.all(
              Array.from({ length: config.downloadConcurrency }, () => puppeteerManager.getPage())
            );

            const workerTasks = workerPages.map(page => {
              return async () => {
                let item;
                while ((item = galleryQueue.shift())) {
                  const { g: gallery, originalIndex } = item;
                  if (!gallery?.id || !gallery.title) continue;
                  try {
                    const globalResultIndex = originalIndex + ((currentPage - 1) * limit);
                    const galleryInfoNode = formatGalleryInfo(gallery, config, globalResultIndex);
                    let imageElement: h | null = null;
                    const thumb = gallery.images?.thumbnail;
                    if (thumb && gallery.media_id) {
                        const thumbUrl = `${THUMB_BASE}/galleries/${gallery.media_id}/thumb.${imageExtMap[thumb.t] || 'jpg'}`
                        const result = await processor.downloadImage(page, thumbUrl, 0, gallery.id as string, 1);
                        if ('buffer' in result) {
                          const processedBuffer = await processor.applyAntiGzip(result.buffer, `thumb-${gallery.id}`);
                          imageElement = h.image(bufferToDataURI(processedBuffer, `image/${result.extension}`));
                        }
                    }
                    
                    const messageNode = h('message', galleryInfoNode)
                    if(imageElement) messageNode.children.push(imageElement)
                    messageNodes.set(gallery.id as string, messageNode);
                  } catch (itemError) {
                    logger.error(`[搜索][Worker] 处理画廊 ID ${gallery?.id || '未知'} 时出错: %o`, itemError);
                  }
                }
              }
            });

            await Promise.all(workerTasks.map(worker => worker()));
            for (const p of workerPages) await puppeteerManager.releasePage(p);

            const finalMessageNodes = resultsToProcess.map(g => messageNodes.get(g.id as string)).filter(Boolean);
            if (finalMessageNodes.length === 0) {
              await session.send(session.text('commands.nh.messages.error-all-failed'));
              return null;
            }
            
            const messages: h[] = [
              h('message', h('p', session.text('commands.nh.messages.results-found-page', [finalMessageNodes.length, currentPage, totalPages]))),
              ...finalMessageNodes
            ];
            
            const plainMessages: h[] = [
              h('p', session.text('commands.nh.messages.results-found-page', [finalMessageNodes.length, currentPage, totalPages])),
              ...finalMessageNodes.flatMap(m => m.children)
            ];

            if (useForward) await session.send(h('figure', {}, messages));
            else await session.send(plainMessages);
            
            return currentSearchResult;
          };

          currentSearchResult = await fetchAndDisplayResults(currentPage);
          if (!currentSearchResult) {
            await session.bot.deleteMessage(session.channelId, statusMessageId);
            return;
          }

          while (true) {
            await session.send(session.text('commands.nh.messages.prompt-search-action'));
            const reply = await session.prompt(config.promptTimeout);

            if (!reply) {
              await session.send(session.text('commands.nh.messages.timeout'));
              break;
            }

            const lowerReply = reply.toLowerCase();
            if (lowerReply === 'n') {
              await session.send(session.text('commands.nh.messages.cancel'));
              break;
            } else if (lowerReply === 'f') {
              currentPage++;
              if (currentPage > totalPages && totalPages > 0) currentPage = 1;
              else if (totalPages === 0) currentPage = 1;
              currentSearchResult = await fetchAndDisplayResults(currentPage);
              if (!currentSearchResult) break;
            } else if (/^\d+$/.test(reply)) {
              const selectedIndex = parseInt(reply, 10);
              const currentResultOffset = (currentPage - 1) * limit;
              const localIndex = selectedIndex - currentResultOffset - 1;
              
              if (localIndex >= 0 && localIndex < currentSearchResult.result.length) {
                const gallery = currentSearchResult.result[localIndex];
                if (gallery?.id) {
                  await session.bot.deleteMessage(session.channelId, statusMessageId);
                  return session.execute(`nh download ${gallery.id}`);
                }
              }
              await session.send(session.text('commands.nh.messages.error-invalid-selection'));
            } else {
              await session.send(session.text('commands.nh.messages.error-invalid-input'));
            }
          }
        }
      } catch (error) {
        logger.error(`[搜索] 命令执行失败: %o`, error);
        return session.text('commands.nh.messages.error-command-failed');
      } finally {
        try { await session.bot.deleteMessage(session.channelId, statusMessageId); } catch (e) {}
      }
    })

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
    .example('nh download 123456 -p -k 0721 (下载 ID 123456 的漫画为 PDF，密码为 0721)')
    .example('nh download https://nhentai.net/g/123456/ -i (下载链接对应的漫画为逐张图片)')
    .example('nh download 123456 -z (下载 ID 123456 的漫画为 ZIP)')
    .action(async ({ session, options }, idOrUrl) => {
      if (!idOrUrl) return session.text('.prompt.download-id-or-url')
      
      const match = idOrUrl.match(galleryUrlRegex) || idOrUrl.match(/^\d+$/)
      if (!match) return session.text('commands.nh.messages.error-id-or-url-invalid')
      const id = match[1] || match[0]

      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + session.text('commands.nh.messages.parsing', [id]))
      let tempPdfPath: string = ''
      let pages: Page[] = []; 
      
      try {
        const gallery = await getGallery(id)
        if (!gallery) return session.text('commands.nh.messages.error-gallery-info-failed', [id])

        const imageUrls = gallery.images.pages.map((p, i) => ({
            url: `${IMAGE_BASE}/galleries/${gallery.media_id}/${i + 1}.${imageExtMap[p.t] || 'jpg'}`,
            index: i
        }))
        
        const updateStatus = async (text: string) => {
          if (typeof session.bot.editMessage === 'function') {
            try { await session.bot.editMessage(session.channelId, statusMessageId, text); }
            catch (error) { if (config.debug) logger.warn('[下载] 编辑状态消息失败 (忽略): %o', error); }
          }
        }
        
        await updateStatus(session.text('commands.nh.messages.gallery-info-ok', [imageUrls.length]))
        
        pages = await Promise.all(Array.from({ length: config.downloadConcurrency }, () => puppeteerManager.getPage()));
        
        const successfulDownloads: DownloadedImage[] = [];
        const failedIndexes: number[] = [];
        const imageQueue = [...imageUrls];
        let processedCount = 0;
        
        const worker = async (page: Page) => {
          while (imageQueue.length > 0) {
            const item = imageQueue.shift();
            if (!item) continue;
            const result = await processor.downloadImage(page, item.url, item.index, id);
            processedCount++;
            if ('buffer' in result) successfulDownloads.push(result);
            else failedIndexes.push(item.index);
            await updateStatus(session.text('commands.nh.messages.progress', [processedCount, imageUrls.length]))
          }
        };
        
        await Promise.all(pages.map(page => worker(page)));
        
        successfulDownloads.sort((a, b) => a.index - b.index)
        if(successfulDownloads.length === 0) return session.text('commands.nh.messages.error-all-images-failed')

        const safeFilename = (gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'untitled').replace(/[\\/:\*\?"<>\|]/g, '_')
        
        let outputType: 'zip' | 'pdf' | 'img' = config.defaultOutput;
        if (options.pdf) outputType = 'pdf';
        else if (options.zip) outputType = 'zip';
        else if (options.image) outputType = 'img';
        const password = options.key || config.defaultPassword

        if (outputType === 'pdf') {
          await updateStatus(session.text('commands.nh.messages.pdf-generating'))
          tempPdfPath = await processor.createPdf(successfulDownloads, id, updateStatus, password);
          if (config.pdfSendMethod === 'buffer') {
            const pdfBuffer = await readFile(tempPdfPath);
            await session.send(h.file(pdfBuffer, 'application/pdf', { title: `${safeFilename}.pdf` }))
          } else {
            await session.send(h.file(pathToFileURL(tempPdfPath).href, { title: `${safeFilename}.pdf` }))
          }
        } else if (outputType === 'zip') {
          await updateStatus(session.text('commands.nh.messages.zip-generating'))
          const zipBuffer = await processor.createZip(successfulDownloads, password);
          await session.send(h.file(zipBuffer, 'application/zip', { title: `${safeFilename}.zip` }))
        }
        
        let successMessage = session.text('commands.nh.messages.success', [safeFilename]);
        if (['zip', 'pdf'].includes(outputType) && password) {
            successMessage += session.text('commands.nh.messages.password-prompt', [password]);
        }
        
        if (outputType === 'img') {
          const useForward = config.useForwardForDownload && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform);
          if (useForward) {
              const forwardElements: h[] = await Promise.all(successfulDownloads.map(async item => {
                const processedBuffer = await processor.applyAntiGzip(item.buffer, `${id}-page-${item.index + 1}`);
                return h.image(bufferToDataURI(processedBuffer, `image/${item.extension}`));
              }));
              await session.send(h('figure', {}, forwardElements));
          } else {
              for (const { index, buffer, extension } of successfulDownloads) {
                  const processedBuffer = await processor.applyAntiGzip(buffer, `${id}-page-${index + 1}`);
                  await session.send(session.text('commands.nh.messages.image-progress', [index + 1, imageUrls.length]) + h.image(bufferToDataURI(processedBuffer, `image/${extension}`)));
                  await sleep(config.imageSendDelay);
              }
          }
        } else {
          await session.send(successMessage)
        }
        
        if (failedIndexes.length > 0) {
            await session.send(session.text('commands.nh.messages.partial-success', [failedIndexes.length]))
        }
      } catch (error) {
        logger.error(`[下载] 任务 ID ${id} 失败: %o`, error);
        // [最终修正] 修正 i18n 键，与 yml 文件保持一致
        return h('quote', { id: session.messageId }) + session.text('commands.nh.messages.error-command-failed', [error.message]);
      } finally {
        try { await session.bot.deleteMessage(session.channelId, statusMessageId) } catch (e) {}
        if (tempPdfPath) try { await rm(tempPdfPath, { force: true }) } catch(e) {}
        for (const page of pages) {
          await puppeteerManager.releasePage(page);
        }
      }
    })
}