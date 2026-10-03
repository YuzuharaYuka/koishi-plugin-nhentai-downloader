/**
 * 集成校验：接口层、限流与下载结果命名的回归
 */
import { ApiService, normalizeSortOption } from '../src/services/api'
import { outputDisplayName } from '../src/handlers'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const config: Config = {
  apiKey: '',
  defaultOutput: 'zip',
  defaultSearchLanguage: 'all',
  enableLinkRecognition: false,
  searchMode: 'text',
  textMode: { searchResultLimit: 10, showTags: true, showLink: true, showThumbnails: false, useForward: false },
  menuMode: { columns: 3, maxRows: 3 },
  useForwardForDownload: false,
  promptTimeout: 60,
  imageSendDelay: 0,
  downloadPath: './data/temp/nhentai-downloader-bench',
  prependIdToFile: true,
  titleType: 'japanese',
  fileSendMethod: 'buffer',
  imageCompression: { enabled: false, quality: 85, threshold: 500, maxEdge: 0 },
  antiGzip: { enabled: false },
  downloadConcurrency: 10,
  downloadRetries: 3,
  downloadTimeout: 30,
  downloadRetryDelay: 2,
  enableSmartRetry: true,
  cache: {
    enableApiCache: true,
    apiCacheTTL: 10,
    enableImageCache: false,
    imageCacheTTL: 24,
    imageCacheMaxSize: 1024,
    enablePdfCache: false,
    pdfCacheTTL: 72,
    pdfCacheMaxSize: 2048,
  },
  debug: false,
  returnApiJson: false,
}

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

async function main() {
  const ctx = await createTestContext()
  const api = new ApiService(ctx, config)
  await api.initialize()

  // 1) sort 归一化
  ok('sort 简写 today → popular-today', normalizeSortOption('today') === 'popular-today')
  ok('sort 非法值返回 undefined', normalizeSortOption('newest') === undefined)
  ok('sort 官方值原样通过', normalizeSortOption('popular-week') === 'popular-week')

  // 2) 无效 ID 不发请求
  const before = api.getMetrics().requests
  const bad = await api.getGallery('not-an-id')
  ok('非法画廊 ID 直接返回 null 且不发请求', bad === null && api.getMetrics().requests === before)

  // 3) CDN 配置（走 /config，同时拿到公告）
  const cdn = await api.getCdnServers()
  ok('CDN 配置解析成功', cdn.image.length > 0 && cdn.thumb.length > 0, `image=[${cdn.image.join(',')}]`)

  // 4) 搜索：官方 sort 枚举全部可用
  for (const sort of ['date', 'popular-today'] as const) {
    const r = await api.searchGalleries('language:chinese pages:>20', 1, sort)
    ok(`搜索 sort=${sort}`, !!r && r.result.length > 0, `${r?.result.length ?? 0} 条 / ${r?.num_pages ?? 0} 页`)
  }

  // 5) 缓存命中：同一查询第二次不应再发请求
  const reqBefore = api.getMetrics().requests
  const cached = await api.searchGalleries('language:chinese pages:>20', 1, 'popular-today')
  ok(
    '相同查询命中缓存（0 次新请求）',
    !!cached && api.getMetrics().requests === reqBefore && api.getMetrics().cacheHits >= 1,
    `requests=${api.getMetrics().requests}`,
  )

  // 6) 热门列表（原实现把数组当成分页对象，永远返回空）
  const popular = await api.getPopularGalleries()
  ok('GET /galleries/popular 数组正确解析', !!popular && popular.result.length > 0, `${popular?.result.length ?? 0} 条`)

  // 7) 详情 + include=related：一次请求同时拿到详情与相关作品
  const reqBefore2 = api.getMetrics().requests
  const gallery = await api.getGallery(685699, { include: ['related'] })
  ok(
    '详情 include=related 一次请求带回相关作品',
    !!gallery && Array.isArray(gallery.related) && gallery.related!.length > 0 && api.getMetrics().requests === reqBefore2 + 1,
    `related=${gallery?.related?.length ?? 0}, pages=${gallery?.images.pages.length ?? 0}, requests+${api.getMetrics().requests - reqBefore2}`,
  )

  // 8) 独立 related 端点
  const related = await api.getRelatedGalleries(685699)
  ok('GET /galleries/{id}/related 解析正确', !!related && related.result.length > 0, `${related?.result.length ?? 0} 条`)

  // 9) 列表项新增字段
  const item = popular?.result[0]
  ok(
    '列表项包含 num_favorites / tag_ids',
    !!item && typeof item.num_favorites === 'number' && Array.isArray(item.tag_ids),
    `fav=${item?.num_favorites} tags=${item?.tag_ids?.length}`,
  )

  // 10) 页面 thumbnail 为字符串路径
  const page = gallery?.images.pages[0]
  ok('PageInfo.thumbnail 是字符串', typeof page?.thumbnail === 'string', page?.thumbnail)

  // 11) 封面重复扩展名已归一化
  ok(
    '封面重复扩展名已清理',
    !!gallery && !/\.(webp|jpg|png)\.(webp|jpg|png)$/i.test(gallery.images.cover.path),
    gallery?.images.cover.path,
  )

  // 12) 限流器按官方配额生效（匿名 search = 10/1min × 0.9 = 9）
  const stats = (api as any).limiter.stats()
  ok('限流器已记录配额', stats.length > 0, JSON.stringify(stats.slice(0, 3)))

  // 13) 任务完成提示的作品名：逐张图片的 filename 是裸标题，不能被当成「有扩展名」
  ok('PDF 文件名去掉扩展名', outputDisplayName('[123] title.pdf') === '[123] title')
  ok('ZIP 文件名去掉扩展名', outputDisplayName('[123] title.zip') === '[123] title')
  ok('逐张图片的裸标题原样保留', outputDisplayName('[685085] 彼女はまだ18cm以上を知らない。') === '[685085] 彼女はまだ18cm以上を知らない。')
  ok('标题自带点号不被截断', outputDisplayName('[123] Vol.1.5 完.pdf') === '[123] Vol.1.5 完')

  console.log('\nmetrics:', JSON.stringify(api.getMetrics()))
  api.dispose()
  process.exit(0)
}

main().catch((e) => {
  console.error('集成校验失败:', e)
  process.exit(1)
})
