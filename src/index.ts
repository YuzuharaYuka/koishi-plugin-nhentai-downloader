import { Context } from 'koishi'
import { PLUGIN_NAME } from './constants'
import { type Config, normalizeConfig } from './config'
import { logger } from './utils'
import { NhentaiPlugin } from './plugin'
import { registerAllCommands } from './commands'
import { createLinkRecognitionMiddleware } from './middleware'

export * from './config'
export const name = PLUGIN_NAME

// 网络请求统一走 Koishi 的 ctx.http，代理交给 proxy-agent 插件
export const inject = {
  required: ['http'],
  optional: [],
}

export const usage = `
[nhentai](https://nhentai.net/) 漫画搜索与下载。指令前缀 \`nh\`（\`nh.指令\` / \`nh指令\` / \`nh command\` 均可）。

**内容涉及成人向漫画，请在合适的范围内使用。**

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| \`nh.search <关键词/ID>\` | \`nh搜索\` | 按关键词或作品 ID 搜索，\`-s\` 排序、\`-l\` 筛选语言 |
| \`nh.download <ID/链接>\` | \`nh下载\` | 下载作品，\`-p\` PDF、\`-z\` ZIP、\`-i\` 逐张图片、\`-k\` 密码 |
| \`nh.popular\` | \`nh热门\` | 今日热门，等价于 \`nh.search -s popular-today\` |
| \`nh.random\` | \`nh随机\` | 随机推荐，\`Y\` 下载、\`F\` 换一个、\`N\` 退出 |

搜索关键词支持官方过滤语法，如 \`artist:name\`、\`language:chinese\`、\`pages:>50\`、\`favorites:>=1000\`、\`uploaded:<7d\`、\`-tag:netorare\`。

搜索结果回复序号即可下载，\`F\` 下一页、\`B\` 上一页、\`N\` 退出。

配置 \`apiKey\` 可提高接口配额并启用黑名单过滤；无法访问 nhentai 时请配置 proxy-agent 代理。
`

export function apply(ctx: Context, rawConfig: Config) {
  const config = normalizeConfig(rawConfig)

  ctx.plugin((ctx) => {
    const plugin = new NhentaiPlugin(ctx, config)

    registerAllCommands(
      ctx,
      config,
      () => plugin.getApiService(),
      () => plugin.getNhentaiService(),
      () => plugin.getMenuService(),
      (session) => plugin.ensureInitialized(session)
    )

    ctx.middleware(createLinkRecognitionMiddleware(config))

    ctx.on('ready', async () => {
      try {
        await checkAndClearCaches(ctx, config, plugin.getPreviousConfig())
        await plugin.initialize()
        plugin.setPreviousConfig({ ...config })
        logger.info('插件初始化完成')
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error('插件初始化失败，插件将无法使用')
        logger.error('错误详情:', errorMessage)

        if (errorMessage.includes('@napi-rs/canvas')) {
          logger.error('图片处理模块加载失败，请尝试重新安装插件')
        } else if (/Cannot find module '(yauzl|pdfkit|archiver)/.test(errorMessage)) {
          logger.error('依赖模块加载失败，请尝试重新安装插件')
        } else {
          logger.error('请检查日志并报告问题到: https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader/issues')
        }

        // 不抛出错误，避免导致 Koishi 崩溃
      }
    })

    ctx.on('dispose', () => {
      plugin.dispose()
      logger.debug('插件资源已释放')
    })
  })
}

async function clearCacheDirectory(cacheType: string, cachePath: string): Promise<void> {
  logger.info(`检测到${cacheType}缓存已关闭，正在清理磁盘缓存...`)
  try {
    const { promises: fs } = await import('fs')
    const { access } = await import('fs/promises')

    // 先检查目录是否存在
    try {
      await access(cachePath)
    } catch {
      // 目录不存在，无需清理
      if (logger.level <= 1) logger.debug(`${cacheType}缓存目录不存在，跳过清理: ${cachePath}`)
      return
    }

    await fs.rm(cachePath, { recursive: true, force: true })
    logger.info(`${cacheType}缓存目录已清理: ${cachePath}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.warn(`清理${cacheType}缓存目录失败: ${errorMessage}`)
  }
}

async function checkAndClearCaches(ctx: Context, currentConfig: Config, previousConfig: Config | null): Promise<void> {
  const imageCacheDisabled = previousConfig
    ? (previousConfig.cache.enableImageCache && !currentConfig.cache.enableImageCache)
    : !currentConfig.cache.enableImageCache

  const pdfCacheDisabled = previousConfig
    ? ((previousConfig.cache.enablePdfCache ?? false) && !currentConfig.cache.enablePdfCache)
    : false

  if (imageCacheDisabled || pdfCacheDisabled) {
    const path = await import('path')
    const baseDir = ctx.baseDir

    if (imageCacheDisabled) {
      const cacheDir = path.resolve(baseDir, currentConfig.downloadPath, 'image-cache')
      await clearCacheDirectory('图片', cacheDir)
    }

    if (pdfCacheDisabled) {
      const cacheDir = path.resolve(baseDir, currentConfig.downloadPath, 'pdf-cache')
      await clearCacheDirectory('PDF', cacheDir)
    }
  }

  await cleanTempFiles(ctx, currentConfig)
}

async function cleanTempFiles(ctx: Context, config: Config): Promise<void> {
  try {
    const { promises: fs } = await import('fs')
    const { access } = await import('fs/promises')
    const path = await import('path')
    const baseDir = ctx.baseDir
    const downloadDir = path.resolve(baseDir, config.downloadPath)

    // 检查下载目录是否存在
    try {
      await access(downloadDir)
    } catch {
      if (config.debug) logger.info(`下载目录不存在，跳过清理: ${downloadDir}`)
      return
    }

    const entries = await fs.readdir(downloadDir, { withFileTypes: true })
    let cleanedCount = 0

    for (const entry of entries) {
      const isTempFile =
        entry.isFile() &&
        entry.name.startsWith('temp_') &&
        (entry.name.endsWith('.pdf') || entry.name.endsWith('.zip'))
      if (isTempFile) {
        try {
          await fs.unlink(path.join(downloadDir, entry.name))
          cleanedCount++
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          if (config.debug) logger.warn(`删除临时文件失败 ${entry.name}: ${errorMessage}`)
        }
      } else if (entry.isDirectory() && entry.name.startsWith('temp_pdf_')) {
        try {
          await fs.rm(path.join(downloadDir, entry.name), { recursive: true, force: true })
          cleanedCount++
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err)
          if (config.debug) logger.warn(`删除临时目录失败 ${entry.name}: ${errorMessage}`)
        }
      }
    }

    // 官方压缩包只在下载过程中存在；异常退出可能残留，一并清掉
    const archiveDir = path.join(downloadDir, 'official-archive')
    try {
      const stale = await fs.readdir(archiveDir)
      if (stale.length > 0) {
        await fs.rm(archiveDir, { recursive: true, force: true })
        cleanedCount += stale.length
      }
    } catch {
      // 目录不存在属正常情况
    }

    if (cleanedCount > 0) {
      logger.info(`已清理 ${cleanedCount} 个临时文件/目录`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (config.debug) logger.warn(`清理临时文件时出错: ${errorMessage}`)
  }
}
