// ZIP 生成模块，负责创建和加密 ZIP 压缩文件
import { PassThrough } from 'stream'
import { DownloadedImage } from './types'
import { GC_TRIGGER_INTERVAL } from '../constants'
import { logger } from '../utils'

// 延迟加载 archiver 及其加密格式（避免在模块初始化时加载）
let archiverModule: any = null
let isArchiverInitialized = false

async function ensureArchiverInitialized() {
  if (!isArchiverInitialized) {
    try {
      archiverModule = await import('archiver')
      const archiverZipEncrypted = await import('archiver-zip-encrypted')
      // 注册加密 ZIP 格式（仅在未注册时注册，避免热重载时重复注册）
      try {
        archiverModule.default.registerFormat('zip-encrypted', archiverZipEncrypted.default)
      } catch {
        // 格式已注册，忽略错误
      }
      isArchiverInitialized = true
    } catch (error) {
      throw new Error(`Failed to load archiver: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return archiverModule.default
}

export async function createZip(
  imageStream: AsyncIterable<DownloadedImage>,
  password: string | undefined,
  imageCompressionEnabled: boolean,
  folderName?: string,
): Promise<Buffer> {
  // 类型守卫：验证密码类型
  if (password !== undefined && typeof password !== 'string') {
    throw new TypeError(`无效的密码类型: ${typeof password}`)
  }

  // 延迟加载 archiver（仅在需要时加载）
  const archiver = await ensureArchiverInitialized()

  // 简化条件表达式：直接判断 password 是否为 truthy
  const format = password ? 'zip-encrypted' : 'zip'

  // 智能压缩策略：图片已压缩则用存储模式，否则用标准压缩
  const compressionLevel = imageCompressionEnabled ? 0 : 6

  // 配置压缩选项和加密参数
  const archiveOptions: any = {
    zlib: { level: compressionLevel },
  }
  if (password) {
    archiveOptions.encryptionMethod = 'aes256'
    archiveOptions.password = password
  }

  const zip = archiver(format, archiveOptions)
  const stream = new PassThrough()
  const buffers: Buffer[] = []

  stream.on('data', (chunk) => buffers.push(chunk))
  // 收集流数据并在完成时返回缓冲区
  const archivePromise = new Promise<Buffer>((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(buffers)))
    zip.on('error', reject)
    stream.on('error', reject)
  })

  zip.pipe(stream)

  // 异步处理图片流并添加到 ZIP
  ;(async () => {
    try {
      let nextPageNum = 0
      let skippedCount = 0
      // 临时缓存用于保持页面顺序
      const pageBuffer = new Map<number, { buffer: Buffer; extension: string }>()

      for await (const { index, buffer, extension } of imageStream) {
        // 容错处理：跳过无效 buffer 而不是终止整个流程
        if (!Buffer.isBuffer(buffer)) {
          logger.warn(`[ZIP] 第 ${index + 1} 张图片类型无效 (${typeof buffer})，已跳过`)
          skippedCount++
          continue
        }
        if (buffer.length === 0) {
          logger.warn(`[ZIP] 第 ${index + 1} 张图片为空 (0 bytes)，已跳过`)
          skippedCount++
          continue
        }

        pageBuffer.set(index, { buffer, extension })

        // 按顺序将图片写入 ZIP，确保页面编号连续
        while (pageBuffer.has(nextPageNum)) {
          const { buffer: img, extension: ext } = pageBuffer.get(nextPageNum)!
          pageBuffer.delete(nextPageNum)
          const pageNum = (nextPageNum + 1).toString().padStart(3, '0')
          const fileName = folderName ? `${folderName}/${pageNum}.${ext}` : `${pageNum}.${ext}`
          zip.append(img, { name: fileName })
          nextPageNum++

          if (nextPageNum % GC_TRIGGER_INTERVAL === 0 && global.gc) global.gc() // 定期触发垃圾回收
        }
      }

      if (skippedCount > 0) {
        logger.warn(`[ZIP] 总共跳过 ${skippedCount} 张无效图片`)
      }

      await zip.finalize()
    } catch (error) {
      zip.destroy(error)
    }
  })()

  return archivePromise
}
