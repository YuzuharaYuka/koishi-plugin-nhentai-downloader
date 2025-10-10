// src/index.ts
import { Context, h, Session } from 'koishi'
import { Config } from './config'
import { logger, bufferToDataURI, sleep } from './utils'
import { Processor } from './processor'
import { readFile, rm } from 'fs/promises'
import { pathToFileURL } from 'url'
import { ApiService, Gallery, SearchResult, galleryUrlRegex, Tag } from './services/api'
import { NhentaiService } from './services/nhentai'

export * from './config'
export const name = 'nhentai-downloader'
export const inject = ['http']

export const usage = `
### 本插件提供 **[nhentai](https://nhentai.net/)** 漫画的搜索与下载功能。

---

### 指令用法
\`< >\`为必需项，\`[ ]\`为可选项。
### \`nh.search <关键词> [排序] [语言]\`
根据关键词搜索漫画，支持筛选与排序。
* **别名:** \`nh搜索\`, \`nh search\`
* **选项:** 留空则使用默认配置
  * \`-s, --sort <type>\`: 按热门度排序。可选值为 \`popular\`, \`popular-today\`, \`popular-week\`。
  * \`-l, --lang <lang>\`: 筛选特定语言。可选值为 \`chinese\`, \`japanese\`, \`english\`。设为 \`all\` 则不进行语言筛选。
* **示例1:**\`nh搜索 touhou\`  搜索含 "touhou" 的作品。
* **示例2:**\`nh search touhou -s popular -l chinese\`  搜索中文的 "touhou" 作品，并按热门度排序。
* **交互:** 回复序号下载漫画，回复 \`F\` 翻至下一页，回复 \`B\` 返回上一页，回复 \`N\` 退出交互。

---

### \`nh.search <漫画ID>\`
通过漫画 ID 获取作品详情，并提示是否下载。
* **示例:** \`nh.search 177013\` 获取 ID 为 177013 的漫画信息。
* **交互:** 回复 \`Y\` 确认下载，回复 \`N\` 取消。

---

### \`nh.download <ID/链接> [发送格式] [密码]\`
使用漫画 ID 或 nhentai 官网链接直接下载作品。
* **别名:** \`nh下载\`, \`nh download\`
* **选项:** 留空则使用默认配置
  * \`-p, --pdf\`: 输出为 PDF 文件。
  * \`-z, --zip\`: 输出为 ZIP 压缩包。
  * \`-i, --image\`: 输出为逐张图片。
  * \`-k, --key <密码>\`: 为 PDF 或 ZIP 文件设置密码。
* **示例:**
  - \`nh下载 202327 -z -k 1234\` 下载 ID 为 202327 的漫画，发送加密 ZIP 文件，密码为 1234。
  - \`nh download https://nhentai.net/g/202327/ --pdf\` 下载链接对应的漫画，发送 PDF 文件。

---

### \`nh.popular\`
查看当前的热门漫画列表，功能等同于 \`nh.search "" -s popular\`
* **别名:** \`nh热门\`, \`nh popular\`

### \`nh.random\`
随机推荐一本漫画。
* **别名:** \`nh随机\`, \`nh random\`, \`天降好运\`

---

**链接识别:** 在聊天中直接发送 nhentai 画廊链接，插件会自动响应并提示下载。此功能可在配置中关闭。

## ⚠️ 注意事项
* 本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。
* 本插件仅供学习与交流使用，请勿用于商业用途。请尊重原作者的版权，合理使用下载的内容。
* 插件需要能够访问 nhentai.net，如果服务器网络受限，请确保已配置代理。
* 使用 \`help <指令名>\` (例如 \`help nh搜索\`) 可以获取详细的指令用法和选项说明。
`

const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot'];

interface DownloadOptions {
  pdf?: boolean;
  zip?: boolean;
  image?: boolean;
  key?: string;
}

interface SearchOptions {
  sort?: 'popular' | 'popular-today' | 'popular-week';
  lang?: 'chinese' | 'japanese' | 'english' | 'all';
}

const tagTypeDisplayMap: Record<Tag['type'], string> = {
  parody: '🎭 原作',
  character: '👥 角色',
  artist: '👤 作者',
  group: '🏢 社团',
  language: '🌐 语言',
  category: '📚 分类',
  tag: '🏷️ 标签',
};

