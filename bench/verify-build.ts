/**
 * 构建产物冒烟测试：直接加载 lib/index.js（即发包内容），验证插件能初始化。
 *
 * 用法: npx tsx bench/verify-build.ts
 */
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

async function main() {
  const plugin = require('../lib/index.js')

  ok('导出 name（短名）', plugin.name === 'nhentai-downloader', plugin.name)
  ok('导出 inject.http', Array.isArray(plugin.inject?.required) && plugin.inject.required.includes('http'))
  ok('导出 usage', typeof plugin.usage === 'string' && plugin.usage.includes('nh.search'))
  ok('导出 Config schema', typeof plugin.Config === 'function' || typeof plugin.Config === 'object')
  ok('导出 apply', typeof plugin.apply === 'function')

  // 真实初始化：会依次加载 canvas、创建缓存目录、注册指令
  const baseDir = await mkdtemp(join(tmpdir(), 'nh-build-'))
  const ctx = new Context()
  ctx.plugin(HTTP)
  await new Promise((resolve) => setTimeout(resolve, 300))
  ;(ctx as any).app = { baseDir }

  const logs: string[] = []
  ctx.on('logger', () => {})
  const originalLog = console.log
  void originalLog

  const errors: string[] = []
  process.on('unhandledRejection', (reason) => errors.push(String(reason)))

  ctx.plugin(plugin, {
    apiKey: '',
    downloadPath: './data/temp/nhentai-downloader',
    cache: { enableApiCache: false, enableImageCache: false, enablePdfCache: false },
  } as any)
  await new Promise((resolve) => setTimeout(resolve, 4000))

  ok('初始化无未捕获异常', errors.length === 0, errors.join(' | '))

  // 指令注册代码确实进了产物（不依赖 Koishi 内部 API）
  const bundle = require('fs').readFileSync(join(__dirname, '..', 'lib/index.js'), 'utf8')
  for (const [label, needle] of [
    ['nh.search 指令', '按关键词或作品 ID 搜索'],
    ['nh.download 指令', 'nh下载'],
    ['nh.popular 指令', 'nh热门'],
    ['nh.random 指令', 'nh随机'],
    ['usage 文本', 'nhentai'],
  ] as Array<[string, string]>) {
    ok(`产物包含${label}`, bundle.includes(needle))
  }

  // 动态导入路径可用性：这些依赖在运行时按需 import，打包后必须仍能解析
  for (const mod of ['archiver', 'archiver-zip-encrypted', 'pdfkit', 'yauzl', '@napi-rs/canvas']) {
    let loaded = false
    try {
      require.resolve(mod, { paths: [join(__dirname, '..')] })
      loaded = true
    } catch {
      loaded = false
    }
    ok(`依赖可解析: ${mod}`, loaded)
  }

  await ctx.stop().catch(() => {})
  await rm(baseDir, { recursive: true, force: true }).catch(() => {})
  void logs
  process.exit(0)
}

main().catch((error) => {
  console.error('冒烟测试失败:', error)
  process.exit(1)
})
