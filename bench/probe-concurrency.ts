/**
 * 并发上限探测：找出 canvas 编解码在什么并发度下会崩
 * 用法: npx tsx bench/probe-concurrency.ts <official.zip> <workers>
 */
import { readArchiveImages } from '../src/services/archive'
import { convertImageForMode } from '../src/processors/images'
import { Processor, initCanvasProcessor } from '../src/processor'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const ARCHIVE = process.argv[2]
const WORKERS = Number(process.argv[3] || 4)

const config: Config = {
  apiKey: '',
  defaultOutput: 'pdf',
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
  imageCompression: { enabled: true, quality: 85, threshold: 500, maxEdge: 0 },
  antiGzip: { enabled: true },
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

async function main() {
  const ctx = await createTestContext()
  await initCanvasProcessor()
  const processor = new Processor(ctx, config)

  const pages: Array<{ buffer: Buffer; extension: string }> = []
  for await (const image of readArchiveImages(ARCHIVE, { expectedPages: 54 })) {
    pages.push({ buffer: image.buffer, extension: image.extension })
  }

  const peakRss: number[] = []
  const sampler = setInterval(() => {
    peakRss.push(process.memoryUsage().rss / 1024 / 1024)
  }, 100)

  const queue = [...pages]
  let next = 0
  const started = Date.now()
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      while (next < queue.length) {
        const page = queue[next++]
        await convertImageForMode(processor.processor, page.buffer, page.extension, 'pdf', config)
      }
    }),
  )
  clearInterval(sampler)

  const ms = Date.now() - started
  const peak = peakRss.length ? Math.max(...peakRss) : process.memoryUsage().rss / 1024 / 1024
  console.log(
    `并发 ${WORKERS}: 完成 ${pages.length} 页, ${ms}ms, ${(pages.length / (ms / 1000)).toFixed(1)} 页/秒, 峰值 RSS ${peak.toFixed(0)} MB`,
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(`并发 ${WORKERS} 失败:`, e)
  process.exit(2)
})
