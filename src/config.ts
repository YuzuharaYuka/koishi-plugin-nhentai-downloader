// src/config.ts
import { Schema } from 'koishi'

// 接口定义保持不变，只调整 Schema 的结构和描述

export interface PuppeteerConfig {
  chromeExecutablePath?: string;
  persistentBrowser: boolean;
  browserCloseTimeout: number;
}

export interface AntiGzipConfig {
  enabled: boolean;
}

export interface CacheConfig {
  enableApiCache: boolean;
  apiCacheTTL: number;
}

export interface Config {
  enableLinkRecognition: boolean;
  searchResultLimit: number;
  promptTimeout: number;
  defaultSearchLanguage: 'all' | 'chinese' | 'japanese' | 'english';

  useForwardForSearch: boolean;
  useForwardForDownload: boolean;
  showTagsInSearch: boolean;
  showLinkInSearch: boolean;

  downloadPath: string;
  defaultOutput: 'zip' | 'pdf' | 'img';
  defaultPassword?: string;
  pdfSendMethod: 'buffer' | 'file';
  imageSendDelay: number;
  antiGzip: AntiGzipConfig;

  pdfEnableCompression: boolean;
  pdfCompressionQuality: number;
  zipCompressionLevel: number;
  
  downloadConcurrency: number;
  downloadRetries: number;
  downloadTimeout: number;
  downloadRetryDelay: number;
  userAgent: string;

  puppeteer: PuppeteerConfig;
  cache: CacheConfig;
  debug: boolean;
  returnApiJson: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableLinkRecognition: Schema.boolean().description('启用后，插件将自动识别消息中的 nhentai 链接并触发下载。').default(true),
    searchResultLimit: Schema.number().min(1).max(25).step(1).default(10).description('搜索指令单页显示的最大结果数量。'),
    promptTimeout: Schema.number().min(1000).default(60000).description('交互式操作（如翻页、下载确认）的等待超时时间（毫秒）。'),
    defaultSearchLanguage: Schema.union([
      Schema.const('all').description('所有语言'),
      Schema.const('chinese').description('中文'),
      Schema.const('japanese').description('日语'),
      Schema.const('english').description('英语'),
    ]).description('搜索指令未指定语言时的默认筛选。设为“所有语言”则不进行筛选。').default('all'),
  }).description('通用设置'),
  
  Schema.object({
    useForwardForSearch: Schema.boolean().description('以合并转发形式发送搜索结果。').default(true),
    useForwardForDownload: Schema.boolean().description('以图片(image)形式发送漫画时使用合并转发。').default(true),
    showTagsInSearch: Schema.boolean().description('在搜索结果中显示作品更详细的信息。').default(true),
    showLinkInSearch: Schema.boolean().description('在搜索结果中附带 nhentai 链接。').default(true),
  }).description('消息设置'),

  Schema.object({
    downloadPath: Schema.string().description('漫画文件及临时文件的本地存储路径。').default('./data/downloads/nhentai'),
    defaultOutput: Schema.union([
      Schema.const('pdf').description('PDF 文件'),
      Schema.const('zip').description('ZIP 压缩包'),
      Schema.const('img').description('逐张图片'),
    ]).description('下载指令未指定输出格式时的默认选项。').default('pdf'),
    defaultPassword: Schema.string().role('secret').description('为生成的 PDF 或 ZIP 文件设置的默认密码。留空则不加密。'),
    pdfSendMethod: Schema.union([
      Schema.const('buffer').description('内存模式'),
      Schema.const('file').description('文件路径模式'),
    ]).description('发送文件的方式。<br>' +
      '若 Koishi 运行环境与机器人客户端无法共享文件系统，请选择“内存模式”。').default('buffer'),
    imageSendDelay: Schema.number().min(0).default(1500).description('以图片形式发送时，每张图片间的发送延迟（毫秒）。'),
    antiGzip: Schema.object({
      enabled: Schema.boolean().description('启用图片抗风控处理，可在一定程度上绕过部分平台审查。').default(true).experimental(),
    }).description('输出设置'),
  }).description('下载设置'),

  Schema.object({
    pdfEnableCompression: Schema.boolean().description('启用图片压缩以减小 PDF 文件的体积。').default(true),
    pdfCompressionQuality: Schema.number().min(1).max(100).step(1).role('slider').default(85).description('JPEG 压缩质量 (1-100)，数值越高体积越大。'),
    zipCompressionLevel: Schema.number().min(0).max(9).step(1).role('slider').default(9).description('ZIP 文件的压缩等级 (0-9)，0为不压缩，9为最大压缩。'),
  }).description('压缩设置'),

  Schema.object({
    downloadConcurrency: Schema.number().min(1).max(10).step(1).default(5).description('下载图片时的最大并发数。'),
    downloadTimeout: Schema.number().min(1000).default(15000).step(1000).description('单张图片下载的超时时间（毫秒）。'),
    downloadRetries: Schema.number().min(0).max(5).step(1).default(3).description('单张图片下载失败后的最大重试次数。'),
    downloadRetryDelay: Schema.number().min(0).default(2000).description('每次重试前的等待时间（毫秒）。'),
    userAgent: Schema.string().description('插件进行网络请求时使用的 User-Agent 标识。').default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'),
  }).description('网络设置'),

  Schema.object({
    puppeteer: Schema.object({
      chromeExecutablePath: Schema.string().description('指定浏览器可执行文件路径。留空则自动检测。'),
      persistentBrowser: Schema.boolean().description('插件启动时预加载并常驻浏览器实例，可加快响应。').default(false),
      browserCloseTimeout: Schema.number().min(0).default(30).description('【仅非常驻模式】任务结束后延迟关闭浏览器的时间（秒）。0 为立即关闭。'),
    }),
    cache: Schema.object({
      enableApiCache: Schema.boolean().description('启用 API 缓存以加快重复请求的响应速度。').default(true),
      apiCacheTTL: Schema.number().min(60000).default(600000).description('API 缓存的有效时间（毫秒）。'),
    }),
  }).description('高级设置'),

  Schema.object({
    debug: Schema.boolean().description('在控制台输出详细的调试日志。').default(false),
    returnApiJson: Schema.boolean().description('【仅调试模式】在控制台以 JSON 格式输出完整的 API 响应。').default(false),
  }).description('调试设置'),
])