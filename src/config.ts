import { Schema } from 'koishi'

export interface Config {
  proxy: string;
  defaultOutput: 'zip' | 'pdf' | 'img';
  defaultSearchLanguage: 'all' | 'chinese' | 'japanese' | 'english';
  enableLinkRecognition: boolean;
  defaultPassword?: string;

  useForwardForSearch: boolean;
  useForwardForDownload: boolean;
  showTagsInSearch: boolean;
  showLinkInSearch: boolean;
  searchResultLimit: number;
  promptTimeout: number;
  imageSendDelay: number;

  downloadPath: string;
  prependIdToFile: boolean;
  pdfSendMethod: 'buffer' | 'file';
  pdfEnableCompression: boolean;
  pdfCompressionQuality: number;
  pdfJpegRecompressionSize: number;
  zipCompressionLevel: number;
  antiGzip: { enabled: boolean; };

  downloadConcurrency: number;
  downloadRetries: number;
  downloadTimeout: number;
  downloadRetryDelay: number;
  enableSmartRetry: boolean;

  cache: {
    enableApiCache: boolean;
    apiCacheTTL: number;
    enableImageCache: boolean;
    imageCacheTTL: number;
    imageCacheMaxSize: number;
    enablePdfCache: boolean;
    pdfCacheTTL: number;
    pdfCacheMaxSize: number;
  };

  debug: boolean;
  returnApiJson: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  // ==================== 基础设置 ====================
  Schema.object({
    proxy: Schema.string()
      .description('插件访问 nhentai 时使用的网络代理')
      .default(''),
    defaultOutput: Schema.union([
      Schema.const('pdf').description('PDF 文件'),
      Schema.const('zip').description('ZIP 压缩包'),
      Schema.const('img').description('图片'),
    ])
      .description('下载画廊时的默认文件输出格式')
      .default('pdf'),
    defaultSearchLanguage: Schema.union([
      Schema.const('all').description('所有语言'),
      Schema.const('chinese').description('中文'),
      Schema.const('japanese').description('日语'),
      Schema.const('english').description('英语'),
    ])
      .description('搜索画廊时的默认语言')
      .default('all'),
    enableLinkRecognition: Schema.boolean()
      .description('自动识别消息中的 nhentai 链接并发送画廊信息')
      .default(true),
    defaultPassword: Schema.string()
      .role('secret')
      .description('为 PDF 和 ZIP 文件设置默认密码 (留空则不加密)'),
  }).description('基础设置'),

  // ==================== 搜索设置 ====================
  Schema.object({
    searchResultLimit: Schema.number()
      .min(1).max(25).step(1)
      .description('搜索结果每页显示的最大数量')
      .default(10),
    showTagsInSearch: Schema.boolean()
      .description('搜索结果中显示画廊标签')
      .default(true),
    showLinkInSearch: Schema.boolean()
      .description('搜索结果中包含 nhentai 链接')
      .default(true),
  }).description('搜索设置'),

  // ==================== 消息设置 ====================
  Schema.object({
    useForwardForSearch: Schema.boolean()
      .description('以合并转发形式发送搜索结果')
      .default(true),
    useForwardForDownload: Schema.boolean()
      .description('以图片形式发送画廊时使用合并转发')
      .default(true),
    imageSendDelay: Schema.number()
      .min(0).step(1)
      .description('以图片形式发送时每张图片的发送间隔 (秒)')
      .default(1),
    promptTimeout: Schema.number()
      .min(5).step(1)
      .description('交互式操作的超时时间 (秒)')
      .default(60),
  }).description('消息设置'),

  // ==================== 文件设置 ====================
  Schema.object({
    downloadPath: Schema.string()
      .description('下载的临时文件在本地的存储路径')
      .default('./data/temp/nhentai-downloader'),
    prependIdToFile: Schema.boolean()
      .description('在文件名前添加画廊 ID')
      .default(true),
  }).description('文件设置'),

