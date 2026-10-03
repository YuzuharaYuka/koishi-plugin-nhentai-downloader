/**
 * 用真实转换函数验证 PDF 内页的体积与耗时（离线）
 *
 * 用法: npx tsx bench/probe-pdf-edges.ts <official.zip>
 */
import { readArchiveImages } from '../src/services/archive'
import { convertImageForMode, pdfProcessVariant } from '../src/processors/images'
import { ensureCanvasLoaded, initCanvasProcessor } from '../src/processors/canvas-processor'
import type { Config } from '../src/config'

const ARCHIVE = process.argv[2]
const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

async function main() {
  await initCanvasProcessor()
  const processor = ensureCanvasLoaded()

  const pages: Array<{ index: number; buffer: Buffer; extension: string }> = []
  for await (const image of readArchiveImages(ARCHIVE, { expectedPages: 54 })) {
    pages.push({ index: image.index, buffer: image.buffer, extension: image.extension })
  }
  const sourceBytes = pages.reduce((sum, page) => sum + page.buffer.length, 0)
  console.log(`样本 ${pages.length} 页，源体积 ${MB(sourceBytes)}\n`)

  const variants: Array<[string, Partial<Config['imageCompression']>]> = [
    ['quality 85，不限制尺寸（默认）', { enabled: true, quality: 85, threshold: 500, maxEdge: 0 }],
    ['quality 85 + 长边 1600', { enabled: true, quality: 85, threshold: 500, maxEdge: 1600 }],
    ['quality 85 + 长边 1280', { enabled: true, quality: 85, threshold: 500, maxEdge: 1280 }],
    ['quality 75，不限制尺寸', { enabled: true, quality: 75, threshold: 500, maxEdge: 0 }],
    ['关闭压缩（webp 仍需转码）', { enabled: false, quality: 85, threshold: 500, maxEdge: 0 }],
  ]

  console.log('配置                            总体积    相对源   平均耗时  指纹')
  for (const [label, compression] of variants) {
    const config = { imageCompression: compression } as unknown as Config
    let bytes = 0
    const started = Date.now()
    for (const page of pages) {
      const result = await convertImageForMode(processor, page.buffer, page.extension, 'pdf', config)
      bytes += result.buffer.length
    }
    const ms = (Date.now() - started) / pages.length
    console.log(
      `${label.padEnd(30)} ${MB(bytes).padStart(9)} ${(((bytes - sourceBytes) / sourceBytes) * 100).toFixed(0).padStart(6)}%  ${ms.toFixed(0).padStart(6)}ms  ${pdfProcessVariant(config)}`,
    )
  }

  process.exit(0)
}

main().catch((error) => {
  console.error('实测失败:', error)
  process.exit(1)
})
