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

本插件提供 **[nhentai](https://nhentai.net/)** 漫画的搜索与下载功能。

**注意：本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。**

### 快速开始

所有指令均需 \`nh\` 前缀，支持以下调用方式：

- \`nh.指令\` - 标准用法（推荐）
- \`nh指令\` - 中文无空格
- \`nh command\` - 英文带空格

---

### 指令列表

#### 1. 搜索漫画 - \`nh.search\`

**别名**: \`nh搜索\`, \`nhsearch\`

**用法**:
\`\`\`
nh.search <关键词/ID> [选项]
\`\`\`

**选项**:

- \`-s, --sort <type>\` - 按热门度排序（\`popular\`, \`popular-today\`, \`popular-week\`）
- \`-l, --lang <lang>\` - 筛选语言（\`chinese\`, \`japanese\`, \`english\`, \`all\`）

**示例**:

- \`nh搜索 touhou\` - 按关键词搜索作品
- \`nh search 608023\` - 查看指定 ID 作品
- \`nh搜索 touhou -s popular -l chinese\` - 筛选中文语言热门作品

**交互提示**:

- 回复序号 - 下载对应漫画
- 回复 F - 翻至下一页
- 回复 B - 返回上一页
- 回复 N - 退出交互

---

#### 2. 下载漫画 - \`nh.download\`

**别名**: \`nh下载\`, \`nhdownload\`

**用法**:
\`\`\`
nh.download <ID/链接> [选项]
\`\`\`

**选项**:

- \`-p, --pdf\` - 输出 PDF 文件
- \`-z, --zip\` - 输出 ZIP 压缩包
- \`-i, --image\` - 逐张发送图片
- \`-k, --key <密码>\` - 设置文件密码（ZIP 使用 AES-256 加密）

**示例**:

- \`nh下载 608023 -z -k 1234\` - 下载加密 ZIP
- \`nh download https://nhentai.net/g/608023/ --pdf\` - 下载 PDF

---

#### 3. 其他指令

- \`nh.popular\` / \`nh热门\` - 查看热门漫画
- \`nh.random\` / \`nh随机\` - 随机推荐

---

### 使用提示

- 直接发送 nhentai 链接可自动触发下载（可在配置中关闭）
- 使用 \`help nh.search\` 查看指令详细说明

### 注意事项

1. 本插件需要能访问 nhentai.net，若网络受限请配置代理
2. 内容涉及成人向漫画（NSFW），请在合适场景使用
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
      (session) => plugin.ensureInitialized(session)
    )

    ctx.middleware(createLinkRecognitionMiddleware(config))

    ctx.on('ready', async () => {
      try {
        await checkAndClearCaches(config, previousConfig)
        await plugin.initialize()
        previousConfig = { ...config }
        if (config.debug) logger.info('插件初始化完成')
      } catch (error) {
        logger.error('插件初始化失败:', error)
        throw error
      }
    })

    ctx.on('dispose', () => {
      plugin.dispose()
      if (config.debug) logger.info('插件资源已释放')
    })
  })
}

async function checkAndClearCaches(currentConfig: Config, previousConfig: Config | null): Promise<void> {
  const apiCacheDisabled = previousConfig
    ? (previousConfig.cache.enableApiCache && !currentConfig.cache.enableApiCache)
    : !currentConfig.cache.enableApiCache

  const imageCacheDisabled = previousConfig
    ? (previousConfig.cache.enableImageCache && !currentConfig.cache.enableImageCache)
    : !currentConfig.cache.enableImageCache

  const pdfCacheDisabled = previousConfig
    ? ((previousConfig.cache.enablePdfCache ?? false) && !currentConfig.cache.enablePdfCache)
    : false

  if (apiCacheDisabled) {
    logger.info('检测到 API 缓存已关闭，正在清理内存缓存...')
  }

  if (imageCacheDisabled) {
    logger.info('检测到图片缓存已关闭，正在清理磁盘缓存...')
    try {
      const { promises: fs } = await import('fs')
      const path = await import('path')
      const baseDir = process.cwd()
      const cacheDir = path.resolve(baseDir, currentConfig.downloadPath, 'image-cache')
      await fs.rm(cacheDir, { recursive: true, force: true })
      logger.info(`图片缓存目录已清理: ${cacheDir}`)
    } catch (error) {
      logger.warn(`清理图片缓存目录失败: ${error.message}`)
    }
  }

  if (pdfCacheDisabled) {
    logger.info('检测到 PDF 缓存已关闭，正在清理磁盘缓存...')
    try {
      const { promises: fs } = await import('fs')
      const path = await import('path')
      const baseDir = process.cwd()
      const cacheDir = path.resolve(baseDir, currentConfig.downloadPath, 'pdf-cache')
      await fs.rm(cacheDir, { recursive: true, force: true })
      logger.info(`PDF 缓存目录已清理: ${cacheDir}`)
    } catch (error) {
      logger.warn(`清理 PDF 缓存目录失败: ${error.message}`)
    }
  }

  await cleanTempFiles(currentConfig)
}

async function cleanTempFiles(config: Config): Promise<void> {
  try {
    const { promises: fs } = await import('fs')
    const path = await import('path')
    const baseDir = process.cwd()
    const downloadDir = path.resolve(baseDir, config.downloadPath)

    const entries = await fs.readdir(downloadDir, { withFileTypes: true })
    let cleanedCount = 0

    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('temp_') && entry.name.endsWith('.pdf')) {
        try {
          await fs.unlink(path.join(downloadDir, entry.name))
          cleanedCount++
        } catch (err) {
          if (config.debug) logger.warn(`删除临时文件失败 ${entry.name}: ${err.message}`)
        }
      } else if (entry.isDirectory() && entry.name.startsWith('temp_pdf_')) {
        try {
          await fs.rm(path.join(downloadDir, entry.name), { recursive: true, force: true })
          cleanedCount++
        } catch (err) {
          if (config.debug) logger.warn(`删除临时目录失败 ${entry.name}: ${err.message}`)
        }
      }
    }

    if (cleanedCount > 0) {
      logger.info(`已清理 ${cleanedCount} 个临时文件/目录`)
    }
  } catch (error) {
    if (config.debug) logger.warn(`清理临时文件时出错: ${error.message}`)
  }
}
