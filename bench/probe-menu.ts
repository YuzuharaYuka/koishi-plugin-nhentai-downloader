/**
 * 菜单渲染基准（离线，使用真实缩略图/封面缓存）
 *
 * 用法: npx tsx bench/probe-menu.ts [刷新缓存]
 */
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MenuGenerator } from '../src/services/menu-generator'
import type { Config } from '../src/config'

const CACHE = join(tmpdir(), 'nh-menu-cache')
const UA = 'koishi-plugin-nhentai-downloader/2.1.2'
const config = { menuMode: { columns: 3, maxRows: 3 }, debug: false } as unknown as Config

async function fetchCached(url: string, file: string): Promise<Buffer> {
  const path = join(CACHE, file)
  if (!existsSync(path)) {
    const response = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!response.ok) throw new Error(`${response.status} ${url}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(path, buffer)
    return buffer
  }
  return readFile(path)
}

async function main() {
  await mkdir(CACHE, { recursive: true })

  const search = (await (await fetch('https://nhentai.net/api/v2/search?query=language%3Achinese&page=1', {
    headers: { 'User-Agent': UA },
  })).json()) as any
  const items = search.result.slice(0, 9)

  const thumbs: Buffer[] = []
  for (let i = 0; i < items.length; i++) {
    thumbs.push(await fetchCached(`https://t1.nhentai.net/${items[i].thumbnail}`, `thumb-${i}.webp`))
  }

  const detail = (await (await fetch(`https://nhentai.net/api/v2/galleries/${items[0].id}`, {
    headers: { 'User-Agent': UA },
  })).json()) as any
  const cover = await fetchCached(`https://t1.nhentai.net/${detail.cover.path}`, 'cover.webp')

  const generator = new MenuGenerator(config, { columns: 3, maxRows: 3 })

  // 预热（首帧有 canvas 初始化开销）
  await generator.generateMenu(items, thumbs, search.total ?? 1000, 0)

  const time = async (label: string, times: number, run: () => Promise<Buffer>) => {
    const started = Date.now()
    let size = 0
    for (let i = 0; i < times; i++) size = (await run()).length
    const ms = (Date.now() - started) / times
    console.log(`  ${label.padEnd(26)} ${ms.toFixed(0).padStart(4)}ms  ${(size / 1024).toFixed(0).padStart(4)} KB`)
    return { ms, size }
  }

  console.log('=== 搜索结果菜单（9 张缩略图）===')
  for (let i = 0; i < 3; i++) await time(`第 ${i + 1} 轮`, 3, () => generator.generateMenu(items, thumbs, search.total ?? 1000, 0))

  console.log('\n=== 详情菜单 ===')
  const galleryArg = {
    id: String(detail.id),
    media_id: detail.media_id,
    title: detail.title,
    images: { pages: [], cover: detail.cover, thumbnail: detail.thumbnail },
    scanlator: detail.scanlator || '小黄个人汉化',
    upload_date: detail.upload_date,
    tags: detail.tags,
    num_pages: detail.num_pages,
    num_favorites: detail.num_favorites,
  } as any
  for (let i = 0; i < 3; i++) await time(`第 ${i + 1} 轮`, 3, () => generator.generateDetailMenu(galleryArg, cover, true))

  console.log('\n=== 仅编码（同一画布，不同质量）===')
  const { createCanvas } = await import('@napi-rs/canvas')
  const probe = createCanvas(1200, 720)
  const pctx = probe.getContext('2d')
  pctx.fillStyle = '#1a1a1a'
  pctx.fillRect(0, 0, 1200, 720)
  const { Image } = await import('@napi-rs/canvas')
  const img = new Image()
  img.src = cover
  await new Promise<void>((resolve) => { img.onload = () => resolve() })
  pctx.drawImage(img, 40, 40, 350, 490)
  for (const quality of [95, 92, 90, 88, 84]) {
    const started = Date.now()
    const out = Buffer.from(await probe.encode('jpeg', quality))
    console.log(`  q${quality}  ${((Date.now() - started)).toFixed(0).padStart(4)}ms  ${(out.length / 1024).toFixed(0).padStart(4)} KB`)
  }

  console.log('\n=== 缩略图水印开销（逐张）===')
  const { ensureCanvasLoaded } = await import('../src/processors/canvas-processor')
  const { applyAntiGzip } = await import('../src/processors/images')
  const processor = ensureCanvasLoaded()
  const antiConfig = { antiGzip: { enabled: true }, debug: false } as unknown as Config
  const started = Date.now()
  let bytes = 0
  for (const thumb of thumbs) {
    const result = await applyAntiGzip(processor, thumb, antiConfig, 'bench', 'webp', 80)
    bytes += result.buffer.length
  }
  console.log(`  9 张合计 ${Date.now() - started}ms，输出 ${(bytes / 1024).toFixed(0)} KB（原始 ${(thumbs.reduce((s, t) => s + t.length, 0) / 1024).toFixed(0)} KB）`)

  process.exit(0)
}

main().catch((error) => {
  console.error('基准失败:', error)
  process.exit(1)
})
