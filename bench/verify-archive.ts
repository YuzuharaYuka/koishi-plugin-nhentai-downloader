/**
 * 官方压缩包解析 / 解压 / 再打包校验（离线，使用已捕获的真实压缩包）
 *
 * 用法: npx tsx bench/verify-archive.ts <official.zip> [galleryId] [mediaId]
 */
import { listArchive, readArchiveImages, parseEntryName } from '../src/services/archive'
import { Processor, initCanvasProcessor } from '../src/processor'
import type { DownloadedImage } from '../src/processor'
import type { Config } from '../src/config'
import { createTestContext } from './harness'

const ARCHIVE = process.argv[2]
const GALLERY_ID = process.argv[3] || '685699'
const MEDIA_ID = process.argv[4] || '4222903'

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

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

async function main() {
  // 1) 命名解析
  ok('解析 1.webp', parseEntryName('1.webp').page === 1 && parseEntryName('1.webp').extension === 'webp')
  ok('解析 3.png', parseEntryName('3.png').page === 3 && parseEntryName('3.png').extension === 'png')
  ok('忽略 meta.json', parseEntryName('meta.json').isImage === false)
  ok('忽略 ComicInfo.xml', parseEntryName('ComicInfo.xml').isImage === false)
  ok('忽略目录层级中的路径', parseEntryName('dir/12.jpg').page === 12)

  // 2) 列目录
  const listing = await listArchive(ARCHIVE)
  console.log(`\n条目统计: 图片 ${listing.images.length} / 元数据 ${listing.metadata.length} / 其他 ${listing.others.length}`)
  ok('识别出 54 张图片', listing.images.length === 54, `${listing.images.length}`)
  ok('识别出 meta.json', listing.metadata.includes('meta.json'), listing.metadata.join(','))
  ok('meta.json 页数为 54', listing.meta?.num_pages === 54, JSON.stringify(listing.meta?.num_pages))
  ok(
    '图片已按页码升序排列',
    listing.images.every((entry, index) => index === 0 || listing.images[index - 1].page! < entry.page!),
    `前 5 个页码: ${listing.images.slice(0, 5).map((e) => e.page).join(',')} … 末位 ${listing.images[listing.images.length - 1].page}`,
  )
  const pngEntry = listing.images.find((entry) => entry.extension === 'png')
  ok('第 3 页扩展名为 png（与 CDN 一致）', pngEntry?.page === 3, `找到 page=${pngEntry?.page} ext=${pngEntry?.extension}`)

  for (const entry of listing.images.slice(0, 3)) {
    console.log(`   ${entry.name}  ${(entry.size / 1024).toFixed(0)} KB`)
  }

  // 3) 解压并校验索引/字节
  const images: { index: number; extension: string; size: number }[] = []
  let bytes = 0
  for await (const image of readArchiveImages(ARCHIVE, { expectedPages: 54 })) {
    images.push({ index: image.index, extension: image.extension, size: image.buffer.length })
    bytes += image.buffer.length
  }
  ok('解压出 54 张图片', images.length === 54, `${images.length}`)
  ok(
    '索引从 0 连续到 53',
    images.every((image, i) => image.index === i),
    `首=${images[0]?.index} 末=${images[images.length - 1]?.index}`,
  )
  ok('前缀索引指向原页码顺序', images[2].extension === 'png', `index 2 → ${images[2].extension}`)
  console.log(`解压总字节: ${(bytes / 1024 / 1024).toFixed(2)} MB`)

  // 4) 走真实的 PDF / ZIP 输出流程
  await initCanvasProcessor()
  const ctx = await createTestContext()
  const processor = new Processor(ctx, config)
  await processor.initializeCache()

  const toStream = () =>
    (async function* (): AsyncGenerator<DownloadedImage> {
      for await (const image of readArchiveImages(ARCHIVE, { expectedPages: 54 })) {
        yield {
          index: image.index,
          buffer: image.buffer,
          extension: image.extension,
          galleryId: GALLERY_ID,
          mediaId: MEDIA_ID,
        }
      }
    })()

  const t0 = Date.now()
  const pdfPath = await processor.createPdf(toStream(), GALLERY_ID, () => {}, undefined)
  const pdfMs = Date.now() - t0
  const pdfStat = await (await import('fs/promises')).stat(pdfPath)
  ok('压缩包 → PDF 成功', pdfStat.size > 100_000, `${(pdfStat.size / 1024 / 1024).toFixed(2)} MB, ${pdfMs}ms`)

  const t1 = Date.now()
  const zipBuffer = await processor.createZip(toStream(), undefined, 'verify')
  ok('压缩包 → 重新打包 ZIP 成功', zipBuffer.length > 100_000, `${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB, ${Date.now() - t1}ms`)

  const t2 = Date.now()
  const pdfEncPath = await processor.createPdf(toStream(), GALLERY_ID, () => {}, 'test-pass')
  ok('压缩包 → 加密 PDF 成功', !!pdfEncPath, `${Date.now() - t2}ms`)

  const { rm } = await import('fs/promises')
  await rm(pdfPath, { force: true }).catch(() => {})
  if (pdfEncPath) await rm(pdfEncPath, { force: true }).catch(() => {})
  processor.dispose()
  process.exit(0)
}

main().catch((e) => {
  console.error('校验失败:', e)
  process.exit(1)
})
