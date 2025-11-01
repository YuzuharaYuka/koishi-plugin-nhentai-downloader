// --- START OF FILE src/config.ts ---

// src/config.ts
import { Schema } from 'koishi'

// [REFACTOR] Reordered interface properties to match the new schema structure for better readability.
export interface Config {
  // Core Settings
  proxy: string;
  defaultOutput: 'zip' | 'pdf' | 'img';
  defaultSearchLanguage: 'all' | 'chinese' | 'japanese' | 'english';
  enableLinkRecognition: boolean;
  defaultPassword?: string;

  // Messaging & Interaction
  useForwardForSearch: boolean;
  useForwardForDownload: boolean;
  showTagsInSearch: boolean;
  showLinkInSearch: boolean;
  searchResultLimit: number;
  promptTimeout: number;
  imageSendDelay: number;

  // Files & Output
  downloadPath: string;
  prependIdToFile: boolean;
  pdfSendMethod: 'buffer' | 'file';
  pdfEnableCompression: boolean;
  pdfCompressionQuality: number;
  pdfJpegRecompressionSize: number;
  zipCompressionLevel: number;
  antiGzip: { enabled: boolean; };

  // Network & Performance
  downloadConcurrency: number;
  downloadRetries: number;
  downloadTimeout: number;
  downloadRetryDelay: number;
  cache: {
    enableApiCache: boolean;
    apiCacheTTL: number;
    enableImageCache?: boolean;
    imageCacheTTL?: number;
    imageCacheMaxSize?: number;
  };

  // Debugging
  debug: boolean;
  returnApiJson: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    proxy: Schema.string().description(
      '插件使用的代理配置。如: `http://127.0.0.1:7890`'
    ).default(''),
    defaultOutput: Schema.union([
      Schema.const('pdf').description('PDF 文件'),
      Schema.const('zip').description('ZIP 压缩包'),
      Schema.const('img').description('图片'),
    ]).description('下载时的默认输出格式。').default('pdf'),
    defaultSearchLanguage: Schema.union([
      Schema.const('all').description('所有语言'),
      Schema.const('chinese').description('中文'),
      Schema.const('japanese').description('日语'),
      Schema.const('english').description('英语'),
    ]).description('搜索时的默认语言筛选。').default('all'),
    enableLinkRecognition: Schema.boolean().description('自动识别并处理消息中的 nhentai 链接。').default(true),
    defaultPassword: Schema.string().role('secret').description('为 PDF 或 ZIP 文件设置默认密码 (留空则不加密)。'),
  }).description('基础设置'),

  Schema.object({
    useForwardForSearch: Schema.boolean().description('以合并转发形式发送搜索结果。').default(true),
    useForwardForDownload: Schema.boolean().description('以图片形式发送漫画时，使用合并转发。').default(true),
    showTagsInSearch: Schema.boolean().description('在搜索结果中显示作品的标签。').default(true),
    showLinkInSearch: Schema.boolean().description('在搜索结果中附加 nhentai 链接。').default(true),
    searchResultLimit: Schema.number().min(1).max(25).step(1).default(10).description('搜索结果每页显示的数量。'),
    promptTimeout: Schema.number().step(1).min(5).default(60).description('交互式操作的等待超时时间 (秒)。'),
    imageSendDelay: Schema.number().step(1).min(0).default(1).description('以图片形式发送时，每张图片的发送间隔 (秒)。'),
  }).description('消息与交互'),

  Schema.object({
    downloadPath: Schema.string().description('临时文件的本地存储路径。').default('./data/temp/nhentai-downloader'),
    prependIdToFile: Schema.boolean().description('在文件名前添加nh漫画ID。').default(true),
    pdfSendMethod: Schema.union([
      Schema.const('buffer').description('内存(buffer)'),
      Schema.const('file').description('文件路径(file)'),
    ]).description('发送PDF的方式。').default('buffer'),
    pdfEnableCompression: Schema.boolean().description('启用图片压缩以减小 PDF 文件体积。').default(true),
    pdfCompressionQuality: Schema.number().min(1).max(100).step(1).role('slider').default(85).description('JPEG 压缩质量 (1-100)。'),
    pdfJpegRecompressionSize: Schema.number().min(0).default(500).description('体积小于此值 (KB) 的JPEG原图将跳过压缩。设为 0 则始终压缩。'),
    zipCompressionLevel: Schema.number().min(0).max(9).step(1).role('slider').default(1).description('ZIP 文件的压缩等级 (0为不压缩, 9为最高)。'),
    antiGzip: Schema.object({
      enabled: Schema.boolean().description('对输出图片进行抗审查处理，可在一定程度上规避平台风控，对视觉无影响。').default(true).experimental(),
    }),
  }).description('文件与输出'),

  Schema.object({
    downloadConcurrency: Schema.number().min(1).max(25).step(1).default(10).description('下载图片时的最大并发请求数。'),
    downloadTimeout: Schema.number().min(5).max(300).step(1).default(15).description('单张图片下载的超时时间 (秒)。'),
    downloadRetries: Schema.number().min(0).max(5).step(1).default(3).description('下载失败后的重试次数。'),
    downloadRetryDelay: Schema.number().min(0).max(60).step(1).default(1).description('每次重试前的等待时间 (秒)。'),
    cache: Schema.object({
      enableApiCache: Schema.boolean().description('启用 API 响应缓存。').default(true),
      apiCacheTTL: Schema.number().min(1).max(1440).step(1).default(10).description('API 缓存的有效时间 (分钟)。'),
      enableImageCache: Schema.boolean().description('启用图片文件缓存，重复下载相同画廊时可直接使用缓存。').default(true),
      imageCacheTTL: Schema.number().min(1).max(720).step(1).default(24).description('图片缓存的有效时间 (小时)。'),
      imageCacheMaxSize: Schema.number().min(100).max(10240).step(1).default(1024).description('图片缓存的最大大小 (MB)。'),
    }),
  }).description('网络与性能'),

  Schema.object({
    debug: Schema.boolean().description('在控制台输出详细的执行日志。').default(false),
    returnApiJson: Schema.boolean().description('在控制台输出完整的 API 原始响应。').default(false),
  }).description('调试设置'),
])
// --- END OF FILE src/config.ts ---
