/**
 * 缩略图/封面路径校验：文本模式搜索结果与详情页都会走这两条分支
 */
import { ApiService } from '../src/services/api'
import { NhentaiService } from '../src/services/nhentai'
import { Processor, initCanvasProcessor } from '../src/processor'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const config: Config = {
  apiKey: '',
  defaultOutput: 'zip',
  defaultSearchLanguage: 'all',
  enableLinkRecognition: false,
  searchMode: 'text',
  textMode: { searchResultLimit: 10, showTags: true, showLink: true, showThumbnails: true, useForward: false },
  menuMode: { columns: 3, maxRows: 3 },
  useForwardForDownload: false,
  promptTimeout: 60,
  imageSendDelay: 0,
  downloadPath: './data/temp/nhentai-downloader-bench',
  prependIdToFile: true,
  titleType: 'japanese',
  fileSendMethod: 'buffer',
  imageCompression: { enabled: false, quality: 85, threshold: 500, maxEdge: 0 },
  antiGzip: { enabled: true },
  downloadConcurrency: 5,
  downloadRetries: 2,
  downloadTimeout: 30,
  downloadRetryDelay: 1,
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
  await initCanvasProcessor()
  const api = new ApiService(ctx, config)
  await api.initialize()
  const processor = new Processor(ctx, config)
  const service = new NhentaiService(api, config, processor)

  // 1) 搜索结果批量缩略图（文本模式路径）
  const search = await api.searchGalleries('language:chinese pages:>30', 1, 'popular-week')
  const items = (search?.result ?? []).slice(0, 4)
  const covers = await service.getCoversForGalleries(items)
  ok(
    '搜索列表缩略图批量下载（键为字符串 ID）',
    covers.size === items.length && items.every((item) => covers.has(String(item.id))),
    `期望 ${items.length} 张，实际 ${covers.size} 张`,
  )
  for (const item of items) {
    const cover = covers.get(String(item.id))
    ok(`  画廊 ${item.id} 缩略图`, !!cover && cover.buffer.length > 0, `${cover?.extension}, ${cover?.buffer.length} bytes`)
  }

  // 2) 详情页封面（详情菜单路径）
  const detail = await service.getGalleryWithCover(String(items[0]?.id ?? 685699))
  ok(
    '详情页封面下载',
    !!detail?.cover && detail.cover.buffer.length > 0,
    `${detail?.cover?.extension}, ${detail?.cover?.buffer.length} bytes`,
  )

  console.log('metrics:', JSON.stringify(api.getMetrics()))
  api.dispose()
  processor.dispose()
  process.exit(0)
}

main().catch((e) => {
  console.error('封面校验失败:', e)
  process.exit(1)
})
