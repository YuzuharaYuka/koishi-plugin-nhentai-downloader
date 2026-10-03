/**
 * 稳定性测试：并发 N 在「同时有 fs 写入占用线程池」时是否仍然安全
 * 用法: npx tsx bench/probe-stability.ts <official.zip> <workers> <rounds>
 */
import { createWriteStream } from 'fs'
import { rm } from 'fs/promises'
import { readArchiveImages } from '../src/services/archive'
import { convertImageForMode } from '../src/processors/images'
import { Processor, initCanvasProcessor } from '../src/processor'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const ARCHIVE = process.argv[2]
const WORKERS = Number(process.argv[3] || 4)
const ROUNDS = Number(process.argv[4] || 3)

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

  // 持续写入临时文件，占住线程池
  const outPath = `${process.env.TEMP}/probe-stability-out.bin`
  const writer = createWriteStream(outPath)
  let writing = true
  const churn = (async () => {
    const chunk = Buffer.alloc(256 * 1024)
    while (writing) {
      if (!writer.write(chunk)) await new Promise((r) => writer.once('drain', r))
    }
  })()

  for (let round = 1; round <= ROUNDS; round++) {
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
    console.log(
      `  第 ${round} 轮: ${Date.now() - started}ms  RSS ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`,
    )
  }

  writing = false
  writer.end()
  await churn.catch(() => undefined)
  await rm(outPath, { force: true }).catch(() => undefined)

  console.log(`并发 ${WORKERS} + fs 写入: ${ROUNDS} 轮全部完成`)
  process.exit(0)
}

main().catch((e) => {
  console.error(`并发 ${WORKERS} 失败:`, e)
  process.exit(2)
})
