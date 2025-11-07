import { Command, Session, Context, h } from 'koishi'
import { Config } from './config'
import { logger } from './utils'
import { ApiService } from './services/api'
import { NhentaiService } from './services/nhentai'
import { MenuService } from './services/menu'
import { handleIdSearch, handleKeywordSearch, handleKeywordSearchWithMenu, SearchOptions } from './handlers'
import { handleDownloadCommand, DownloadOptions } from './handlers'
import { galleryUrlRegex, LANGUAGE_DISPLAY_MAP, VALID_SORT_OPTIONS, VALID_LANG_OPTIONS } from './constants'

async function deleteStatusMessage(session: Session, statusMsgId: string | undefined): Promise<void> {
  if (!statusMsgId) return
  try {
    await session.bot.deleteMessage(session.channelId, statusMsgId)
  } catch (error) {
    logger.debug('删除状态消息失败:', error)
  }
}

export function registerSearchCommands(
  ctx: Context,
  config: Config,
  getApiService: () => ApiService,
  getNhentaiService: () => NhentaiService,
  getMenuService: () => MenuService | null,
  ensureInitialized: (session: Session) => boolean,
): Command {
  const nhCmd = ctx.command('nh', 'Nhentai 漫画下载与搜索工具').alias('nhentai')

  nhCmd
    .subcommand('.search [...query:string]', '搜索漫画或根据ID获取漫画信息')
    .alias('nh搜索', 'nhsearch', 'nh search')
    .option('sort', '-s <value:string> 按热门排序 (可选: popular, popular-today, popular-week)')
    .option('lang', '-l <value:string> 指定语言 (可选: chinese, japanese, english, all)')
    .usage(
      '根据关键词或漫画 ID 搜索。\n' +
        'ID 搜索会直接显示作品信息并提示下载。\n' +
        '关键词搜索会返回分页结果，支持交互式翻页和下载。',
    )
    .example('nh.search touhou  # 搜索 "touhou"')
    .example('nh.search 177013  # 获取 ID 为 177013 的作品')
    .example('nh.search touhou -s popular  # 按热门度搜索 "touhou"')
    .example('nh.search -s popular-today -l chinese touhou  # 组合使用多个选项')
    .action(async ({ session, options }, ...queryParts) => {
      if (!ensureInitialized(session)) return

      // 将数组拼接成字符串
      const query = queryParts.join(' ').trim()

      // 如果没有查询词且没有排序选项，返回错误
      if (!query && !options.sort) {
        return session.send('请输入搜索关键词或漫画ID。')
      }

      const apiService = getApiService()
      const nhentaiService = getNhentaiService()
      const menuService = getMenuService()

      if (options.sort && !VALID_SORT_OPTIONS.includes(options.sort)) {
        return session.send(`无效的排序选项。可用值: ${VALID_SORT_OPTIONS.join(', ')}`)
      }
      if (options.lang && !VALID_LANG_OPTIONS.includes(options.lang)) {
        return session.send(`无效的语言选项。可用值: ${VALID_LANG_OPTIONS.join(', ')}`)
      }

      // 提示: nhentai API 对 popular-today 和 popular-week 的支持可能不稳定
      if (options.sort && options.sort !== 'popular' && config.debug) {
        logger.warn(`使用 sort 参数: ${options.sort}, 注意 nhentai API 可能不完全支持此参数`)
      }

      const searchOptions: SearchOptions = {
        sort: options.sort as SearchOptions['sort'],
        lang: options.lang as SearchOptions['lang'],
      }

      const effectiveLang = searchOptions.lang || config.defaultSearchLanguage
      const langDisplay = LANGUAGE_DISPLAY_MAP[effectiveLang]
      const displayQuery = query || '热门漫画'
      const searchMessage = langDisplay
        ? `正在搜索 ${displayQuery}...（语言：${langDisplay}）`
        : `正在搜索 ${displayQuery}...`

      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + searchMessage)
      try {
        if (query && /^\d+$/.test(query)) {
          await handleIdSearch(session, query, nhentaiService, config, {
            useForward: config.useForwardForSearch,
            showTags: config.showTagsInSearch,
            showLink: config.showLinkInSearch,
            promptDownload: true,
          })
        } else {
          // 根据配置选择使用图片菜单还是传统模式
          if (config.enableImageMenu && menuService) {
            await handleKeywordSearchWithMenu(session, query, searchOptions, apiService, nhentaiService, menuService, config)
          } else {
            await handleKeywordSearch(session, query, searchOptions, apiService, nhentaiService, config, {
              useForward: config.useForwardForSearch,
              showTags: config.showTagsInSearch,
              showLink: config.showLinkInSearch,
            })
          }
        }
      } catch (error) {
        logger.error(`[搜索] 命令执行失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${error.message}`)
      } finally {
        await deleteStatusMessage(session, statusMessageId)
      }
    })

  return nhCmd
}