class NhentaiPlugin {
  private processor: Processor;
  private apiService: ApiService;
  private nhentaiService: NhentaiService;

  constructor(private ctx: Context, private config: Config) {
    if (config.debug) {
      logger.info('调试模式已启用。');
    }
    this.apiService = new ApiService(ctx, config);
    this.processor = new Processor(ctx, config);
    this.nhentaiService = new NhentaiService(config, this.apiService, this.processor);
  }

  public start() {
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

  private registerCommands() {
    const nhCmd = this.ctx.command('nh', 'Nhentai 漫画下载与搜索工具')
      .alias('nhentai');

    nhCmd.subcommand('.search <query:text>', '搜索漫画或根据ID获取漫画信息')
      .alias('搜索', 'search', 'nh搜索')
      .option('sort', '-s <sort:string> 按热门排序 (可选值: popular, popular-today, popular-week)')
      .option('lang', '-l <lang:string> 指定语言 (可选值: chinese, japanese, english, all)')
      .usage(
        '根据关键词或漫画 ID 进行搜索。\n' +
        '- 当输入为关键词时，返回分页的搜索结果，支持交互式翻页和下载。可使用 -s (--sort) 和 -l (--lang) 选项进行排序和语言筛选。\n' +
        '- 当输入为漫画 ID 时，直接获取该作品的详细信息并提示下载。'
      )
      .example('nh.search touhou  # 搜索包含 "touhou" 的作品')
      .example('nh.search 177013  # 获取 ID 为 177013 的作品信息')
      .example('nh.search touhou -s popular  # 按热门度搜索 "touhou"')
      .example('nh.search "fate grand order" -l chinese -s popular-week  # 搜索 FGO 的中文作品，并按本周热门排序')
      .action(async ({ session, options }, query) => {
        if (!query) return session.send('请输入搜索关键词或漫画ID。');
        
        const validSorts = ['popular', 'popular-today', 'popular-week'];
        const validLangs = ['chinese', 'japanese', 'english', 'all'];

        if (options.sort && !validSorts.includes(options.sort)) {
          return session.send(`无效的排序选项。可用值: ${validSorts.join(', ')}`);
        }
        if (options.lang && !validLangs.includes(options.lang)) {
          return session.send(`无效的语言选项。可用值: ${validLangs.join(', ')}`);
        }
        
        const searchOptions: SearchOptions = {
          sort: options.sort as SearchOptions['sort'],
          lang: options.lang as SearchOptions['lang'],
        };
        
        const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在搜索 ${query}...`);
        try {
          if (/^\d+$/.test(query)) {
            await this._handleIdSearch(session, query);
          } else {
            await this._handleKeywordSearch(session, query, searchOptions);
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
      .option('pdf', '-p 以 PDF 文件形式发送')
      .option('zip', '-z 以 ZIP 压缩包形式发送')
      .option('image', '-i 以逐张图片形式发送')
      .option('key', '-k <password:string> 为生成的压缩包或PDF设置密码')
      .usage(
        '根据漫画 ID 或 nhentai 官网链接下载作品。\n' +
        '可以通过选项指定输出格式 (PDF/ZIP/图片) 和密码。\n' +
        '若未指定格式，将使用配置中的默认输出格式。'
      )
      .example('nh.download 123456 -z  # 将 ID 为 123456 的漫画打包为 ZIP 文件')
      .example('nh.download https://nhentai.net/g/123456/ -p -k mypassword  # 下载链接对应的漫画为 PDF，并设置密码')
      .example('nh.download 123456 -i  # 逐张发送 ID 为 123456 的漫画图片')
      .action(async ({ session, options }, idOrUrl) => {
        if (!idOrUrl) return session.send('请输入要下载的漫画ID或链接。');
        const match = idOrUrl.match(galleryUrlRegex) || idOrUrl.match(/^\d+$/);
        if (!match) return session.send('输入的ID或链接无效，请检查后重试。');
        const id = match[1] || match[0];
        const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在解析画廊 ${id}...`);
        try {
          await this._handleDownloadCommand(session, id, options, statusMessageId);
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
      .example('nh.random  # 进行一次随机推荐')
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
      .usage('获取 nhentai 当前的热门漫画列表。此指令为 `nh.search \"\" -s popular` 的快捷方式。')
      .example('nh.popular  # 查看热门漫画列表')
      .action(async ({ session }) => {
        return session.execute('nh.search -s popular ""');
      });
  }

  private _formatGalleryInfo(gallery: Partial<Gallery>, displayIndex?: number): h {
    const infoLines: string[] = [];
    const TAG_LIMIT = 8;
    
    let title = '📘 ';
    if (typeof displayIndex === 'number') title += `【${displayIndex + 1}】 `;
    title += gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'N/A';
    infoLines.push(title);

    infoLines.push(`🆔 ID: ${gallery.id || 'N/A'}`);
    infoLines.push(`📄 页数: ${gallery.num_pages || 'N/A'}`);
    infoLines.push(`⭐ 收藏: ${gallery.num_favorites || 'N/A'}`);
    if (gallery.upload_date) {
      infoLines.push(`📅 上传于: ${new Date(gallery.upload_date * 1000).toLocaleDateString('zh-CN')}`);
    }

    const tagsByType = (gallery.tags || []).reduce((acc, tag) => {
      if (!acc[tag.type]) acc[tag.type] = [];
      acc[tag.type].push(tag.name);
      return acc;
    }, {} as Record<Tag['type'], string[]>);

    for (const type in tagTypeDisplayMap) {
      const key = type as Tag['type'];
      if (tagsByType[key] && this.config.showTagsInSearch) {
        let names = tagsByType[key];
        
        if (key === 'language') {
          names = names.map(name => name.replace(/\b\w/g, l => l.toUpperCase()));
        }
        
        if (key === 'tag' && names.length > TAG_LIMIT) {
          names = [...names.slice(0, TAG_LIMIT), '...'];
        }
        
        infoLines.push(`${tagTypeDisplayMap[key]}: ${names.join(', ')}`);
      }
    }
    
    if (this.config.showLinkInSearch && gallery.id) {
      infoLines.push(`🔗 链接: https://nhentai.net/g/${gallery.id}/`);
    }

    return h('p', infoLines.join('\n'));
  }

  private async _handleIdSearch(session: Session, id: string) {
    const result = await this.nhentaiService.getGalleryWithCover(id);
    if (!result) {
      await session.send(`获取画廊 ${id} 信息失败，请检查ID或链接是否正确。`);
      return;
    }
    
    const { gallery, cover } = result;
    const galleryNode = this._formatGalleryInfo(gallery);
    const message = h('message', galleryNode);
    if (cover) {
      message.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)));
    }

    if (this.config.useForwardForSearch && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform)) {
      await session.send(h('figure', {}, message));
    } else {
      await session.send(message);
    }

