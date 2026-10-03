// ============================================================
// 客户端限流与并发控制
//
// nhentai API v2 不返回 X-RateLimit-* / Retry-After 之类的配额响应头，
// 429 只会在超限后被动返回（且会被 Cloudflare 记录）。
// 因此必须依据文档中按端点公布的配额在客户端主动节流。
// ============================================================
import { logger, sleep } from '../utils'
import type { RateLimitKey, RateLimitRule } from '../constants'

interface WindowState {
  /** 窗口内已发起的请求时间戳（升序） */
  hits: number[]
  /** 被 429 惩罚后的解禁时间 */
  blockedUntil: number
  /** 最近一次成功取得配额的时间（用于最小间隔） */
  lastHit: number
}

export interface RateLimiterStats {
  key: string
  hitsInWindow: number
  limit: number
  blockedForMs: number
}

/**
 * 滑动窗口限流器。
 *
 * 每个端点独立计数；携带 API Key 时使用文档中更高的一档配额。
 * acquire() 在配额耗尽时挂起等待，直到窗口内最早的请求滑出。
 */
export class SlidingWindowRateLimiter {
  private states = new Map<string, WindowState>()
  private waitCount = 0
  private waitedMs = 0

  constructor(
    private rules: Record<string, RateLimitRule>,
    private safetyFactor = 0.9,
  ) {}

  private state(key: string): WindowState {
    let state = this.states.get(key)
    if (!state) {
      state = { hits: [], blockedUntil: 0, lastHit: 0 }
      this.states.set(key, state)
    }
    return state
  }

  /** 实际生效的配额（向下取整并留出安全余量） */
  effectiveLimit(key: string): number {
    const rule = this.rules[key]
    if (!rule) return Infinity
    return Math.max(1, Math.floor(rule.limit * this.safetyFactor))
  }

  /**
   * 申请一次请求配额；返回时即代表可以立即发起请求。
   * 检查与计数在同一同步块内完成，因此并发调用不会超发。
   */
  async acquire(key: string, label?: string): Promise<void> {
    const rule = this.rules[key]
    if (!rule) return

    const limit = this.effectiveLimit(key)
    const state = this.state(key)
    let announced = false

    for (;;) {
      const now = Date.now()

      // 1. 429 惩罚期
      if (state.blockedUntil > now) {
        if (!announced) {
          logger.warn(
            `[限流] ${label || key} 处于 429 冷却中，等待 ${Math.ceil((state.blockedUntil - now) / 1000)}s`,
          )
          announced = true
        }
        const wait = state.blockedUntil - now + 5
        this.waitedMs += wait
        await sleep(wait)
        continue
      }

      // 2. 最小间隔（官方签发这类端点“连打必 429”）
      const interval = rule.minIntervalMs ?? 0
      if (interval > 0 && state.lastHit > 0) {
        const since = now - state.lastHit
        if (since < interval) {
          const wait = interval - since
          if (!announced) {
            this.waitCount++
            logger.debug(`[限流] ${label || key} 距上次请求不足 ${interval / 1000}s，等待 ${(wait / 1000).toFixed(1)}s`)
            announced = true
          }
          this.waitedMs += wait
          await sleep(wait)
          continue
        }
      }

      // 3. 滑出窗口的历史请求
      const cutoff = now - rule.windowMs
      let expired = 0
      while (expired < state.hits.length && state.hits[expired] <= cutoff) expired++
      if (expired > 0) state.hits.splice(0, expired)

      // 4. 配额检查
      if (state.hits.length < limit) {
        state.hits.push(now)
        state.lastHit = now
        return
      }

      const waitMs = state.hits[0] + rule.windowMs - now + 5
      if (!announced) {
        this.waitCount++
        const message = `[限流] ${label || key} 已达官方配额（${limit}/${rule.windowMs / 1000}s），需等待 ${(waitMs / 1000).toFixed(1)}s`
        // 等待时间较长时提升日志级别，避免用户面对“无响应”的错觉
        if (waitMs > 3000) logger.warn(message)
        else logger.debug(message)
        announced = true
      }
      this.waitedMs += waitMs
      await sleep(waitMs)
    }
  }

  /** 收到 429 后按 Retry-After（或默认退避）冻结该端点 */
  penalize(key: string, retryAfterMs: number): void {
    const state = this.state(key)
    const until = Date.now() + Math.max(1000, retryAfterMs)
    if (until > state.blockedUntil) state.blockedUntil = until
  }

  /**
   * 尝试立即取得配额：无配额或处于冷却时返回 false 且不等待。
   * 供“可选、可降级”的请求使用（例如官方打包直链签发），避免把用户卡住数分钟。
   */
  tryAcquire(key: string): boolean {
    const rule = this.rules[key]
    if (!rule) return true

    const state = this.state(key)
    const now = Date.now()
    if (state.blockedUntil > now) return false

    const interval = rule.minIntervalMs ?? 0
    if (interval > 0 && state.lastHit > 0 && now - state.lastHit < interval) return false

    const cutoff = now - rule.windowMs
    let expired = 0
    while (expired < state.hits.length && state.hits[expired] <= cutoff) expired++
    if (expired > 0) state.hits.splice(0, expired)

    if (state.hits.length >= this.effectiveLimit(key)) return false
    state.hits.push(now)
    state.lastHit = now
    return true
  }

  /** 距离解除冷却还剩多少毫秒（无冷却返回 0） */
  cooldownRemaining(key: string): number {
    const state = this.states.get(key)
    if (!state) return 0
    return Math.max(0, state.blockedUntil - Date.now())
  }

  stats(): RateLimiterStats[] {
    const now = Date.now()
    return [...this.states.entries()].map(([key, state]) => {
      const rule = this.rules[key]
      const cutoff = now - (rule?.windowMs ?? 60_000)
      return {
        key,
        hitsInWindow: state.hits.filter((t) => t > cutoff).length,
        limit: this.effectiveLimit(key),
        blockedForMs: Math.max(0, state.blockedUntil - now),
      }
    })
  }

  get totalWaits(): number {
    return this.waitCount
  }

  /** 因配额限制累计等待的毫秒数 */
  get totalWaitMs(): number {
    return this.waitedMs
  }

  reset(): void {
    this.states.clear()
    this.waitCount = 0
    this.waitedMs = 0
  }
}

/**
 * 并发闸门（信号量）。
 *
 * 用应用层并发控制替代 http.Agent 的 maxSockets：
 * 后者要求自建 Agent，会让请求绕过运行时（Node 24 环境变量代理等）配置的全局 Agent。
 */
export class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(private max: number) {
    this.max = Math.max(1, max)
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    // 名额由 release() 直接移交，这里不再自增
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // 名额移交给等待者，active 保持不变
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  get inFlight(): number {
    return this.active
  }

  get pending(): number {
    return this.waiters.length
  }

  /** 释放所有等待者（插件卸载时使用） */
  drain(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }
}

export type { RateLimitKey }
