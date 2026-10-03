import { Schema } from 'koishi'
import {
  DEFAULT_API_CACHE_TTL_MINUTES,
  DEFAULT_ARCHIVE_TIMEOUT_SECONDS,
  DEFAULT_COMPRESSION_MAX_EDGE,
  DEFAULT_COMPRESSION_QUALITY,
  DEFAULT_COMPRESSION_THRESHOLD_KB,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  DEFAULT_DOWNLOAD_PATH,
  DEFAULT_DOWNLOAD_RETRIES,
  DEFAULT_DOWNLOAD_TIMEOUT,
  DEFAULT_IMAGE_CACHE_MAX_MB,
  DEFAULT_IMAGE_CACHE_TTL_HOURS,
  DEFAULT_IMAGE_SEND_DELAY,
  DEFAULT_PDF_CACHE_MAX_MB,
  DEFAULT_PDF_CACHE_TTL_HOURS,
  DEFAULT_PROMPT_TIMEOUT,
  DEFAULT_RETRY_DELAY_SECONDS,
} from './constants'

export interface Config {
  apiKey?: string
  defaultOutput: 'pdf' | 'zip' | 'img'
  defaultSearchLanguage: 'all' | 'chinese' | 'japanese' | 'english'
  enableLinkRecognition: boolean
  defaultPassword?: string

  searchMode: 'text' | 'menu'
  textMode: {
    searchResultLimit: number
    showTags: boolean
    showLink: boolean
    showThumbnails: boolean
    useForward: boolean
  }
  menuMode: {
    columns: number
    maxRows: number
  }

  useForwardForDownload: boolean
  imageSendDelay: number
  promptTimeout: number

  downloadPath: string
  fileSendMethod: 'buffer' | 'file'
  prependIdToFile: boolean
  titleType: 'japanese' | 'english' | 'pretty'

  /** 仅作用于 PDF 内页；ZIP 原样存入，逐张发送固定 JPEG */
  imageCompression: {
    enabled: boolean
    quality: number
    threshold: number
    maxEdge: number
  }

  /** 仅作用于逐张发送的图片与搜索缩略图 */
  antiGzip: { enabled: boolean }

  downloadConcurrency: number
  downloadTimeout: number
  downloadRetries: number
  downloadRetryDelay: number
  enableSmartRetry: boolean

  /** auto：配置了 API Key 时优先官方直链；official：总是优先；cdn：只逐页下载 */
  downloadSource: 'auto' | 'official' | 'cdn'
  officialArchiveTimeout: number

  cache: {
    enableApiCache: boolean
    apiCacheTTL: number
    enableImageCache: boolean
    imageCacheTTL: number
    imageCacheMaxSize: number
    enablePdfCache: boolean
    pdfCacheTTL: number
    pdfCacheMaxSize: number
  }

