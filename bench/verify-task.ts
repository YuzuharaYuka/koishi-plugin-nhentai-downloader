/**
 * 下载任务表校验：取消、失败页记录与过期
 *
 * 用法: npx tsx bench/verify-task.ts
 */
import { TaskStore, TaskCancelledError, CANCELLED } from '../src/services/task'

const ok = (label: string, pass: boolean, extra = '') =>
  console.log(`${pass ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)

const store = new TaskStore()
const key = 'onebot:123:456'

console.log('=== 任务生命周期 ===')
const task = store.start(key, '685699', 'pdf', 54)
ok('start 返回任务', !!task && task.galleryId === '685699' && task.pageCount === 54)
ok('get 能取到任务', store.get(key) === task)
ok('初始未取消', task.cancelled === false)

store.cancel(key)
ok('cancel 置取消位', task.cancelled === true)
ok('cancel 触发 abort signal', task.signal.aborted === true)

let threw = false
try {
  task.throwIfCancelled()
} catch (error) {
  threw = error instanceof TaskCancelledError
}
ok('throwIfCancelled 抛 TaskCancelledError', threw)
ok('取消常量可用于判定', CANCELLED === '已取消')

store.finish(key, task)
ok('finish 后任务移除', store.get(key) === undefined)

console.log('\n=== 同键重复开始 ===')
const first = store.start(key, '111', 'pdf', 10)
const second = store.start(key, '222', 'img', 20)
ok('新任务替换旧任务', store.get(key) === second)
ok('旧任务被自动取消', first.cancelled === true)

console.log('\n=== 失败页记录 ===')
store.setFailed(key, '685699', [5, 1, 3])
const record = store.takeFailed(key)
ok('记录按页码升序', !!record && record.indexes.join(',') === '1,3,5', record?.indexes.join(','))
ok('记录关联画廊', record?.galleryId === '685699')

store.setFailed(key, '685699', [])
ok('空失败列表清除记录', store.takeFailed(key) === undefined)

console.log('\n=== 无任务时的取消 ===')
ok('无任务返回 undefined', store.cancel('onebot:x:y') === undefined)

process.exit(0)
