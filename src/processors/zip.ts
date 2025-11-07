// ZIP 生成模块，负责创建和加密 ZIP 压缩文件
import archiver from 'archiver'
import { PassThrough } from 'stream'
import { DownloadedImage } from './types'

// 注册加密 ZIP 格式（仅在未注册时注册，避免热重载时重复注册）
import archiverZipEncrypted from 'archiver-zip-encrypted'
try {
  archiver.registerFormat('zip-encrypted', archiverZipEncrypted)
} catch {
  // 格式已注册，忽略错误
}

export async function createZip(
  imageStream: AsyncIterable<DownloadedImage>,
  password: string | undefined,
  zipCompressionLevel: number,
  folderName?: string,
): Promise<Buffer> {
  const isEncrypted = !!password
  const format = isEncrypted ? 'zip-encrypted' : 'zip'
  // 配置压缩选项和加密参数
  const archiveOptions: archiver.ArchiverOptions & { encryptionMethod?: string; password?: string } = {
    zlib: { level: zipCompressionLevel },
  }
  if (isEncrypted) {
    archiveOptions.encryptionMethod = 'aes256'
    archiveOptions.password = password
  }

  const zip = archiver(format as archiver.Format, archiveOptions)
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
      // 临时缓存用于保持页面顺序
      const pageBuffer = new Map<number, { buffer: Buffer; extension: string }>()

      for await (const { index, buffer, extension } of imageStream) {
        pageBuffer.set(index, { buffer, extension })

        // 按顺序将图片写入 ZIP，确保页面编号连续
        while (pageBuffer.has(nextPageNum)) {
          const { buffer: img, extension: ext } = pageBuffer.get(nextPageNum)!
          pageBuffer.delete(nextPageNum)
          const pageNum = (nextPageNum + 1).toString().padStart(3, '0')
          const fileName = folderName ? `${folderName}/${pageNum}.${ext}` : `${pageNum}.${ext}`
          zip.append(img, { name: fileName })
          nextPageNum++

          if (nextPageNum % 50 === 0 && global.gc) global.gc() // 定期触发垃圾回收
        }
      }
      await zip.finalize()
    } catch (error) {
      zip.destroy(error)
    }
  })()

  return archivePromise
}
