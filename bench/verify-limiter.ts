/**
 * 限流器与并发闸门的确定性单元校验（不访问网络）
 */
import { Semaphore, SlidingWindowRateLimiter } from '../src/services/rate-limiter'

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

async function main() {
  // 1) 滑动窗口：limit=3 / 300ms
  const limiter = new SlidingWindowRateLimiter({ t: { limit: 3, windowMs: 300 } }, 1)
  const start = Date.now()
  await Promise.all(Array.from({ length: 3 }, () => limiter.acquire('t', 'test')))
  const inWindow = limiter.stats()
  ok('窗口内容纳前 3 次请求', inWindow[0].hitsInWindow === 3 && inWindow[0].limit === 3, JSON.stringify(inWindow))

  const t4 = Date.now()
  await limiter.acquire('t', 'test')
  const waited = Date.now() - t4
  ok('第 4 次请求被推迟到窗口滑出', waited >= 250, `等待 ${waited}ms，总计 ${Date.now() - start}ms`)
  ok('累计等待时间被记录', limiter.totalWaitMs > 0, `${limiter.totalWaitMs}ms / ${limiter.totalWaits} 次`)

  // 2) 安全系数：limit=10 × 0.9 → 9
  const scaled = new SlidingWindowRateLimiter({ s: { limit: 10, windowMs: 60_000 } }, 0.9)
  ok('安全系数生效（10 → 9）', scaled.effectiveLimit('s') === 9)

  // 3) 429 惩罚：penalize 后必须等到冷却结束（下限 1s）
  const penalized = new SlidingWindowRateLimiter({ p: { limit: 10, windowMs: 60_000 } }, 1)
  await penalized.acquire('p')
  penalized.penalize('p', 250)
  const t0 = Date.now()
  await penalized.acquire('p')
  ok('penalize 后请求被冻结', Date.now() - t0 >= 900, `等待 ${Date.now() - t0}ms`)

  // 4) 不同端点互不影响
  const multi = new SlidingWindowRateLimiter({ a: { limit: 1, windowMs: 5000 }, b: { limit: 1, windowMs: 5000 } }, 1)
  await multi.acquire('a')
  const tb = Date.now()
  await multi.acquire('b')
  ok('端点配额互相独立', Date.now() - tb < 50, `b 端点等待 ${Date.now() - tb}ms`)

  // 5) 未登记的端点不限制
  const t5 = Date.now()
  await multi.acquire('unknown')
  ok('未登记端点不限流', Date.now() - t5 < 20)

  // 6) 最小间隔（官方签发端点：连打必 429）
  const spacing = new SlidingWindowRateLimiter({ d: { limit: 5, windowMs: 60_000, minIntervalMs: 300 } }, 1)
  ok('首次 tryAcquire 成功', spacing.tryAcquire('d') === true)
  ok('最小间隔内 tryAcquire 被拒绝（不等待）', spacing.tryAcquire('d') === false)
  await new Promise((r) => setTimeout(r, 320))
  ok('超过最小间隔后 tryAcquire 成功', spacing.tryAcquire('d') === true)
  ok('冷却剩余时间为 0', spacing.cooldownRemaining('d') === 0)
  spacing.penalize('d', 400)
  ok('penalize 后冷却剩余时间 > 0', spacing.cooldownRemaining('d') > 300)

  // 7) 并发闸门：max=2 时同时进入的请求不超过 2
  const gate = new Semaphore(2)
  let concurrent = 0
  let peak = 0
  await Promise.all(
    Array.from({ length: 8 }, () =>
      gate.run(async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await new Promise((r) => setTimeout(r, 20))
        concurrent--
      }),
    ),
  )
  ok('Semaphore 限制峰值并发', peak === 2, `峰值 ${peak}`)
  ok('Semaphore 全部释放', gate.inFlight === 0 && gate.pending === 0, `inFlight=${gate.inFlight} pending=${gate.pending}`)

  console.log('\n限流器 / 并发闸门校验完成')
  process.exit(0)
}

main().catch((e) => {
  console.error('校验失败:', e)
  process.exit(1)
})
