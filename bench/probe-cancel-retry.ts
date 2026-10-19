/**
 * 取消与「仅重试指定页」的端到端探测（需要真实 API Key）
 *
 * 用法: NH_API_KEY=... npx tsx bench/probe-cancel-retry.ts [galleryId]
 */
import { createTestContext } from './harness'
import { ApiService } from '../src/services/api'
import { Processor } from '../src/processor'
import { NhentaiService } from '../src/services/nhentai'
import { CANCELLED } from '../src/services/task'
import type { Config } from '../src/config'

const GALLERY = process.argv[2] || '158731'

const config: Config = {
  apiKey: process.env.NH_API_KEY || '',
  defaultOutput: 'img',
  defaultSearchLanguage: 'all',
  enableLinkRecognition: false,
  searchMode: 'menu',
  textMode: { searchResultLimit: 10, showTags: true, showLink: true, showThumbnails: true, useForward: true },
  menuMode: { columns: 3, maxRows: 3 },
  useForwardForDownload: true,
  imageSendDelay: 0,
  promptTimeout: 60,
  downloadPath: './data/temp/nhentai-downloader',
  prependIdToFile: true,
  titleType: 'japanese',
  imageCompression: { enabled: true, quality: 85, threshold: 500, maxEdge: 0 },
  antiGzip: { enabled: false },
  downloadConcurrency: 10,
  downloadTimeout: 30,
  downloadRetries: 3,
  downloadRetryDelay: 2,
  enableSmartRetry: true,
  downloadSource: 'auto',
  officialArchiveTimeout: 600,
  cache: {
    enableApiCache: false,
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
  if (!config.apiKey) {
    console.error('需要 NH_API_KEY')
    process.exit(1)
  }
  const { app, http, baseDir } = await createTestContext()
  const api = new ApiService({ http, app } as any, config)
  const processor = new Processor({ app, http } as any, config)
  await processor.initializeCache()
  const service = new NhentaiService(api, config, processor)

  console.log('=== 取消：img 模式中途 cancel ===')
  const task = service.tasks.start('bench:1:1', GALLERY, 'img', 0)
  const started = Date.now()
  setTimeout(() => {
    console.log(`  2s 后发出取消…`)
    service.tasks.cancel('bench:1:1')
  }, 2000)

  const result = await service.downloadGallery(GALLERY, 'img', undefined, undefined, task)
  const elapsed = Date.now() - started
  ok('取消后返回已取消', 'error' in result && result.error === CANCELLED, 'error' in result ? result.error : 'not error')
  ok('取消在 30s 内生效', elapsed < 30000, `${elapsed}ms`)

  console.log('\n=== 仅重试指定页（onlyIndexes）===')
  const retryResult = await service.downloadGallery(GALLERY, 'img', undefined, undefined, undefined, {
    onlyIndexes: [0, 1],
  })
  if ('error' in retryResult) {
    ok('重试返回图片', false, retryResult.error)
  } else {
    const indexes = retryResult.type === 'images' ? retryResult.images.map((image) => image.index).sort((a, b) => a - b) : []
    ok('只下发了指定页', indexes.length === 2 && indexes[0] === 0 && indexes[1] === 1, indexes.join(','))
  }

  processor.dispose()
  api.dispose()
  process.exit(0)
}

main().catch((error) => {
  console.error('探测失败:', error)
  process.exit(1)
})
