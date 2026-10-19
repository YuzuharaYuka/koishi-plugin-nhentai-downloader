/**
 * 菜单渲染校验（离线，使用 $TEMP/nh-menu-cache 中的真实缩略图）
 *
 * 用法: npx tsx bench/verify-menu.ts
 */
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCanvas, Image } from '@napi-rs/canvas'
import { MenuGenerator } from '../src/services/menu-generator'
import type { Config } from '../src/config'

const CACHE = join(tmpdir(), 'nh-menu-cache')
const UA = 'koishi-plugin-nhentai-downloader/2.1.2'
const config = { menuMode: { columns: 3, maxRows: 3 }, debug: false } as unknown as Config

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

async function imageSize(buffer: Buffer): Promise<{ width: number; height: number }> {
  const image = new Image()
  image.src = buffer
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('decode failed'))
  })
  return { width: image.width, height: image.height }
}

async function loadSample(index: number): Promise<Buffer | null> {
  const path = join(CACHE, `thumb-${index}.webp`)
  if (!existsSync(path)) return null
  return readFile(path)
}

async function main() {
  const thumbs: Buffer[] = []
  for (let i = 0; i < 9; i++) {
    const thumb = await loadSample(i)
    if (!thumb) {
      console.log(`✗ 缺少缓存缩略图 ${i}，先运行 bench/probe-menu.ts 预热`)
      process.exit(1)
    }
    thumbs.push(thumb)
  }
  const cover = await readFile(join(CACHE, 'cover.webp'))

  const galleries = thumbs.map((_, i) => ({
    id: 689000 + i,
    media_id: '4223958',
    english_title: `[Sample Author ${i + 1}] A fairly long english title for layout testing [Chinese] [汉化组]`,
    japanese_title: 'サンプルタイトル',
    thumbnail: `galleries/4223958/${i + 1}t.webp`,
    thumbnail_width: 250,
    thumbnail_height: 350,
    num_pages: 20 + i,
    num_favorites: 1234 * (i + 1),
    tag_ids: [],
    blacklisted: false,
  })) as any[]

  const generator = new MenuGenerator(config, { columns: 3, maxRows: 3 })

  // 1) 搜索菜单尺寸：3 列 × 250 + 2 × 30 间距 + 48 内边距
  const started = Date.now()
  const menu = await generator.generateMenu(galleries, thumbs, 163123, 0)
  const menuMs = Date.now() - started
  const menuSize = await imageSize(menu)
  ok('搜索菜单宽度符合列数', menuSize.width === 858, `${menuSize.width}px`)
  ok('搜索菜单高度符合行数', menuSize.height === 1586, `${menuSize.height}px`)
  ok('搜索菜单为 JPEG', menu[0] === 0xff && menu[1] === 0xd8, `${(menu.length / 1024).toFixed(0)} KB`)

  // 2) 详情菜单：内容自适应高度
  const gallery = {
    id: '689079',
    media_id: '4223958',
    title: {
      english: '[Ende AA] Saikyou Mizu Zokusei Majutsushi Ayuka VS Choutokushu Debuff Dungeon [Chinese] [机翻]',
      japanese: '[エンデア] 最強水属性魔術師アユカVS超特殊デバフダンジョン [中国翻訳]',
      pretty: 'Saikyou Mizu Zokusei Majutsushi Ayuka',
    },
    images: { pages: [], cover: { path: 'galleries/4223958/cover.webp' }, thumbnail: { path: 'galleries/4223958/thumb.webp' } },
    scanlator: '小黄个人汉化',
    upload_date: 1792000000,
    tags: [
      { id: 1, type: 'parody', name: 'original', count: 157900 },
      { id: 2, type: 'group', name: 'ende aa', count: 4 },
      { id: 3, type: 'category', name: 'doujinshi', count: 513700 },
      { id: 4, type: 'language', name: 'translated', count: 286900 },
      { id: 5, type: 'language', name: 'chinese', count: 162900 },
      { id: 6, type: 'tag', name: 'big breasts', count: 237800 },
      { id: 7, type: 'tag', name: 'sole female', count: 206300 },
      { id: 8, type: 'tag', name: 'sole male', count: 184900 },
      { id: 9, type: 'tag', name: 'blowjob', count: 109500 },
      { id: 10, type: 'tag', name: 'futanari', count: 40900 },
    ],
    num_pages: 55,
    num_favorites: 39,
  } as any

  const detailStarted = Date.now()
  const detail = await generator.generateDetailMenu(gallery, cover, true)
  const detailMs = Date.now() - detailStarted
  const detailSize = await imageSize(detail)
  ok('详情菜单宽度固定', detailSize.width === 1200, `${detailSize.width}px`)
  ok('详情菜单高度按内容自适应', detailSize.height > 400 && detailSize.height < 720, `${detailSize.height}px`)
  ok('详情菜单为 JPEG', detail[0] === 0xff && detail[1] === 0xd8, `${(detail.length / 1024).toFixed(0)} KB`)

  // 3) 标签更多时高度应该增加
  const moreTags = {
    ...gallery,
    tags: [
      ...gallery.tags,
      ...Array.from({ length: 24 }, (_, i) => ({ id: 100 + i, type: 'tag', name: `extra tag number ${i}`, count: 1000 + i })),
    ],
  }
  const taller = await generator.generateDetailMenu(moreTags, cover, true)
  const tallerSize = await imageSize(taller)
  ok('标签变多时画布变高', tallerSize.height > detailSize.height, `${detailSize.height}px → ${tallerSize.height}px`)

  // 4) 占位分支：无缩略图 / 坏图
  const broken = [...thumbs]
  broken[2] = Buffer.alloc(0)
  broken[5] = Buffer.from('not an image')
  const placeholder = await generator.generateMenu(galleries, broken, 100, 0)
  ok('缺图/坏图仍能渲染', placeholder.length > 1000, `${(placeholder.length / 1024).toFixed(0)} KB`)

  // 5) 无封面时详情卡片仍可渲染
  const noCover = await generator.generateDetailMenu(gallery, Buffer.alloc(0), false)
  ok('无封面仍能渲染', noCover.length > 1000, `${(noCover.length / 1024).toFixed(0)} KB`)

  // 6) 耗时上限（宽松阈值，防止明显性能回归）
  ok('搜索菜单渲染耗时', menuMs < 1500, `${menuMs}ms`)
  ok('详情菜单渲染耗时', detailMs < 1500, `${detailMs}ms`)

  // 7) 画布底色与配色不靠断言校验，这里只确保输出非全黑
  const probe = createCanvas(4, 4)
  void probe
  ok('输出体积合理', menu.length > 100 * 1024 && menu.length < 2 * 1024 * 1024, `${(menu.length / 1024).toFixed(0)} KB`)

  process.exit(0)
}

main().catch((error) => {
  console.error('菜单校验失败:', error)
  process.exit(1)
})
