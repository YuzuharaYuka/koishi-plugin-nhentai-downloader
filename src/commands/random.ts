// src/commands/random.ts
import { Command, Session } from 'koishi'
import { Context } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { NhentaiService } from '../services/nhentai'
import { handleIdSearch } from '../handlers/search-handler'
import { h } from 'koishi'

/**
 * 注册随机和热门相关指令
 */
export function registerRandomCommands(
  ctx: Context,
  config: Config,
  nhentaiService: NhentaiService,
  ensureInitialized: (session: Session) => boolean,
  nhCmd: Command
): void {
  // 移除可能存在的旧 random 和 popular 子命令（热重载时）
  const existingRandom = nhCmd.children.find(c => c.name === 'random')
  const existingPopular = nhCmd.children.find(c => c.name === 'popular')
  if (existingRandom) {
    existingRandom.dispose()
  }
  if (existingPopular) {
    existingPopular.dispose()
  }

  nhCmd
    .subcommand('.random', '随机推荐一本漫画')
    .alias('随机', 'random', 'nh随机', '天降好运')
    .usage('随机获取一本 nhentai 漫画的详细信息，并提示是否下载。')
    .example('nh.random  # 进行一次随机推荐')
    .action(async ({ session }) => {
      if (!ensureInitialized(session)) return

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
        })

        // 提示是否下载
        await session.send(`是否下载 ID ${randomId} 的漫画? [Y/N]`)
        const reply = await session.prompt(config.promptTimeout * 1000)
        if (!reply) {
          await session.send('操作超时，已自动取消。')
        } else if (reply.toLowerCase() === 'y') {
          await session.execute(`nh download ${randomId}`)
        } else {
          await session.send('操作已取消。')
        }
      } catch (error) {
        logger.error(`[随机] 命令执行失败: %o`, error)
        await session.send(`指令执行失败: ${error.message}`)
      } finally {
        try {
          await session.bot.deleteMessage(session.channelId, statusMessageId)
        } catch (e) {
          // 忽略删除失败
        }
      }
    })

  nhCmd
    .subcommand('.popular', '查看当前的热门漫画')
    .alias('热门', 'popular', 'nh热门')
    .usage('获取 nhentai 当前的热门漫画列表。此指令为 `nh.search "" -s popular` 的快捷方式。')
    .example('nh.popular  # 查看热门漫画列表')
    .action(async ({ session }) => {
      return session.execute('nh.search -s popular ""')
    })
}

