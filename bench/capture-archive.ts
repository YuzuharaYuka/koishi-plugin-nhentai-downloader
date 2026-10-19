/**
 * 捕获一份官方压缩包作为离线校验样本
 *
 * 用法: NH_API_KEY=... npx tsx bench/capture-archive.ts [galleryId]
 */
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const GALLERY = process.argv[2] || '685699'
const UA = 'koishi-plugin-nhentai-downloader/2.1.2'
const KEY = process.env.NH_API_KEY

async function main() {
  if (!KEY) throw new Error('需要 NH_API_KEY')

  const meta = await (await fetch(`https://nhentai.net/api/v2/galleries/${GALLERY}/download?format=zip`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Authorization: `Key ${KEY}` },
  })).json() as any

  if (!meta?.url) throw new Error(`签发失败: ${JSON.stringify(meta).slice(0, 200)}`)

  console.log(`签名地址: ${meta.url.slice(0, 90)}...`)
  const response = await fetch(meta.url, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())

  const out = join(tmpdir(), `nh-${GALLERY}.zip`)
  await writeFile(out, buffer)
  console.log(`已保存 ${out}（${(buffer.length / 1024 / 1024).toFixed(2)} MB）`)
  process.exit(0)
}

main().catch((error) => {
  console.error('捕获失败:', error.message)
  process.exit(1)
})
