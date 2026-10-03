// ============================================================
// 官方打包压缩包（POST /api/v2/galleries/{id}/download）的解析
//
// 压缩包内容：`meta.json` + 逐页图片，图片名为「页码 + 原扩展名」（1.webp / 3.png …），
// cbz 还会多一个 ComicInfo.xml。下载本身由 services/http 负责。
// 端点细节见 docs/nhentai-api-v2.md。
// ============================================================
import { logger } from '../utils'
import { ARCHIVE_IMAGE_EXTENSIONS, ARCHIVE_METADATA_FILES } from '../constants'
import type { Readable } from 'stream'
import yauzl from 'yauzl'

export interface ArchiveEntryInfo {
  /** 压缩包内的完整条目名 */
  name: string
  /** 由文件名解析出的页码（从 1 开始）；无法解析时为 null */
  page: number | null
  /** 图片扩展名（不含点）；非图片条目为 null */
  extension: string | null
  size: number
  isImage: boolean
}

const IMAGE_EXTENSION_SET = new Set<string>(ARCHIVE_IMAGE_EXTENSIONS)
const METADATA_FILE_SET = new Set<string>(ARCHIVE_METADATA_FILES)

/** 取条目名中的文件名部分（忽略目录层级与 Windows 分隔符） */
function basename(name: string): string {
  const normalized = name.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || ''
}

/**
 * 解析条目名，得到页码与扩展名。
 * 官方命名是 `<页码>.<扩展名>`；若命名方式变化，page 为 null 时会退化为自然排序。
 */
export function parseEntryName(name: string): ArchiveEntryInfo {
  const base = basename(name)
  const info: ArchiveEntryInfo = { name, page: null, extension: null, size: 0, isImage: false }

  if (!base || name.endsWith('/')) return info
  if (METADATA_FILE_SET.has(base.toLowerCase())) return info

  const match = /^(\d+)\.([A-Za-z0-9]+)$/.exec(base)
  if (!match) return info
  const extension = `.${match[2].toLowerCase()}`
  if (!IMAGE_EXTENSION_SET.has(extension)) return info

  info.page = parseInt(match[1], 10)
  info.extension = extension.slice(1)
  info.isImage = true
  return info
}

/** 排序：优先按解析出的页码，缺失时退回名称的自然排序 */
function compareEntries(a: ArchiveEntryInfo, b: ArchiveEntryInfo): number {
  if (a.page !== null && b.page !== null && a.page !== b.page) return a.page - b.page
  if (a.page !== null && b.page === null) return -1
  if (a.page === null && b.page !== null) return 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error || !zipfile) reject(error || new Error('无法打开压缩包'))
      else resolve(zipfile)
    })
  })
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error || new Error(`无法读取条目 ${entry.fileName}`))
      else resolve(stream)
    })
  })
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export interface ArchiveMeta {
  id?: number
  num_pages?: number
  title?: { english?: string; japanese?: string }
}

export interface ArchiveListing {
  /** 已按页码排序的图片条目 */
  images: ArchiveEntryInfo[]
  /** 压缩包内出现的元数据文件 */
  metadata: string[]
  /** 非图片、非元数据的其他条目 */
  others: string[]
  /** meta.json 解析结果（若存在） */
  meta: ArchiveMeta | null
}

/** 列出压缩包内容并按页码排序（只读取 meta.json，不读取图片数据） */
export async function listArchive(filePath: string): Promise<ArchiveListing> {
  const zipfile = await openZip(filePath)
  const listing: ArchiveListing = { images: [], metadata: [], others: [], meta: null }

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject)
      zipfile.on('end', () => resolve())
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const info = parseEntryName(entry.fileName)
        info.size = entry.uncompressedSize
        const base = basename(entry.fileName).toLowerCase()

        if (METADATA_FILE_SET.has(base)) {
          listing.metadata.push(entry.fileName)
          if (base === 'meta.json') {
            // 顺带读取 meta.json，用于页数校验
            openEntryStream(zipfile, entry)
              .then(readStream)
              .then((buffer) => {
                try {
                  listing.meta = JSON.parse(buffer.toString('utf8')) as ArchiveMeta
                } catch {
                  listing.meta = null
                }
                zipfile.readEntry()
              })
              .catch(() => zipfile.readEntry())
            return
          }
        } else if (info.isImage) {
          listing.images.push(info)
        } else {
          listing.others.push(entry.fileName)
        }
        zipfile.readEntry()
      })
      zipfile.readEntry()
    })
  } finally {
    zipfile.close()
  }

  listing.images.sort(compareEntries)
  return listing
}

