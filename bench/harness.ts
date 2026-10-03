/**
 * 校验脚本共用的最小上下文。
 *
 * 插件只用到 ctx.http 与 ctx.app.baseDir，因此这里起一个裸 Context
 * 挂上 Koishi 的 http 服务即可，不需要完整的 App。
 */
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'

export async function createTestContext(baseDir = process.cwd()): Promise<any> {
  const ctx = new Context()
  ctx.plugin(HTTP)
  // 等 http 服务注册完成
  await new Promise((resolve) => setTimeout(resolve, 200))
  return { app: { baseDir }, baseDir, http: (ctx as any).http }
}
