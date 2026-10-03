// ============================================================
// HTTP 传输层：统一走 Koishi 的 ctx.http
//
// 使用 ctx.http 而不是自带 HTTP 库的原因：
//   - 代理交给 Koishi 的 proxy-agent 插件处理（它在 http/fetch-init 里注入 dispatcher），
//     插件自身不必再实现代理解析；
//   - ctx.http 基于 undici/fetch，连接复用由全局 Agent 负责；
//   - 官方 API 只要求可识别的 User-Agent 与 API Key，并不需要浏览器指纹模拟。
// ============================================================
import { Context } from 'koishi'
import { createWriteStream } from 'fs'
import { rm } from 'fs/promises'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type {} from '@koishijs/plugin-http'
import type { Config } from '../config'
import { logger } from '../utils'
import { API_ORIGIN, ARCHIVE_STALL_TIMEOUT_MS, USER_AGENT } from '../constants'

export interface StreamDownloadOptions {
  timeoutMs: number
  /** 官方压缩包用作品页作为 Referer */
  referer?: string
  /** 传输停滞多久算超时（毫秒） */
  stallTimeoutMs?: number
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void
}

export class HttpManager {
  constructor(private ctx: Context, private config: Config) {}

  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    }
    // 官方鉴权：Authorization: Key <api_key>
    if (this.config.apiKey) headers.authorization = `Key ${this.config.apiKey}`
    return headers
  }

  private imageHeaders(referer?: string): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Referer: referer || `${API_ORIGIN}/`,
    }
  }

  /** 元数据请求，返回解析后的 JSON；HTTP 错误以 ctx.http 的 HTTPError 抛出 */
  async json<T>(url: string, options: { method?: 'GET' | 'POST'; timeoutMs: number }): Promise<T> {
    const response = await this.ctx.http<T>(url, {
      method: options.method ?? 'GET',
      headers: this.apiHeaders(),
      responseType: 'json',
      timeout: options.timeoutMs,
    })
    return response.data
  }

  /** 图片请求，校验 Content-Type 后返回 Buffer */
  async binary(url: string, options: { timeoutMs: number; referer?: string }): Promise<Buffer> {
    const response = await this.ctx.http<ArrayBuffer>(url, {
      headers: this.imageHeaders(options.referer),
      responseType: 'arraybuffer',
      timeout: options.timeoutMs,
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) {
      throw new Error(`返回的不是图片 (Content-Type: ${contentType || 'N/A'})`)
    }
    return Buffer.from(response.data)
  }

  /**
   * 流式下载到文件，返回写入的字节数。
   * ctx.http 的 timeout 是整体超时，这里额外用「停滞超时」兜住长时间无数据的连接。
   */
  async download(url: string, destPath: string, options: StreamDownloadOptions): Promise<number> {
    const controller = new AbortController()
    const stallTimeoutMs = options.stallTimeoutMs ?? ARCHIVE_STALL_TIMEOUT_MS
    let stallTimer: NodeJS.Timeout | null = null
    let received = 0

    const touch = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(
        () => controller.abort(new Error(`传输停滞超过 ${Math.round(stallTimeoutMs / 1000)}s`)),
        stallTimeoutMs,
      )
    }
    touch()

    try {
      const response = await this.ctx.http(url, {
        headers: this.imageHeaders(options.referer),
        responseType: 'stream',
        timeout: options.timeoutMs,
        signal: controller.signal,
      })
      const length = Number(response.headers.get('content-length'))
      const totalBytes = Number.isFinite(length) && length > 0 ? length : null

      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          touch()
          options.onProgress?.(received, totalBytes)
          callback(null, chunk)
        },
      })

      await pipeline(Readable.fromWeb(response.data as any), counter, createWriteStream(destPath))
      return received
    } catch (error) {
      await rm(destPath, { force: true }).catch(() => undefined)
      throw error
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
    }
  }

  dispose(): void {
    if (this.config.debug) logger.debug('HTTP 传输层已释放')
  }
}
