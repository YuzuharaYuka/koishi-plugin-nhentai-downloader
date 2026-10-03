/**
 * 图片处理性能基准（离线，使用已捕获的真实官方压缩包）
 *
 * 用法: npx tsx bench/verify-image-perf.ts <official.zip> [pages]
 */
import { createCanvas, Image, SKRSContext2D } from '@napi-rs/canvas'
import { readArchiveImages } from '../src/services/archive'
import { convertImageForMode } from '../src/processors/images'
import { Processor, initCanvasProcessor } from '../src/processor'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const ARCHIVE = process.argv[2]
const LIMIT = Number(process.argv[3] || 0)

// 官方字形位图常量（与 canvas-processor 一致）
const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const DIGITS = [
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,1,1, 1,0,1,0,1, 1,1,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  [0,0,1,0,0, 0,1,1,0,0, 1,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 1,1,1,1,1],
  [0,1,1,1,0, 1,0,0,0,1, 0,0,0,0,1, 0,0,0,1,0, 0,0,1,0,0, 0,1,0,0,0, 1,1,1,1,1],
  [0,1,1,1,0, 1,0,0,0,1, 0,0,0,0,1, 0,0,1,1,0, 0,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  [0,0,0,1,0, 0,0,1,1,0, 0,1,0,1,0, 1,0,0,1,0, 1,1,1,1,1, 0,0,0,1,0, 0,0,0,1,0],
  [1,1,1,1,1, 1,0,0,0,0, 1,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,0, 1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  [1,1,1,1,1, 0,0,0,0,1, 0,0,0,1,0, 0,0,1,0,0, 0,1,0,0,0, 0,1,0,0,0, 0,1,0,0,0],
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,1, 0,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0],
]

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

/** 旧实现的水印绘制：逐像素 fillRect */
function drawDigitOld(ctx: SKRSContext2D, digit: number, startX: number, startY: number, scale: number, alpha: number) {
  const glyph = DIGITS[Math.min(digit, 9)]
  const width = ctx.canvas.width
  const height = ctx.canvas.height
  ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`
  for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
    for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
      if (glyph[gy * GLYPH_WIDTH + gx] === 0) continue
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = startX + gx * scale + sx
          const y = startY + gy * scale + sy
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }
}

/** 旧实现的水印绘制：单次 drawImage */
function drawDigitNew(ctx: SKRSContext2D, digit: number, startX: number, startY: number, scale: number, alpha: number) {
  const canvas = createCanvas(GLYPH_WIDTH, GLYPH_HEIGHT)
  const gctx = canvas.getContext('2d')
  gctx.fillStyle = '#000'
  const glyph = DIGITS[Math.min(digit, 9)]
  for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
    for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
      if (glyph[gy * GLYPH_WIDTH + gx] !== 0) gctx.fillRect(gx, gy, 1, 1)
    }
  }
  const smoothing = ctx.imageSmoothingEnabled
  const globalAlpha = ctx.globalAlpha
  ctx.imageSmoothingEnabled = false
  ctx.globalAlpha = alpha
  ctx.drawImage(canvas, startX, startY, GLYPH_WIDTH * scale, GLYPH_HEIGHT * scale)
  ctx.imageSmoothingEnabled = smoothing
  ctx.globalAlpha = globalAlpha
}

async function decode(buffer: Buffer) {
  const img = new Image()
  img.src = buffer
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = reject
  })
  return img
}

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

async function main() {
  const ctx = await createTestContext()
  await initCanvasProcessor()
  const processor = new Processor(ctx, config)

  const pages: Array<{ index: number; buffer: Buffer; extension: string }> = []
  for await (const image of readArchiveImages(ARCHIVE, { expectedPages: 54 })) {
    pages.push({ index: image.index, buffer: image.buffer, extension: image.extension })
    if (LIMIT && pages.length >= LIMIT) break
  }

  const sourceBytes = pages.reduce((sum, page) => sum + page.buffer.length, 0)
  console.log(`样本: ${pages.length} 页, 原始 ${(sourceBytes / 1024 / 1024).toFixed(2)} MB`)
  const extCount: Record<string, number> = {}
  for (const page of pages) extCount[page.extension] = (extCount[page.extension] || 0) + 1
  console.log(`格式分布: ${JSON.stringify(extCount)}`)

  // ── 1) PDF 打包前处理：旧两段式 vs 新单次解码 ──
  // 两种实现各跑两轮，取第二轮，避免首次运行的预热干扰
  const runNew = async () => {
    let bytes = 0
    for (const page of pages) {
      const { buffer } = await convertImageForMode(processor.processor, page.buffer, page.extension, 'pdf', config)
      bytes += buffer.length
    }
    return bytes
  }

  const runOld = async () => {
    let bytes = 0
    for (const page of pages) {
      let converted = page.buffer
      let format = page.extension.toLowerCase() === 'jpg' ? 'jpeg' : page.extension.toLowerCase()
      const target = 'jpeg'
      if (config.imageCompression.enabled && format !== target && !(target === 'jpeg' && format === 'jpg')) {
        converted = Buffer.from(
          await processor.processor.processImage(page.buffer, target, config.imageCompression.quality, false),
        )
        format = target
      }
      let final = converted
      if (config.imageCompression.enabled && (format === 'jpeg' || format === 'jpg')) {
        const sizeKB = converted.length / 1024
        if (!(config.imageCompression.threshold > 0 && sizeKB <= config.imageCompression.threshold)) {
          final = Buffer.from(
            await processor.processor.processImage(converted, 'jpeg', config.imageCompression.quality, false),
          )
        }
      }
      bytes += final.length
    }
    return bytes
  }

  await runOld()
  await runNew()

  const tOld = Date.now()
  const oldBytes = await runOld()
  const oldMs = Date.now() - tOld

  const tNew = Date.now()
  const newBytes = await runNew()
  const newMs = Date.now() - tNew

  console.log(`\n=== PDF 打包前处理（${pages.length} 页，已预热）===`)
  console.log(`旧实现（两段式）: ${oldMs}ms  ${(oldMs / pages.length).toFixed(0)}ms/页  输出 ${(oldBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`新实现（单次解码）: ${newMs}ms  ${(newMs / pages.length).toFixed(0)}ms/页  输出 ${(newBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(
    `差异: ${(((oldMs - newMs) / oldMs) * 100).toFixed(1)}% 耗时, ${(((oldBytes - newBytes) / oldBytes) * 100).toFixed(1)}% 体积`,
  )

  // ── 3) 水印绘制：逐像素 fillRect vs 一次 drawImage ──
  const sample = pages[Math.floor(pages.length / 2)]
  const img = await decode(sample.buffer)
  const scale = Math.max(8, Math.floor(img.width / 150))
  const iterations = 20

  const runDraw = (fn: typeof drawDigitOld) => {
    const canvas = createCanvas(img.width, img.height)
    const c = canvas.getContext('2d')
    c.drawImage(img, 0, 0)
    const started = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) fn(c, 7, 20, 20, scale, 0.15)
    return Number(process.hrtime.bigint() - started) / 1e6 / iterations
  }

  const oldDrawMs = runDraw(drawDigitOld)
  const newDrawMs = runDraw(drawDigitNew)
  console.log(`\n=== 水印绘制（${img.width}x${img.height}, scale=${scale}, 平均 ${iterations} 次）===`)
  console.log(`逐像素 fillRect: ${oldDrawMs.toFixed(3)}ms/次`)
  console.log(`一次 drawImage:  ${newDrawMs.toFixed(3)}ms/次`)
  console.log(`提升: ${(((oldDrawMs - newDrawMs) / oldDrawMs) * 100).toFixed(1)}%`)

  // 像素一致性：同样内容分别用两种方式绘制后应逐字节相同
  const mk = (fn: typeof drawDigitOld) => {
    const canvas = createCanvas(img.width, img.height)
    const c = canvas.getContext('2d')
    c.drawImage(img, 0, 0)
    fn(c, 3, 40, 40, scale, 0.15)
    return canvas.toBuffer('image/png')
  }
  const a = mk(drawDigitOld)
  const b = mk(drawDigitNew)
  ok('两种绘制方式像素一致', a.equals(b), `${a.length} vs ${b.length} bytes`)

  // ── 4) 缩略图反和谐：JPEG@90（旧）vs WebP@80（新），按真实缩略图尺寸 250x350 ──
  const THUMB_W = 250
  const THUMB_H = 350
  const srcCanvas = createCanvas(THUMB_W, THUMB_H)
  srcCanvas.getContext('2d').drawImage(img, 0, 0, THUMB_W, THUMB_H)
  const small = Buffer.from(await srcCanvas.encode('webp', 75)) // 模拟 CDN 缩略图

  const antiOld = (buffer: Uint8Array) => processor.processor.applyAntiCensorship(buffer, 'jpeg', 90)
  await antiOld(small)
  await processor.processor.applyAntiCensorship(small, 'webp', 80)

  const thumbStartOld = process.hrtime.bigint()
  const oldThumb = await antiOld(small)
  const oldThumbMs = Number(process.hrtime.bigint() - thumbStartOld) / 1e6

  const thumbStartNew = process.hrtime.bigint()
  const newThumb = await processor.processor.applyAntiCensorship(small, 'webp', 80)
  const newThumbMs = Number(process.hrtime.bigint() - thumbStartNew) / 1e6

  console.log(`\n=== 缩略图反和谐 ${THUMB_W}x${THUMB_H}（原图 ${(small.length / 1024).toFixed(0)} KB）===`)
  console.log(`旧（JPEG@90）: ${oldThumbMs.toFixed(1)}ms -> ${(oldThumb.length / 1024).toFixed(0)} KB`)
  console.log(`新（WebP@80）: ${newThumbMs.toFixed(1)}ms -> ${(newThumb.length / 1024).toFixed(0)} KB`)
  console.log(`体积降至 ${((newThumb.length / oldThumb.length) * 100).toFixed(0)}%`)
  ok('缩略图体积明显下降', newThumb.length < oldThumb.length * 0.7, `${(newThumb.length / 1024).toFixed(0)}KB vs ${(oldThumb.length / 1024).toFixed(0)}KB`)

  // ── 5) 并发度扫描：确认处理吞吐的甜点 ──
  const runPool = async (workers: number) => {
    const queue = [...pages]
    let next = 0
    const started = Date.now()
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < queue.length) {
          const page = queue[next++]
          await convertImageForMode(processor.processor, page.buffer, page.extension, 'pdf', config)
        }
      }),
    )
    return Date.now() - started
  }

  await runPool(2)
  console.log(`\n=== 处理并发度扫描（${pages.length} 页）===`)
  let best = { workers: 0, ms: Number.POSITIVE_INFINITY }
  // 超过 UV_THREADPOOL_SIZE 的并发会让原生模块段错误崩溃，这里只扫安全区间
  for (const workers of [1, 2, 3, 4].filter((n) => n <= IMAGE_PROCESS_CONCURRENCY || n === 1)) {
    const ms = await runPool(workers)
    if (ms < best.ms) best = { workers, ms }
    console.log(
      `并发 ${workers}: ${ms}ms  ${(ms / pages.length).toFixed(0)}ms/页  ${(pages.length / (ms / 1000)).toFixed(1)} 页/秒`,
    )
  }
  console.log(`最快: 并发 ${best.workers} (${best.ms}ms)；当前常量 IMAGE_PROCESS_CONCURRENCY = ${IMAGE_PROCESS_CONCURRENCY}`)

  // ── 6) 端到端 PDF（新管线，含并发预处理）──
  const { rm } = await import('fs/promises')
  const stream = (async function* () {
    for (const page of pages) {
      yield { index: page.index, buffer: page.buffer, extension: page.extension, galleryId: 'bench', mediaId: 'bench' }
    }
  })()

  const tPdf = Date.now()
  const pdfPath = await processor.createPdf(stream, 'bench', () => {}, undefined)
  const pdfMs = Date.now() - tPdf
  const stat = await (await import('fs/promises')).stat(pdfPath)
  const raw = await (await import('fs/promises')).readFile(pdfPath)
  const pageCount = (raw.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length

  console.log(`\n=== 端到端 PDF（并发 ${IMAGE_PROCESS_CONCURRENCY}）===`)
  console.log(`耗时 ${pdfMs}ms (${(pdfMs / pages.length).toFixed(0)}ms/页), 体积 ${(stat.size / 1024 / 1024).toFixed(2)} MB`)
  ok('PDF 页数与输入一致', pageCount === pages.length, `${pageCount} / ${pages.length}`)
  await rm(pdfPath, { force: true }).catch(() => {})

  processor.dispose()
  process.exit(0)
}

// 与 constants 保持一致
import { IMAGE_PROCESS_CONCURRENCY } from '../src/constants'

main().catch((e) => {
  console.error('基准失败:', e)
  process.exit(1)
})
