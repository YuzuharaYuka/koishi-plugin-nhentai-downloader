/**
 * 配置归一化校验（离线）
 *
 * 用法: npx tsx bench/verify-config.ts
 */
import { Config as ConfigSchema, normalizeConfig, type Config } from '../src/config'

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

const base: Config = {
  apiKey: '',
  defaultOutput: 'pdf',
  defaultSearchLanguage: 'all',
  enableLinkRecognition: false,
  searchMode: 'menu',
  textMode: { searchResultLimit: 10, showTags: true, showLink: true, showThumbnails: true, useForward: true },
  menuMode: { columns: 3, maxRows: 3 },
  useForwardForDownload: true,
  imageSendDelay: 1,
  promptTimeout: 60,
  downloadPath: './data/temp/nhentai-downloader',
  fileSendMethod: 'file',
  prependIdToFile: true,
  titleType: 'japanese',
  imageCompression: { enabled: true, quality: 85, threshold: 500, maxEdge: 0 },
  antiGzip: { enabled: true },
  downloadConcurrency: 10,
  downloadTimeout: 30,
  downloadRetries: 3,
  downloadRetryDelay: 2,
  enableSmartRetry: true,
  downloadSource: 'auto',
  officialArchiveTimeout: 600,
  cache: {
    enableApiCache: true,
    apiCacheTTL: 10,
    enableImageCache: true,
    imageCacheTTL: 24,
    imageCacheMaxSize: 1024,
    enablePdfCache: false,
    pdfCacheTTL: 72,
    pdfCacheMaxSize: 2048,
  },
  debug: false,
  returnApiJson: false,
}

const run = (patch: Partial<Config> | Record<string, unknown>) => normalizeConfig({ ...base, ...patch } as Config)

console.log('=== 归一化：越界与非法值 ===')
ok('并发 99 → 25', run({ downloadConcurrency: 99 }).downloadConcurrency === 25)
ok('并发 -5 → 1', run({ downloadConcurrency: -5 }).downloadConcurrency === 1)
ok('并发 NaN → 默认 10', run({ downloadConcurrency: NaN }).downloadConcurrency === 10)
ok('并发小数 7.6 → 8', run({ downloadConcurrency: 7.6 }).downloadConcurrency === 8)
ok('超时 NaN → 默认 30', run({ downloadTimeout: NaN }).downloadTimeout === 30)
ok('重试 -1 → 0', run({ downloadRetries: -1 }).downloadRetries === 0)
ok('压缩包超时 10 → 30（下限）', run({ officialArchiveTimeout: 10 }).officialArchiveTimeout === 30)
ok('promptTimeout 600 保留', run({ promptTimeout: 600 }).promptTimeout === 600)
ok('promptTimeout 9999 → 600', run({ promptTimeout: 9999 }).promptTimeout === 600)

console.log('\n=== 归一化：字符串与枚举 ===')
ok('空白 downloadPath → 默认', run({ downloadPath: '   ' }).downloadPath === base.downloadPath)
ok('非法 defaultOutput → pdf', (run({ defaultOutput: 'xml' }) as any).defaultOutput === 'pdf')
ok('非法 searchMode → menu', (run({ searchMode: 'grid' }) as any).searchMode === 'menu')
ok('searchMode text 保留', run({ searchMode: 'text' }).searchMode === 'text')

console.log('\n=== 归一化：缓存语义 ===')
ok('imageCacheTTL = 0 保留（0 为永久）', run({ cache: { ...base.cache, imageCacheTTL: 0 } }).cache.imageCacheTTL === 0)
ok('pdfCacheTTL = 0 保留（0 为永久）', run({ cache: { ...base.cache, pdfCacheTTL: 0 } }).cache.pdfCacheTTL === 0)
ok('apiCacheTTL 0 → 1（接口缓存无永久语义）', run({ cache: { ...base.cache, apiCacheTTL: 0 } }).cache.apiCacheTTL === 1)
ok(
  'imageCacheMaxSize 10 → 100（下限）',
  run({ cache: { ...base.cache, imageCacheMaxSize: 10 } }).cache.imageCacheMaxSize === 100,
)
ok('cache 缺失字段不抛错', typeof run({ cache: undefined as any }).cache.apiCacheTTL === 'number')

console.log('\n=== 归一化：图片处理参数 ===')
ok('maxEdge -100 → 0', run({ imageCompression: { ...base.imageCompression, maxEdge: -100 } }).imageCompression.maxEdge === 0)
ok('maxEdge 99999 → 4096', run({ imageCompression: { ...base.imageCompression, maxEdge: 99999 } }).imageCompression.maxEdge === 4096)
ok('quality 200 → 100', run({ imageCompression: { ...base.imageCompression, quality: 200 } }).imageCompression.quality === 100)
ok('quality 0 → 1', run({ imageCompression: { ...base.imageCompression, quality: 0 } }).imageCompression.quality === 1)
ok('threshold -1 → 0', run({ imageCompression: { ...base.imageCompression, threshold: -1 } }).imageCompression.threshold === 0)

console.log('\n=== schema 默认值与 normalizeConfig 回退值一致 ===')
const resolved = ConfigSchema({}) as Config
const normalized = normalizeConfig(resolved)
const pairs: Array<[string, unknown, unknown]> = [
  ['downloadConcurrency', resolved.downloadConcurrency, normalized.downloadConcurrency],
  ['downloadTimeout', resolved.downloadTimeout, normalized.downloadTimeout],
  ['downloadRetries', resolved.downloadRetries, normalized.downloadRetries],
  ['downloadRetryDelay', resolved.downloadRetryDelay, normalized.downloadRetryDelay],
  ['promptTimeout', resolved.promptTimeout, normalized.promptTimeout],
  ['imageSendDelay', resolved.imageSendDelay, normalized.imageSendDelay],
  ['officialArchiveTimeout', resolved.officialArchiveTimeout, normalized.officialArchiveTimeout],
  ['downloadPath', resolved.downloadPath, normalized.downloadPath],
  ['cache.apiCacheTTL', resolved.cache.apiCacheTTL, normalized.cache.apiCacheTTL],
  ['cache.imageCacheTTL', resolved.cache.imageCacheTTL, normalized.cache.imageCacheTTL],
  ['cache.imageCacheMaxSize', resolved.cache.imageCacheMaxSize, normalized.cache.imageCacheMaxSize],
  ['cache.pdfCacheTTL', resolved.cache.pdfCacheTTL, normalized.cache.pdfCacheTTL],
  ['cache.pdfCacheMaxSize', resolved.cache.pdfCacheMaxSize, normalized.cache.pdfCacheMaxSize],
  ['imageCompression.quality', resolved.imageCompression.quality, normalized.imageCompression.quality],
  ['imageCompression.threshold', resolved.imageCompression.threshold, normalized.imageCompression.threshold],
  ['imageCompression.maxEdge', resolved.imageCompression.maxEdge, normalized.imageCompression.maxEdge],
]
for (const [name, fromSchema, fromNormalize] of pairs) {
  ok(`${name} = ${JSON.stringify(fromSchema)}`, fromSchema === fromNormalize)
}

process.exit(0)