  debug: boolean
  returnApiJson: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    apiKey: Schema.string()
      .role('secret')
      .description('nhentai 官方 API Key')
      .default(''),
    defaultOutput: Schema.union([
      Schema.const('pdf').description('PDF 文件'),
      Schema.const('zip').description('ZIP 压缩包'),
      Schema.const('img').description('逐张图片'),
    ])
      .description('默认输出格式')
      .default('pdf'),
    defaultSearchLanguage: Schema.union([
      Schema.const('all').description('所有语言'),
      Schema.const('chinese').description('中文'),
      Schema.const('japanese').description('日语'),
      Schema.const('english').description('英语'),
    ])
      .description('默认语言筛选')
      .default('all'),
    defaultPassword: Schema.string()
      .role('secret')
      .description('PDF / ZIP 的默认密码，留空则不加密'),
    enableLinkRecognition: Schema.boolean()
      .description('识别消息中的 nhentai 链接并自动下载')
      .default(false),
  }).description('基础'),

  Schema.object({
    searchMode: Schema.union([
      Schema.const('menu').description('图片菜单'),
      Schema.const('text').description('文本列表'),
    ])
      .description('搜索结果展示方式')
      .default('menu'),
    menuMode: Schema.object({
      columns: Schema.number()
        .min(1).max(5).step(1)
        .description('每行显示数量')
        .default(3),
      maxRows: Schema.number()
        .min(1).max(5).step(1)
        .description('最大行数')
        .default(3),
    }).description('图片菜单'),
    textMode: Schema.object({
      searchResultLimit: Schema.number()
        .min(1).max(25).step(1)
        .description('每页显示数量')
        .default(10),
      showTags: Schema.boolean().description('显示标签').default(true),
      showLink: Schema.boolean().description('显示链接').default(true),
      showThumbnails: Schema.boolean().description('显示缩略图').default(true),
      useForward: Schema.boolean().description('使用合并转发').default(true),
    }).description('文本列表'),
  }).description('搜索'),

  Schema.object({
    useForwardForDownload: Schema.boolean()
      .description('逐张发送图片时使用合并转发')
      .default(true),
    imageSendDelay: Schema.number()
      .min(0).max(10).step(1)
      .description('每张图片的发送间隔（秒）')
      .default(DEFAULT_IMAGE_SEND_DELAY),
    promptTimeout: Schema.number()
      .min(5).max(600).step(1)
      .description('交互等待超时（秒）')
      .default(DEFAULT_PROMPT_TIMEOUT),
  }).description('消息'),

  Schema.object({
    downloadPath: Schema.string()
      .description('临时文件与缓存的存放路径，相对 Koishi 根目录')
      .default(DEFAULT_DOWNLOAD_PATH),
    fileSendMethod: Schema.union([
      Schema.const('file').description('文件路径'),
      Schema.const('buffer').description('内存'),
    ])
      .description('PDF / ZIP 的发送方式，上百 MB 的大文件用 buffer 会占用大量内存')
      .default('file'),
    prependIdToFile: Schema.boolean()
      .description('文件名前加上画廊 ID')
      .default(true),
    titleType: Schema.union([
      Schema.const('japanese').description('日文标题'),
      Schema.const('english').description('英文标题'),
      Schema.const('pretty').description('简化标题'),
    ])
      .description('文件名使用的标题')
      .default('japanese'),
  }).description('文件'),

  Schema.object({
    imageCompression: Schema.object({
      enabled: Schema.boolean()
        .description('对已是 JPEG 的内页也按质量重新编码，关闭后只转码 PDF 无法嵌入的 webp / png')
        .default(true),
      quality: Schema.number()
        .min(1).max(100).step(1).role('slider')
        .description('JPEG 质量 (1-100)')
        .default(DEFAULT_COMPRESSION_QUALITY),
      threshold: Schema.number()
        .min(0).max(10240)
        .description('小于该体积（KB）的 JPEG 原图直接嵌入，0 为全部重新编码')
        .default(DEFAULT_COMPRESSION_THRESHOLD_KB),
      maxEdge: Schema.number()
        .min(0).max(4096).step(1)
        .description('内页最长边上限（像素），0 为不限制，设为 1600 体积约降20%')
        .default(DEFAULT_COMPRESSION_MAX_EDGE),
    }),
    antiGzip: Schema.object({
      enabled: Schema.boolean()
        .description('给逐张发送的图片与搜索缩略图加水印')
        .default(true)
        .experimental(),
    }),
  }).description('图片'),

  Schema.object({
    downloadSource: Schema.union([
      Schema.const('auto').description('自动'),
      Schema.const('official').description('官方直链'),
      Schema.const('cdn').description('仅 CDN'),
    ])
      .description('取图方式，官方直链由 nhentai 打包，需要 API Key，失败时自动改用 CDN')
      .default('auto'),
    downloadConcurrency: Schema.number()
      .min(1).max(25).step(1)
      .description('逐页下载的最大并发数')
      .default(DEFAULT_DOWNLOAD_CONCURRENCY),
    downloadTimeout: Schema.number()
      .min(5).max(300).step(1)
      .description('单张图片下载超时（秒）')
      .default(DEFAULT_DOWNLOAD_TIMEOUT),
    downloadRetries: Schema.number()
      .min(0).max(5).step(1)
      .description('单张图片的尝试次数，含首次')
      .default(DEFAULT_DOWNLOAD_RETRIES),
    downloadRetryDelay: Schema.number()
      .min(0).max(60).step(1)
      .description('重试间隔（秒）')
      .default(DEFAULT_RETRY_DELAY_SECONDS),
    enableSmartRetry: Schema.boolean()
      .description('失败时切换其他图片服务器')
      .default(true),
    officialArchiveTimeout: Schema.number()
      .min(30).max(3600).step(30)
      .description('官方压缩包下载超时（秒）')
      .default(DEFAULT_ARCHIVE_TIMEOUT_SECONDS),
  }).description('下载'),

  Schema.object({
    cache: Schema.object({
      enableApiCache: Schema.boolean()
        .description('缓存接口响应（内存）')
        .default(true),
      apiCacheTTL: Schema.number()
        .min(1).max(1440).step(1)
        .description('接口缓存有效期（分钟）')
        .default(DEFAULT_API_CACHE_TTL_MINUTES),
      enableImageCache: Schema.boolean()
        .description('缓存图片（磁盘）')
        .default(true),
      imageCacheTTL: Schema.number()
        .min(0).max(720).step(1)
        .description('图片缓存有效期（小时），0 为永久')
        .default(DEFAULT_IMAGE_CACHE_TTL_HOURS),
      imageCacheMaxSize: Schema.number()
        .min(100).max(10240).step(1)
        .description('图片缓存上限（MB）')
        .default(DEFAULT_IMAGE_CACHE_MAX_MB),
      enablePdfCache: Schema.boolean()
        .description('缓存生成的 PDF（磁盘）')
        .default(false),
      pdfCacheTTL: Schema.number()
        .min(0).max(720).step(1)
        .description('PDF 缓存有效期（小时），0 为永久')
        .default(DEFAULT_PDF_CACHE_TTL_HOURS),
      pdfCacheMaxSize: Schema.number()
        .min(100).max(10240).step(1)
        .description('PDF 缓存上限（MB）')
        .default(DEFAULT_PDF_CACHE_MAX_MB),
    }),
  }).description('缓存'),

  Schema.object({
    debug: Schema.boolean().description('输出调试日志').default(false),
    returnApiJson: Schema.boolean().description('输出接口原始响应').default(false),
  }).description('调试'),
])

