/**
 * 指令注册：nh.search / nh.download / nh.popular / nh.random。
 */
import { Command, Session, Context, h } from 'koishi'
import type { Config } from './config'
import { logger, getErrorMessage } from './utils'
import { ApiService } from './services/api'
import { normalizeSortOption } from './services/api'
import { NhentaiService } from './services/nhentai'
import { MenuService } from './services/menu'
import { handleIdSearch, handleKeywordSearch, handleKeywordSearchWithMenu, handleIdSearchWithMenu, handleRandomWithInteraction, SearchOptions } from './handlers'
import { handleDownloadCommand, DownloadOptions } from './handlers'
import { galleryIdRegex, LANGUAGE_DISPLAY_MAP, VALID_SORT_OPTIONS, VALID_LANG_OPTIONS } from './constants'

export function registerSearchCommands(
  ctx: Context,
  config: Config,
  getApiService: () => ApiService,
  getNhentaiService: () => NhentaiService,
  getMenuService: () => MenuService | null,
  ensureInitialized: (session: Session) => boolean,
): Command {
  const nhCmd = ctx.command('nh', 'nhentai 漫画搜索与下载').alias('nhentai')

  nhCmd
    .subcommand('.search [...query:string]', '按关键词或作品 ID 搜索')
    .alias('nh搜索', 'nhsearch', 'nh search')
    .option('sort', '-s <value:string> 排序：date / popular / popular-today / popular-week / popular-month，可简写 today / week / month')
    .option('lang', '-l <value:string> 语言筛选：chinese / japanese / english / all')
    .action(async ({ session, options }, ...queryParts) => {
      if (!session) return
      options = options || {}
      if (!ensureInitialized(session)) return

      const query = queryParts.join(' ').trim()
      if (!query && !options.sort) {
        return session.send('请输入搜索关键词或漫画ID。')
      }

      const apiService = getApiService()
      const nhentaiService = getNhentaiService()
      const menuService = getMenuService()

      // 排序取值来自官方 /search 的 sort 枚举，同时接受 today / week / month 简写
      const sort = normalizeSortOption(options.sort)
      if (options.sort && !sort) {
        return session.send(
          `无效的排序选项: ${options.sort}\n可用值: ${VALID_SORT_OPTIONS.join(', ')}（可简写 today / week / month）`,
        )
      }
      if (options.lang && !VALID_LANG_OPTIONS.includes(options.lang as any)) {
        return session.send(`无效的语言选项: ${options.lang}`)
      }

      const searchOptions: SearchOptions = {
        sort,
        lang: options.lang as SearchOptions['lang'],
      }

      const displayQuery = query || '热门漫画'
      const effectiveLang = searchOptions.lang || config.defaultSearchLanguage
      const langDisplay = LANGUAGE_DISPLAY_MAP[effectiveLang]
      const searchMessage = `正在搜索 ${displayQuery}...${langDisplay ? `（语言：${langDisplay}）` : ''}`

      await session.send(h('quote', { id: session.messageId }) + searchMessage)
      try {
        if (query && /^\d+$/.test(query)) {
          if (config.searchMode === 'menu' && menuService) {
            await handleIdSearchWithMenu(session, query, nhentaiService, menuService, config)
          } else {
            await handleIdSearch(session, query, nhentaiService, config, {
              useForward: config.textMode.useForward,
              showTags: config.textMode.showTags,
              showLink: config.textMode.showLink,
              promptDownload: true,
            })
          }
        } else {
          // 根据配置的搜索模式选择处理方式
          if (config.searchMode === 'menu' && menuService) {
            await handleKeywordSearchWithMenu(session, query, searchOptions, apiService, nhentaiService, menuService, config)
          } else {
            await handleKeywordSearch(session, query, searchOptions, apiService, nhentaiService, config, {
              useForward: config.textMode.useForward,
              showTags: config.textMode.showTags,
              showLink: config.textMode.showLink,
            })
          }
        }
      } catch (error: any) {
        logger.error(`[搜索] 命令执行失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${getErrorMessage(error)}`)
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
    .subcommand('.download <idOrUrl>', '下载作品')
    .alias('nh下载', 'nhdownload', 'nh download')
    .option('pdf', '-p 以 PDF 文件发送')
    .option('zip', '-z 以 ZIP 压缩包发送')
    .option('image', '-i 逐张发送图片')
    .option('key', '-k <password:string> 为 PDF / ZIP 设置密码')
    .action(async ({ session, options }, idOrUrl) => {
      if (!session) return
      options = options || {}
      if (!ensureInitialized(session)) return
      if (!idOrUrl) return session.send('请输入要下载的漫画ID或链接。')

      const nhentaiService = getNhentaiService()
      const match = idOrUrl.match(galleryIdRegex)
      if (!match || !match[1]) return session.send('输入的ID或链接无效，请检查后重试。')

      const id = match[1]
      await session.send(h('quote', { id: session.messageId }) + `正在解析画廊 ${id}...`)

      try {
        await handleDownloadCommand(session, id, options as DownloadOptions, nhentaiService, config, ctx.baseDir)
      } catch (error: any) {
        logger.error(`[下载] 任务 ID ${id} 失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${getErrorMessage(error)}`)
      }
    })
}

export function registerRandomCommands(
  config: Config,
  getNhentaiService: () => NhentaiService,
  getMenuService: () => MenuService | null,
  ensureInitialized: (session: Session) => boolean,
  nhCmd: Command,
): void {
  nhCmd
    .subcommand('.random', '随机推荐，Y 下载、F 换一个、N 退出')
    .alias('nh随机', 'nhrandom', 'nh random')
    .action(async ({ session }) => {
      if (!session) return
      if (!ensureInitialized(session)) return

      const nhentaiService = getNhentaiService()
      const menuService = getMenuService()
      await session.send(h('quote', { id: session.messageId }) + '正在进行一次天降好运...')

      try {
        await handleRandomWithInteraction(session, nhentaiService, menuService, config)
      } catch (error: any) {
        logger.error(`[随机] 命令执行失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${getErrorMessage(error)}`)
      }
    })

  nhCmd
    .subcommand('.popular', '今日热门，等价于 nh.search -s popular-today')
    .alias('nh热门', 'nhpopular', 'nh popular')
    .action(async ({ session }) => {
      if (!session) return
      return session.execute('nh.search -s popular-today')
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
  registerRandomCommands(config, getNhentaiService, getMenuService, ensureInitialized, nhCmd)
}
