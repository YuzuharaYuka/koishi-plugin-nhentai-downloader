/**
 * 渲染菜单样张到文件，便于肉眼比对排版与配色
 *
 * 用法: npx tsx bench/render-menu-sample.ts <输出目录> [quality]
 */
import { createCanvas, Image } from '@napi-rs/canvas'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { MenuGenerator } from '../src/services/menu-generator'
import type { Config } from '../src/config'

const OUT_DIR = process.argv[2] || '.'
const QUALITY = Number(process.argv[3] || 0)
const UA = 'koishi-plugin-nhentai-downloader/2.0.0'

const config = { menuMode: { columns: 3, maxRows: 3 }, debug: false } as unknown as Config

const TITLES = [
  '[Nyaa no Esa] Kanojo wa mada 18cm Ijou o Shiranai. | She has never experienced anything close to 18 cm. [English] [Comoop]',
  '[Tarobaumu] DeliHeal Kaa-chan 3 ~Daisuki na Kaa-chan to Yari Makuri Handousei Seikatsu~ [English]',
  '[Kamaboko Koubou (Kamaboko)] Isekai Saimin Oji-san ~Saimin Gift de Elf-tachi o Chinpohame~ [Chinese] [小黄个人汉化] [Digital]',
  '幼驯染与心上人 第2卷',
  '[hellaP] 도미나의 일탈 (Overwatch) (小羌寶個人漢化)',
  '[SERIOUS GRAPHICS (ICE)] Kokugo Kyoushi Maya Hibiki Dai Ni-wa [Chinese] [Amerins漢化] [Digital]',
  '[Arehoko] Onna Tomodachi-chan-tachi to Test Benkyou',
  '[Oden Ohgan (TuriSasu)] Holy Bitch 1 [English] [Rei Scans] [Digital]',
  '[TuriSasu] Ojou-sama Gakuen o Taigaku Shitakatta Chuusotsu Neet',
]
const JAPANESE = [
  '[にゃあのえさ] 彼女はまだ18cm以上を知らない。 [英訳]',
  '[たろバウム] デリヘルかーちゃん3〜大好きなかーちゃんとヤリまくり半同棲性活〜 [英訳]',
  '[カマボコ工房 (釜ボコ)] 異世界催眠おじさん [中国翻訳] [DL版]',
  '',
  '[葵抄]オサナナジミとカノジョと',
  '',
  '',
  '',
  '',
]

async function main() {
  // 用真实搜索结果出样张：缩略图与字段都走生产路径
  const search = (await (await fetch('https://nhentai.net/api/v2/search?query=language%3Achinese&page=1', {
    headers: { 'User-Agent': UA },
  })).json()) as any

  const items = search.result.slice(0, 9)
  const thumbs: Buffer[] = []
  const galleries: any[] = []
  for (const item of items) {
    const response = await fetch(`https://t1.nhentai.net/${item.thumbnail}`, { headers: { 'User-Agent': UA } })
    thumbs.push(Buffer.from(await response.arrayBuffer()))
    galleries.push(item)
  }
  console.log('样本:', items.map((i: any) => `${i.id}/${i.thumbnail_width}x${i.thumbnail_height}`).join(' '))

  const generator = new MenuGenerator(config, { columns: 3, maxRows: 3 })
  const png = await generator.generateMenu(galleries, thumbs, search.total ?? 1234, 0)
  await writeFile(join(OUT_DIR, 'menu-real.jpg'), png)
  console.log(`菜单: ${(png.length / 1024).toFixed(0)} KB -> menu-real.jpg`)

  // 缺图与坏图各一张，用于检查占位文字是否可见
  const brokenThumbs = [...thumbs]
  brokenThumbs[2] = Buffer.alloc(0)
  brokenThumbs[5] = Buffer.from('not an image at all')
  const broken = await generator.generateMenu(galleries, brokenThumbs, search.total ?? 1234, 0)
  await writeFile(join(OUT_DIR, 'menu-placeholder.jpg'), broken)
  console.log(`占位样张: ${(broken.length / 1024).toFixed(0)} KB -> menu-placeholder.jpg`)

  // 单独存一张缩略图，用于确认卡片上的文字是否来自图片本身
  await writeFile(join(OUT_DIR, 'thumb-0.webp'), thumbs[0])
  console.log(`样例缩略图: ${thumbs[0].length} bytes -> thumb-0.webp`)

  // 详情页样张：封面走 cover 路径（生产路径同样优先 cover）
  const detail = (await (await fetch(`https://nhentai.net/api/v2/galleries/${items[0].id}`, {
    headers: { 'User-Agent': UA },
  })).json()) as any
  const cover = await fetch(`https://t1.nhentai.net/${detail.cover.path}`, { headers: { 'User-Agent': UA } })
  const coverBuffer = Buffer.from(await cover.arrayBuffer())
  console.log(`详情封面: ${detail.cover.width}x${detail.cover.height} (${(coverBuffer.length / 1024).toFixed(0)} KB)`)
  const detailMenu = await generator.generateDetailMenu(
    {
      id: String(detail.id),
      media_id: detail.media_id,
      title: detail.title,
      images: { pages: [], cover: detail.cover, thumbnail: detail.thumbnail },
      scanlator: detail.scanlator || '小黄个人汉化',
      upload_date: detail.upload_date,
      tags: detail.tags,
      num_pages: detail.num_pages,
      num_favorites: detail.num_favorites,
    } as any,
    coverBuffer,
    true,
  )
  await writeFile(join(OUT_DIR, 'detail-real.jpg'), detailMenu)
  console.log(`详情: ${(detailMenu.length / 1024).toFixed(0)} KB -> detail-real.jpg`)

  process.exit(0)
}

main().catch((error) => { console.error('渲染失败:', error); process.exit(1) })
