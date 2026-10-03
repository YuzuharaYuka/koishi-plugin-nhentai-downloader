/**
 * 官方直链取图 → 解压 → PDF/ZIP 的端到端校验（需要真实 API Key）
 *
 * 用法: NH_API_KEY=... npx tsx bench/verify-official.ts [galleryId] [outputType]
 * 会连续执行两次下载，用于观察第一次走官方直链、第二次因签发配额降级到 CDN 的行为。
 */
import { ApiService } from '../src/services/api'
import { NhentaiService } from '../src/services/nhentai'
import { Processor, initCanvasProcessor } from '../src/processor'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const GALLERY_ID = process.argv[2] || '685699'
const OUTPUT = (process.argv[3] as 'pdf' | 'zip' | 'img') || 'pdf'

const config: Config = {
  apiKey: process.env.NH_API_KEY || '',
  defaultOutput: OUTPUT,
  defaultSearchLanguage: 'all',
  enableLinkRecognition: false,
  searchMode: 'text',
  textMode: { searchResultLimit: 10, showTags: true, showLink: true, showThumbnails: false, useForward: false },
  menuMode: { columns: 3, maxRows: 3 },
  useForwardForDownload: false,
  promptTimeout: 60,
  imageSendDelay: 0,
  downloadPath: './data/temp/nhentai-downloader-official',
  prependIdToFile: true,
  titleType: 'japanese',
  fileSendMethod: 'buffer',
  imageCompression: { enabled: true, quality: 85, threshold: 500, maxEdge: 0 },
  antiGzip: { enabled: false },
  downloadConcurrency: 10,
  downloadRetries: 3,
  downloadTimeout: 30,
  downloadRetryDelay: 2,
  enableSmartRetry: true,
  downloadSource: 'official',
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

async function runOnce(label: string, service: NhentaiService, log: string[]) {
  log.length = 0
  const t0 = Date.now()
  const result = await service.downloadGallery(GALLERY_ID, OUTPUT, undefined, async (status) => {
    log.push(status)
  })
  const ms = Date.now() - t0
  if ('error' in result) {
    console.log(`✗ ${label}: ${result.error} (${ms}ms)`)
    return false
  }
  const size =
    result.type === 'zip'
      ? `${(result.buffer.length / 1024 / 1024).toFixed(2)} MB`
      : result.type === 'pdf'
        ? `${((await (await import('fs/promises')).stat(result.path)).size / 1024 / 1024).toFixed(2)} MB`
        : `${result.images.length} 张`
  console.log(`✓ ${label}: type=${result.type} filename=${result.filename} size=${size} 用时=${ms}ms`)
  return true
}

async function main() {
  if (!config.apiKey) {
    console.error('缺少 NH_API_KEY')
    process.exit(1)
  }

  await initCanvasProcessor()
  const ctx = await createTestContext()
  const api = new ApiService(ctx, config)
  await api.initialize()
  const processor = new Processor(ctx, config)
  await processor.initializeCache()
  const service = new NhentaiService(api, config, processor)

  const log: string[] = []

  console.log(`--- 第 1 次（预期走官方打包直链）---`)
  await runOnce('第一次下载', service, log)
  console.log('   进度消息:', log.slice(0, 6).join(' | '))

  console.log(`--- 第 2 次（预期：签发配额不足 → 自动降级 CDN）---`)
  await runOnce('第二次下载', service, log)
  console.log('   进度消息:', log.slice(0, 6).join(' | '))

  console.log('metrics:', JSON.stringify(api.getMetrics()))
  api.dispose()
  processor.dispose()
  process.exit(0)
}

main().catch((e) => {
  console.error('端到端校验失败:', e)
  process.exit(1)
})
