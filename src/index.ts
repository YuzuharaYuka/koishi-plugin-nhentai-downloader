import { Context } from 'koishi'
import { Config } from './config'
import { logger } from './utils'
import { NhentaiPlugin } from './plugin'
import { registerAllCommands } from './commands'
import { createLinkRecognitionMiddleware } from './middleware'

export * from './config'
export const name = 'nhentai-downloader'
export const inject = []

let previousConfig: Config | null = null

export const usage = `
## 使用说明

本插件提供 **[nhentai](https://nhentai.net/)** 漫画搜索与下载。

**注意：本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。**

### 快速开始

- 所有指令均以 \`nh\` 前缀调用：\`nh.指令\`（推荐）/ \`nh指令\` / \`nh command\`
- 查看帮助：\`help nh.search\`

### 常用指令

#### 搜索：\`nh.search\`（别名：\`nh搜索\`、\`nhsearch\`）

语法：
\`\`\`
nh.search <关键词/ID> [选项]
\`\`\`

选项：
- \`-s, --sort <type>\`：\`popular\` / \`popular-today\` / \`popular-week\`
- \`-l, --lang <lang>\`：\`chinese\` / \`japanese\` / \`english\` / \`all\`

示例：
- \`nh搜索 touhou\`
- \`nh search 608023\`
- \`nh搜索 touhou -s popular -l chinese\`

交互（菜单/文本两种模式都支持）：
- 回复序号：下载对应漫画；\`F\` 下一页；\`B\` 上一页；\`N\` 退出

#### 下载：\`nh.download\`（别名：\`nh下载\`、\`nhdownload\`）

语法：
\`\`\`
nh.download <ID/链接> [选项]
\`\`\`

选项：
- \`-p, --pdf\`：输出 PDF
- \`-z, --zip\`：输出 ZIP
- \`-i, --image\`：逐张发送图片
- \`-k, --key <密码>\`：设置文件密码

示例：
- \`nh下载 608023 -z -k 1234\`
- \`nh download https://nhentai.net/g/608023/ --pdf\`

#### 其他

- \`nh.popular\` / \`nh热门\`：热门漫画
- \`nh.random\` / \`nh随机\`：随机推荐

### 使用提示

- 直接发送 nhentai 链接可自动触发下载（可在配置中关闭）

### 注意事项

1. 需要可访问 nhentai.net 的网络环境（必要时配置代理）
2. 插件包含 NSFW 内容，请在合适场景使用
3. 仅供学习交流，请尊重版权
`

export function apply(ctx: Context, config: Config) {
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
        await checkAndClearCaches(ctx, config, previousConfig)
        await plugin.initialize()
        previousConfig = { ...config }
        logger.info('插件初始化完成')
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error('插件初始化失败，插件将无法使用')
        logger.error('错误详情:', errorMessage)

        if (errorMessage.includes('got-scraping')) {
          logger.error('网络请求模块加载失败,请检查网络连接或重新安装插件')
        } else if (errorMessage.includes('@napi-rs/canvas')) {
          logger.error('图片处理模块加载失败,请尝试重新安装插件')
        } else {
          logger.error('请检查日志并报告问题到: https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader/issues')
        }

        // 不抛出错误，避免导致 Koishi 崩溃
      }
    })

    ctx.on('dispose', () => {
      plugin.dispose()
      if (config.debug) logger.info('插件资源已释放')
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
      if (entry.isFile() && entry.name.startsWith('temp_') && entry.name.endsWith('.pdf')) {
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

    if (cleanedCount > 0) {
      logger.info(`已清理 ${cleanedCount} 个临时文件/目录`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (config.debug) logger.warn(`清理临时文件时出错: ${errorMessage}`)
  }
}