export function registerDownloadCommands(
  ctx: Context,
  config: Config,
  getNhentaiService: () => NhentaiService,
  ensureInitialized: (session: Session) => boolean,
  nhCmd: Command,
): void {
  nhCmd
    .subcommand('.download <idOrUrl>', '下载指定ID或链接的漫画')
    .alias('nh下载', 'nhdownload', 'nh download')
    .option('pdf', '-p 以 PDF 文件形式发送')
    .option('zip', '-z 以 ZIP 压缩包形式发送')
    .option('image', '-i 以逐张图片形式发送')
    .option('key', '-k <password:string> 为生成的压缩包或PDF设置密码')
    .usage(
      '根据漫画 ID 或 nhentai 官网链接下载作品。\n' +
        '可以通过选项指定输出格式 (PDF/ZIP/图片) 和密码。\n' +
        '若未指定格式，将使用配置中的默认输出格式。',
    )
    .example('nh.download 123456 -z  # 将 ID 为 123456 的漫画打包为 ZIP 文件')
    .example('nh download https://nhentai.net/g/123456/ -p -k mypassword  # 下载链接对应的漫画为 PDF，并设置密码')
    .example('nh下载 123456 -i  # 逐张发送 ID 为 123456 的漫画图片')
    .action(async ({ session, options }, idOrUrl) => {
      if (!ensureInitialized(session)) return
      if (!idOrUrl) return session.send('请输入要下载的漫画ID或链接。')

      const nhentaiService = getNhentaiService()

      const match = idOrUrl.match(galleryUrlRegex)
      if (!match || !match[1]) return session.send('输入的ID或链接无效，请检查后重试。')

      const id = match[1]
      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在解析画廊 ${id}...`)

      try {
        await handleDownloadCommand(session, id, options as DownloadOptions, statusMessageId, nhentaiService, config)
      } catch (error) {
        logger.error(`[下载] 任务 ID ${id} 失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${error.message}`)
      } finally {
        await deleteStatusMessage(session, statusMessageId)
      }
    })
}

export function registerRandomCommands(
  ctx: Context,
  config: Config,
  getNhentaiService: () => NhentaiService,
  ensureInitialized: (session: Session) => boolean,
  nhCmd: Command,
): void {
  nhCmd
    .subcommand('.random', '随机推荐一本漫画')
    .alias('nh随机', 'nhrandom', 'nh random')
    .usage('随机获取一本 nhentai 漫画的详细信息，并提示是否下载。')
    .example('nh.random')
    .action(async ({ session }) => {
      if (!ensureInitialized(session)) return

      const nhentaiService = getNhentaiService()
      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + '正在进行一次天降好运...')

      try {
        const randomId = await nhentaiService.getRandomGalleryId()
        if (!randomId) {
          throw new Error('获取随机画廊ID失败。')
        }

        await handleIdSearch(session, randomId, nhentaiService, config, {
          useForward: config.useForwardForSearch,
          showTags: config.showTagsInSearch,
          showLink: config.showLinkInSearch,
          promptDownload: true,
        })
      } catch (error) {
        logger.error(`[随机] 命令执行失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${error.message}`)
      } finally {
        await deleteStatusMessage(session, statusMessageId)
      }
    })

  nhCmd
    .subcommand('.popular', '查看当前的热门漫画')
    .alias('nh热门', 'nhpopular', 'nh popular')
    .usage('获取 nhentai 当前的热门漫画列表。此指令为 `nh.search -s popular` 的快捷方式。')
    .example('nh.popular')
    .action(async ({ session }) => {
      return session.execute('nh.search -s popular')
    })
}

export function registerAllCommands(
  ctx: Context,
  config: Config,
  getApiService: () => ApiService,
  getNhentaiService: () => NhentaiService,
  getMenuService: () => MenuService | null,
  ensureInitialized: (session: Session) => boolean,
): void {
  const nhCmd = registerSearchCommands(ctx, config, getApiService, getNhentaiService, getMenuService, ensureInitialized)
  registerDownloadCommands(ctx, config, getNhentaiService, ensureInitialized, nhCmd)
  registerRandomCommands(ctx, config, getNhentaiService, ensureInitialized, nhCmd)
}
