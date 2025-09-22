// src/config.ts
import { Schema } from 'koishi'

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
  cache: CacheConfig; // [新增] 缓存配置
  debug: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableLinkRecognition: Schema.boolean().description('若启用，插件将自动识别聊天消息中的 nhentai 链接并执行下载指令。').default(true),
    searchResultLimit: Schema.number().min(1).max(25).step(1).default(10).description('搜索指令单次返回的最大结果数量。'),
    promptTimeout: Schema.number().min(1000).description('交互式操作（如搜索后的选择、ID下载确认）的等待输入超时时间（单位：毫秒）。').default(30000),
  }).description('通用设置'),
  
  Schema.object({
    useForwardForSearch: Schema.boolean().description('在支持的平台，搜索结果将以合并转发的形式发送。').default(true),
    useForwardForDownload: Schema.boolean().description('在支持的平台，选择以图片形式发送漫画时，将使用合并转发。').default(true),
    showTagsInSearch: Schema.boolean().description('在搜索结果的作品信息中包含标签展示。').default(true),
    showLinkInSearch: Schema.boolean().description('在搜索结果中附带 nhentai 官网链接。').default(true),
  }).description('消息与外观'),

  Schema.object({
    downloadPath: Schema.string().description('漫画文件及生成过程中的临时文件的本地存储路径。').default('./data/downloads/nhentai'),
    defaultOutput: Schema.union([
      Schema.const('pdf').description('PDF 文件'),
      Schema.const('zip').description('ZIP 压缩包'),
      Schema.const('img').description('逐张图片'),
    ]).description('`nh.download` 指令在未指定输出选项时的默认文件格式。').default('pdf'),
    defaultPassword: Schema.string().role('secret').description('为生成的 PDF 或 ZIP 文件设置一个默认密码。留空则不加密。'),
    imageSendDelay: Schema.number().min(0).description('以逐张图片形式发送漫画时，每张图片之间的发送延迟（单位：毫秒），有助于防止平台风控。').default(1500),
    pdfSendMethod: Schema.union([
      Schema.const('buffer').description('内存模式'),
      Schema.const('file').description('文件路径模式'),
    ]).description('发送文件的方式。若 Koishi 运行环境与机器人客户端无法共享文件系统，必须选择“内存模式”。').default('buffer'),
    antiGzip: Schema.object({
      enabled: Schema.boolean().description('启用图片抗风控处理，可能绕过部分平台风控。此操作对视觉无影响。').default(false),
    }).description('图片抗风控 (实验性)'),
  }).description('下载与输出'),

  Schema.object({
    pdfEnableCompression: Schema.boolean().description('启用图片压缩以减小最终 PDF 文件的体积。').default(true),
    pdfCompressionQuality: Schema.number().min(1).max(100).step(1).role('slider').default(85)
      .description('图片的压缩质量，范围从 1 到 100。'),
  }).description('PDF 格式设置'),

  Schema.object({
    zipCompressionLevel: Schema.number().min(0).max(9).step(1).role('slider').default(9).description('ZIP 文件的压缩等级，0 为不压缩，9 为最大压缩。')
  }).description('ZIP 格式设置'),

  Schema.object({
    downloadConcurrency: Schema.number().min(1).max(10).step(1).description('下载图片时的并发任务数。较高的值可以加快下载速度，但会增加服务器和网络负载。').default(5),
    downloadRetries: Schema.number().min(0).max(5).step(1).description('单张图片下载失败后，自动进行的重试次数。').default(3),
    downloadTimeout: Schema.number().min(1000).description('下载单次请求的超时时间（单位：毫秒）。').default(15000),
    downloadRetryDelay: Schema.number().min(0).description('单张图片下载失败后，重试前的等待时间（单位：毫秒）。').default(2000),
    userAgent: Schema.string().description('插件进行网络请求时使用的 User-Agent 标识。').default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'),
  }).description('网络与性能'),

  Schema.object({
    puppeteer: Schema.object({
      chromeExecutablePath: Schema.string().description('手动指定浏览器的可执行文件路径。若留空，插件将尝试自动检测。'),
      persistentBrowser: Schema.boolean().description('插件启动时预加载浏览器实例并使其常驻，可加快后续任务的响应速度。').default(false),
      browserCloseTimeout: Schema.number().min(0).description('非 `persistentBrowser` 模式生效，任务结束后，关闭浏览器实例的延迟时间（0为立即关闭）。').default(30),
    }),
  }).description('浏览器设置'),
  
  // [新增] 缓存设置分组
  Schema.object({
    cache: Schema.object({
      enableApiCache: Schema.boolean().description('启用 API 缓存。对画廊信息和搜索结果进行缓存，可提升重复请求的响应速度并降低 API 请求频率。').default(true),
      apiCacheTTL: Schema.number().min(60000).description('API 缓存的有效时间（单位：毫秒）。').default(600000), // 10 minutes
    }),
  }).description('缓存设置'),

  Schema.object({
    debug: Schema.boolean().description('启用后，将在控制台输出详细的调试日志，便于问题排查。').default(false),
  }).description('调试设置'),
])