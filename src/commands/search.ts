// src/commands/search.ts
import { Command } from 'koishi'
import { Context, Session } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { ApiService } from '../services/api'
import { NhentaiService } from '../services/nhentai'
import { handleIdSearch, handleKeywordSearch, SearchOptions } from '../handlers/search-handler'
import { galleryUrlRegex } from '../constants'
import { h } from 'koishi'

/**
 * 注册搜索相关指令
 */
export function registerSearchCommands(
  ctx: Context,
  config: Config,
  apiService: ApiService,
  nhentaiService: NhentaiService,
  ensureInitialized: (session: Session) => boolean
): Command {
  // 获取或创建主命令（热重载时可能已存在）
  let nhCmd = ctx.$commander.resolve('nh')
  if (!nhCmd) {
    nhCmd = ctx.command('nh', 'Nhentai 漫画下载与搜索工具').alias('nhentai')
  }

  // 如果 search 子命令已存在，先移除（热重载时避免重复）
  const existingSearch = nhCmd.children.find(c => c.name === 'search')
  if (existingSearch) {
    existingSearch.dispose()
  }

  nhCmd
    .subcommand('.search <query:text>', '搜索漫画或根据ID获取漫画信息')
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
      if (!ensureInitialized(session)) return
      if (!query) return session.send('请输入搜索关键词或漫画ID。')

      const validSorts = ['popular', 'popular-today', 'popular-week']
      const validLangs = ['chinese', 'japanese', 'english', 'all']

      if (options.sort && !validSorts.includes(options.sort)) {
        return session.send(`无效的排序选项。可用值: ${validSorts.join(', ')}`)
      }
      if (options.lang && !validLangs.includes(options.lang)) {
        return session.send(`无效的语言选项。可用值: ${validLangs.join(', ')}`)
      }

      const searchOptions: SearchOptions = {
        sort: options.sort as SearchOptions['sort'],
        lang: options.lang as SearchOptions['lang'],
      }

      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在搜索 ${query}...`)
      try {
        if (/^\d+$/.test(query)) {
          // ID 搜索：显示画廊信息并提示下载
          await handleIdSearch(session, query, nhentaiService, config, {
            useForward: config.useForwardForSearch,
            showTags: config.showTagsInSearch,
            showLink: config.showLinkInSearch,
          })

          // 提示是否下载
          await session.send(`是否下载 ID ${query} 的漫画? [Y/N]`)
          const reply = await session.prompt(config.promptTimeout * 1000)
          if (!reply) {
            await session.send('操作超时，已自动取消。')
          } else if (reply.toLowerCase() === 'y') {
            await session.execute(`nh download ${query}`)
          } else {
            await session.send('操作已取消。')
          }
        } else {
          // 关键词搜索：显示搜索结果列表
          await handleKeywordSearch(session, query, searchOptions, apiService, nhentaiService, config, {
            useForward: config.useForwardForSearch,
            showTags: config.showTagsInSearch,
            showLink: config.showLinkInSearch,
          })
        }
      } catch (error) {
        logger.error(`[搜索] 命令执行失败: %o`, error)
        await session.send(`指令执行失败: ${error.message}`)
      } finally {
        try {
          await session.bot.deleteMessage(session.channelId, statusMessageId)
        } catch (e) {
          // 忽略删除失败
        }
      }
    })

  return nhCmd
}