    await session.send(`是否下载 ID ${id} 的漫画? [Y/N]`);
    const reply = await session.prompt(this.config.promptTimeout);
    if (!reply) {
      await session.send('操作超时，已自动取消。');
    } else if (reply.toLowerCase() === 'y') {
      await session.execute(`nh download ${id}`);
    } else {
      await session.send('操作已取消。');
    }
  }

  // [REFACTOR] New helper to build a prioritized list of search queries
  private _buildSearchQueryQueue(query: string, lang: SearchOptions['lang']): { query: string, message: string }[] {
    const baseQuery = query.trim();
    
    const buildQuery = (langFilter: string) => {
      // Avoid adding duplicate filters if user already specified them
      if (baseQuery.includes('language:') || baseQuery.includes('汉化')) {
        return baseQuery;
      }
      return `${baseQuery} ${langFilter}`.trim();
    }
    
    if (lang === 'chinese') {
      return [
        { query: buildQuery('language:chinese'), message: `正在尝试使用 \`language:chinese\`...` },
        { query: buildQuery('-language:english -language:japanese'), message: `正在尝试排除其他语言...` },
        { query: buildQuery('汉化'), message: `正在尝试使用关键词 \`汉化\`...` },
        { query: baseQuery, message: `正在尝试搜索所有语言...` }
      ];
    }
    
    let effectiveQuery = baseQuery;
    if (lang && lang !== 'all' && !baseQuery.includes('language:')) {
      effectiveQuery = `${baseQuery} language:${lang}`.trim();
    }
    
    return [{ query: effectiveQuery, message: '' }];
  }

  private async _handleKeywordSearch(session: Session, query: string, options: SearchOptions) {
    const limit = this.config.searchResultLimit > 0 ? this.config.searchResultLimit : 10;
    const sort = options.sort;
    const lang = options.lang || this.config.defaultSearchLanguage;
    
    const queryQueue = this._buildSearchQueryQueue(query, lang);
    let effectiveQuery = '';
    let initialResult: SearchResult | null = null;
    
    // [REFACTOR] Iterate through the query queue to find results
    for (const { query: currentQuery, message } of queryQueue) {
      effectiveQuery = currentQuery;
      if (message) {
        await session.send(message);
      }
      const result = await this.apiService.searchGalleries(effectiveQuery, 1, sort);
      if (result && result.result.length > 0) {
        initialResult = result;
        break; // Found results, break the loop
      }
    }
    
    if (!initialResult) {
      await session.send(`未找到与“${query}”相关的漫画。`);
      return;
    }
    
    let allResults: Partial<Gallery>[] = initialResult.result;
    let totalApiPages = initialResult.num_pages;
    let totalResultsCount = initialResult.num_pages * initialResult.per_page;
    let fetchedApiPage = 1;
    let currentDisplayPage = 1;

    const fetchApiPage = async (apiPageNum: number) => {
      const result = await this.apiService.searchGalleries(effectiveQuery, apiPageNum, sort);
      if (!result || result.result.length === 0) return false;
      
      allResults.push(...result.result);
      // API might return slightly different total pages on subsequent requests, update if needed
      if (result.num_pages > totalApiPages) totalApiPages = result.num_pages;
      fetchedApiPage = apiPageNum;
      return true;
    }

    let displayedResults: Partial<Gallery>[] = [];

    while (true) {
      const startIndex = (currentDisplayPage - 1) * limit;
      const endIndex = startIndex + limit;

      while (endIndex > allResults.length && fetchedApiPage < totalApiPages) {
        await session.send(h('quote', {id: session.messageId}) + `正在加载更多结果 (第 ${fetchedApiPage + 1} / ${totalApiPages} API页)...`);
        await fetchApiPage(fetchedApiPage + 1);
      }

      displayedResults = allResults.slice(startIndex, endIndex);

      if (displayedResults.length === 0 && currentDisplayPage > 1) {
        await session.send('没有更多结果了。');
        currentDisplayPage--;
        continue;
      }
      
      if (displayedResults.length === 0 && currentDisplayPage === 1) {
        // This should not happen if initialResult was successful, but as a safeguard.
        await session.send(`未找到与“${query}”相关的漫画。`);
        return;
      }

      const covers = await this.nhentaiService.getCoversForGalleries(displayedResults);
      
      const messageNodes: h[] = [];
      for (const [index, gallery] of displayedResults.entries()) {
        const galleryInfoNode = this._formatGalleryInfo(gallery, index);
        const cover = covers.get(gallery.id as string);
        const messageNode = h('message', galleryInfoNode);
        if (cover) {
          messageNode.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)));
        }
        messageNodes.push(messageNode);
      }
      
      // Recalculate total display pages based on actual results count if it's more accurate
      const dynamicTotalResults = allResults.length < totalResultsCount ? allResults.length : totalResultsCount;
      const totalDisplayPages = Math.ceil(dynamicTotalResults / limit);
      const headerText = `共约 ${totalResultsCount} 个结果, 当前显示第 ${startIndex + 1}-${startIndex + displayedResults.length} 条 (第 ${currentDisplayPage} / ${totalDisplayPages} 页)`;
      const header = h('message', h('p', headerText));
      
      if (this.config.useForwardForSearch && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform)) {
        await session.send(h('figure', {}, [header, ...messageNodes]));
      } else {
        await session.send([header, ...messageNodes.flatMap(m => m.children)]);
      }

      const prompts = ["回复序号下载"];
      if (currentDisplayPage > 1) prompts.push("[B]上一页");
      if (currentDisplayPage < totalDisplayPages && endIndex < dynamicTotalResults) prompts.push("[F]下一页");
      prompts.push("[N]退出");
      await session.send(prompts.join("，") + "。");

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
        if (currentDisplayPage < totalDisplayPages && endIndex < dynamicTotalResults) {
          currentDisplayPage++;
        } else {
          await session.send('已经是最后一页了。');
        }
      } else if (lowerReply === 'b') {
        if (currentDisplayPage > 1) {
          currentDisplayPage--;
        } else {
          await session.send('已经是第一页了。');
        }
      } else if (/^\d+$/.test(reply)) {
        const selectedIndex = parseInt(reply, 10) - 1;
        if (selectedIndex >= 0 && selectedIndex < displayedResults.length) {
          const gallery = displayedResults[selectedIndex];
          if (gallery?.id) {
            return session.execute(`nh download ${gallery.id}`);
          }
        }
        await session.send("无效的选择，请输入列表中的序号。");
      } else {
        await session.send("无效的输入，请重新操作。");
      }
    }
  }

  private async _handleRandomCommand(session: Session) {
    const randomId = await this.nhentaiService.getRandomGalleryId();
    if (randomId) {
      await this._handleIdSearch(session, randomId);
    } else {
      throw new Error('获取随机画廊ID失败。');
    }
  }

  private async _handleDownloadCommand(session: Session, id: string, options: DownloadOptions, statusMessageId: string) {
    let tempPdfPath: string | undefined;

    try {
      let outputType: 'zip' | 'pdf' | 'img' = this.config.defaultOutput;
      if (options.pdf) outputType = 'pdf';
      else if (options.zip) outputType = 'zip';
      else if (options.image) outputType = 'img';
      const password = options.key || this.config.defaultPassword;

      const updateStatus = async (text: string) => {
        if (typeof session.bot.editMessage === 'function') {
          try { await session.bot.editMessage(session.channelId, statusMessageId, text); }
          catch (error) { if (this.config.debug) logger.warn('[下载] 编辑状态消息失败 (忽略): %o', error); }
        }
      };

      const result = await this.nhentaiService.downloadGallery(id, outputType, password, updateStatus);

      if ('error' in result) {
        await session.send(result.error);
        return;
      }

      let successMessage = `任务完成: ${result.filename.split('.').slice(0,-1).join('.')}`;
      if (['zip', 'pdf'].includes(result.type) && password) {
        successMessage += `，密码为: ${password}`;
      }

      switch (result.type) {
        case 'pdf':
          tempPdfPath = result.path;
          if (this.config.pdfSendMethod === 'buffer') {
            const pdfBuffer = await readFile(tempPdfPath);
            await session.send(h.file(pdfBuffer, 'application/pdf', { title: result.filename }));
          } else {
            await session.send(h.file(pathToFileURL(tempPdfPath).href, { title: result.filename }));
          }
          break;

        case 'zip':
          await session.send(h.file(result.buffer, 'application/zip', { title: result.filename }));
          break;

        case 'images':
          const useForward = this.config.useForwardForDownload && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform);
          const imageElements = result.images; // Anti-gzip is already applied

          if (useForward) {
            await session.send(h('figure', {}, imageElements.map(item => h.image(bufferToDataURI(item.buffer, `image/${item.extension}`)))));
          } else {
            for (const { index, buffer, extension } of imageElements) {
              await session.send(`正在发送图片: ${index + 1} / ${result.images.length + result.failedIndexes.length}` + h.image(bufferToDataURI(buffer, `image/${extension}`)));
              await sleep(this.config.imageSendDelay);
            }
          }
          
          if (result.failedIndexes.length > 0) {
            const failedPages = result.failedIndexes.map(i => i + 1).join(', ');
            await session.send(`有 ${result.failedIndexes.length} 张图片下载失败，页码为: ${failedPages}。`);
          }
          break;
      }
      await session.send(successMessage);
    } finally {
      if (tempPdfPath) try { await rm(tempPdfPath, { force: true }); } catch(e) {}
    }
  }
}

export function apply(ctx: Context, config: Config) {
  new NhentaiPlugin(ctx, config).start();
}