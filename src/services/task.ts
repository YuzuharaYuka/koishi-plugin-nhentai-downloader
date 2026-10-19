/**
 * 下载任务注册表。
 *
 * 以「平台:频道:用户」为键记录进行中的任务，供 `nh.cancel` 取消；
 * 同时暂存最近一次逐张下载失败的页码，供 `nh.retry` 只补下失败的那几页。
 */
export const CANCELLED = '已取消'

export class TaskCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'TaskCancelledError'
  }
}

export class DownloadTask {
  readonly startedAt = Date.now()
  readonly controller = new AbortController()
  cancelled = false

  constructor(
    readonly key: string,
    readonly galleryId: string,
    readonly outputType: 'pdf' | 'zip' | 'img',
    readonly pageCount: number,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.controller.abort()
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new TaskCancelledError()
  }
}

interface FailedRecord {
  galleryId: string
  indexes: number[]
  at: number
}

/** 失败记录保留多久，超过后 `nh.retry` 视为无可用记录 */
const FAILED_TTL_MS = 30 * 60 * 1000

export class TaskStore {
  private tasks = new Map<string, DownloadTask>()
  private failed = new Map<string, FailedRecord>()

  /** 开始一个任务；同键已有任务时先取消旧的 */
  start(key: string, galleryId: string, outputType: 'pdf' | 'zip' | 'img', pageCount: number): DownloadTask {
    this.tasks.get(key)?.cancel()
    const task = new DownloadTask(key, galleryId, outputType, pageCount)
    this.tasks.set(key, task)
    return task
  }

  get(key: string): DownloadTask | undefined {
    return this.tasks.get(key)
  }

  /** 取消进行中的任务，返回被取消的任务（没有则 undefined） */
  cancel(key: string): DownloadTask | undefined {
    const task = this.tasks.get(key)
    if (!task) return undefined
    task.cancel()
    return task
  }

  finish(key: string, task: DownloadTask): void {
    if (this.tasks.get(key) === task) this.tasks.delete(key)
  }

  /** 记录失败页，供重试使用 */
  setFailed(key: string, galleryId: string, indexes: number[]): void {
    if (indexes.length === 0) {
      this.failed.delete(key)
      return
    }
    this.failed.set(key, { galleryId, indexes: [...indexes].sort((a, b) => a - b), at: Date.now() })
  }

  /** 取出失败记录（不过期则保留，便于重复重试） */
  takeFailed(key: string): FailedRecord | undefined {
    const record = this.failed.get(key)
    if (!record) return undefined
    if (Date.now() - record.at > FAILED_TTL_MS) {
      this.failed.delete(key)
      return undefined
    }
    return record
  }

  clearFailed(key: string): void {
    this.failed.delete(key)
  }
}