  // ==================== PDF 设置 ====================
  Schema.object({
    pdfSendMethod: Schema.union([
      Schema.const('buffer').description('内存 (buffer)'),
      Schema.const('file').description('文件路径 (file)'),
    ])
      .description('发送 PDF 文件的方式')
      .default('buffer'),
    pdfEnableCompression: Schema.boolean()
      .description('启用图片压缩以减小 PDF 文件体积')
      .default(true),
    pdfCompressionQuality: Schema.number()
      .min(1).max(100).step(1).role('slider')
      .description('JPEG 图片的压缩质量 (1-100)')
      .default(90),
    pdfJpegRecompressionSize: Schema.number()
      .min(0)
      .description('小于此体积 (KB) 的 JPEG 原图将不被压缩，设为 0 则全部压缩')
      .default(500),
  }).description('PDF 设置'),

  // ==================== ZIP 设置 ====================
  Schema.object({
    zipCompressionLevel: Schema.number()
      .min(0).max(9).step(1).role('slider')
      .description('ZIP 文件的压缩级别 (0 不压缩, 9 最高)')
      .default(1),
  }).description('ZIP 设置'),

  // ==================== 图片设置 ====================
  Schema.object({
    antiGzip: Schema.object({
      enabled: Schema.boolean()
        .description('对输出图片进行抗风控处理，规避图片审查')
        .default(true)
        .experimental(),
    }),
  }).description('图片设置'),

  // ==================== 下载设置 ====================
  Schema.object({
    downloadConcurrency: Schema.number()
      .min(1).max(25).step(1)
      .description('下载图片时的最大并发数')
      .default(10),
    downloadTimeout: Schema.number()
      .min(5).max(300).step(1)
      .description('单张图片下载的超时时间 (秒)')
      .default(30),
    downloadRetries: Schema.number()
      .min(0).max(5).step(1)
      .description('图片下载失败后的重试次数')
      .default(3),
    downloadRetryDelay: Schema.number()
      .min(0).max(60).step(1)
      .description('每次重试前的等待时间 (秒)')
      .default(2),
    enableSmartRetry: Schema.boolean()
      .description('启用重试自动切换备用图片服务器域名')
      .default(true),
  }).description('下载设置'),

  // ==================== 缓存设置 ====================
  Schema.object({
    cache: Schema.object({
      enableApiCache: Schema.boolean()
        .description('启用 API 响应缓存 (内存)')
        .default(true),
      apiCacheTTL: Schema.number()
        .min(1).max(1440).step(1)
        .description('API 缓存的有效时间 (分钟)')
        .default(10),
      enableImageCache: Schema.boolean()
        .description('启用图片文件缓存 (磁盘)')
        .default(true),
      imageCacheTTL: Schema.number()
        .min(0).max(720).step(1)
        .description('图片缓存的有效时间 (小时，0 表示永久保存)')
        .default(24),
      imageCacheMaxSize: Schema.number()
        .min(100).max(10240).step(1)
        .description('图片缓存的最大体积 (MB)')
        .default(1024),
      enablePdfCache: Schema.boolean()
        .description('启用 PDF 文件缓存 (磁盘)')
        .default(false),
      pdfCacheTTL: Schema.number()
        .min(0).max(720).step(1)
        .description('PDF 缓存的有效时间 (小时，0 表示永久保存)')
        .default(72),
      pdfCacheMaxSize: Schema.number()
        .min(100).max(10240).step(1)
        .description('PDF 缓存的最大体积 (MB)')
        .default(2048),
    }),
  }).description('缓存管理'),

  // ==================== 调试设置 ====================
  Schema.object({
    debug: Schema.boolean()
      .description('在控制台输出详细的调试日志')
      .default(false),
    returnApiJson: Schema.boolean()
      .description('在控制台输出 API 的原始响应')
      .default(false),
  }).description('调试设置'),
])