/**
 * 把配置夹到安全区间。
 * YAML 里的值不保证经过 schema 校验，这里只兜住「类型正确」与「不小于最小值」，
 * 上限与 schema 保持一致，避免出现「面板能填、运行时却被悄悄截断」的情况。
 */
export function normalizeConfig(config: Config): Config {
  const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.round(value)))
  }

  return {
    ...config,
    defaultOutput: ['pdf', 'zip', 'img'].includes(config.defaultOutput) ? config.defaultOutput : 'pdf',
    searchMode: config.searchMode === 'text' ? 'text' : 'menu',
    imageSendDelay: clamp(config.imageSendDelay, 0, 10, DEFAULT_IMAGE_SEND_DELAY),
    promptTimeout: clamp(config.promptTimeout, 5, 600, DEFAULT_PROMPT_TIMEOUT),
    downloadConcurrency: clamp(config.downloadConcurrency, 1, 25, DEFAULT_DOWNLOAD_CONCURRENCY),
    downloadTimeout: clamp(config.downloadTimeout, 5, 300, DEFAULT_DOWNLOAD_TIMEOUT),
    downloadRetries: clamp(config.downloadRetries, 0, 5, DEFAULT_DOWNLOAD_RETRIES),
    downloadRetryDelay: clamp(config.downloadRetryDelay, 0, 60, DEFAULT_RETRY_DELAY_SECONDS),
    officialArchiveTimeout: clamp(
      config.officialArchiveTimeout,
      30,
      3600,
      DEFAULT_ARCHIVE_TIMEOUT_SECONDS,
    ),
    downloadPath: config.downloadPath?.trim() || DEFAULT_DOWNLOAD_PATH,
    imageCompression: {
      ...config.imageCompression,
      quality: clamp(config.imageCompression?.quality, 1, 100, DEFAULT_COMPRESSION_QUALITY),
      threshold: clamp(
        config.imageCompression?.threshold,
        0,
        10240,
        DEFAULT_COMPRESSION_THRESHOLD_KB,
      ),
      maxEdge: clamp(config.imageCompression?.maxEdge, 0, 4096, DEFAULT_COMPRESSION_MAX_EDGE),
    },
    cache: {
      ...config.cache,
      apiCacheTTL: clamp(config.cache?.apiCacheTTL, 1, 1440, DEFAULT_API_CACHE_TTL_MINUTES),
      imageCacheTTL: clamp(config.cache?.imageCacheTTL, 0, 720, DEFAULT_IMAGE_CACHE_TTL_HOURS),
      imageCacheMaxSize: clamp(config.cache?.imageCacheMaxSize, 100, 10240, DEFAULT_IMAGE_CACHE_MAX_MB),
      pdfCacheTTL: clamp(config.cache?.pdfCacheTTL, 0, 720, DEFAULT_PDF_CACHE_TTL_HOURS),
      pdfCacheMaxSize: clamp(config.cache?.pdfCacheMaxSize, 100, 10240, DEFAULT_PDF_CACHE_MAX_MB),
    },
  }
}
