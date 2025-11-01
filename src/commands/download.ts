// src/commands/download.ts
import { Command, Session } from 'koishi'
import { Context } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { NhentaiService } from '../services/nhentai'
import { handleDownloadCommand, DownloadOptions } from '../handlers/download-handler'
import { galleryUrlRegex } from '../constants'
import { h } from 'koishi'

/**
 * 注册下载相关指令
 */
export function registerDownloadCommands(
  ctx: Context,
  config: Config,
  nhentaiService: NhentaiService,
  ensureInitialized: (session: Session) => boolean,
  nhCmd: Command
): void {
  // 移除可能存在的旧 download 子命令（热重载时）
  const existingDownload = nhCmd.children.find(c => c.name === 'download')
  if (existingDownload) {
    existingDownload.dispose()
  }

  nhCmd
    .subcommand('.download <idOrUrl>', '下载指定ID或链接的漫画')
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
      if (!ensureInitialized(session)) return
      if (!idOrUrl) return session.send('请输入要下载的漫画ID或链接。')

      const match = idOrUrl.match(galleryUrlRegex) || idOrUrl.match(/^\d+$/)
      if (!match) return session.send('输入的ID或链接无效，请检查后重试。')

      const id = match[1] || match[0]
      const [statusMessageId] = await session.send(h('quote', { id: session.messageId }) + `正在解析画廊 ${id}...`)

      try {
        await handleDownloadCommand(session, id, options as DownloadOptions, statusMessageId, nhentaiService, config)
      } catch (error) {
        logger.error(`[下载] 任务 ID ${id} 失败: %o`, error)
        await session.send(h('quote', { id: session.messageId }) + `指令执行失败: ${error.message}`)
      } finally {
        try {
          await session.bot.deleteMessage(session.channelId, statusMessageId)
        } catch (e) {
          // 忽略删除失败
        }
      }
    })
}