export interface ArchiveImage {
  index: number
  extension: string
  buffer: Buffer
  name: string
}

/**
 * 逐个产出压缩包中的页面图片。
 *
 * 官方压缩包的中央目录顺序就是页码升序（实测 1,2,…,54），因此可以直接流式产出，
 * 内存中始终只有一页；只有当顺序不单调时才退化为“全部读入 → 排序 → 产出”。
 */
export async function* readArchiveImages(
  filePath: string,
  options: { expectedPages?: number } = {},
): AsyncGenerator<ArchiveImage> {
  const listing = await listArchive(filePath)

  if (listing.images.length === 0) {
    throw new Error('压缩包中未找到任何页面图片')
  }
  if (listing.others.length > 0) {
    logger.warn(
      `压缩包中忽略了 ${listing.others.length} 个非图片条目: ${listing.others.slice(0, 5).join(', ')}`,
    )
  }

  const expected = options.expectedPages ?? listing.meta?.num_pages
  if (expected && listing.images.length !== expected) {
    logger.warn(`压缩包内图片数 ${listing.images.length} 与期望页数 ${expected} 不一致，以压缩包内容为准`)
  }
  const nonNumeric = listing.images.filter((entry) => entry.page === null).length
  if (nonNumeric > 0) {
    logger.warn(`有 ${nonNumeric} 个条目无法从文件名解析页码，将按名称自然排序`)
  }

  const wanted = new Map(listing.images.map((entry) => [entry.name, entry]))
  const zipfile = await openZip(filePath)
  const sortedByPage = listing.images.every(
    (entry, index) => index === 0 || compareEntries(listing.images[index - 1], entry) <= 0,
  )

  try {
    if (!sortedByPage) {
      // 罕见情况：中央目录顺序与页码不一致，先全部读入再排序
      logger.warn('压缩包条目顺序与页码不一致，将先完整解压再排序（峰值内存会升高）')
      const collected: ArchiveImage[] = []
      let index = 0
      await new Promise<void>((resolve, reject) => {
        zipfile.on('error', reject)
        zipfile.on('end', () => resolve())
        zipfile.on('entry', (entry: yauzl.Entry) => {
          const info = wanted.get(entry.fileName)
          if (!info) {
            zipfile.readEntry()
            return
          }
          openEntryStream(zipfile, entry)
            .then(readStream)
            .then((buffer) => {
              collected.push({ index: index++, extension: info.extension || 'webp', buffer, name: entry.fileName })
              zipfile.readEntry()
            })
            .catch(reject)
        })
        zipfile.readEntry()
      })
      collected.sort((a, b) => compareEntries(wanted.get(a.name)!, wanted.get(b.name)!))
      for (let i = 0; i < collected.length; i++) {
        yield { ...collected[i], index: i }
      }
      return
    }

    // 流式路径：一次只持有一页
    const queue: ArchiveImage[] = []
    let index = 0
    let producerDone = false
    let failure: Error | null = null
    let notify: (() => void) | null = null

    const wake = () => {
      const resolve = notify
      notify = null
      resolve?.()
    }

    const producer = new Promise<void>((resolve) => {
      const finish = (error?: Error) => {
        if (error) failure = error
        producerDone = true
        wake()
        resolve()
      }
      zipfile.on('error', (error) => finish(error))
      zipfile.on('end', () => finish())
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const info = wanted.get(entry.fileName)
        if (!info) {
          zipfile.readEntry()
          return
        }
        openEntryStream(zipfile, entry)
          .then(readStream)
          .then((buffer) => {
            queue.push({ index: index++, extension: info.extension || 'webp', buffer, name: entry.fileName })
            wake()
            zipfile.readEntry()
          })
          .catch((error) => finish(error as Error))
      })
      zipfile.readEntry()
    })

    while (true) {
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (failure) throw failure
      if (producerDone) break
      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }

    await producer
  } finally {
    zipfile.close()
  }
}
