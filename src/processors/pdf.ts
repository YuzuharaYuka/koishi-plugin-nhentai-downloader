// PDF 生成模块，负责创建和加密 PDF 文件。
import * as fs from 'fs'
import * as path from 'path'
import { rm, mkdir } from 'fs/promises'
import type { DownloadedImage } from './types'
import type { Config } from '../config'
import { logger } from '../utils'
import { convertImageForMode, pdfProcessVariant } from './images'
import { GC_TRIGGER_INTERVAL, IMAGE_PROCESS_CONCURRENCY } from '../constants'

// 延迟加载 pdfkit（避免在模块初始化时加载 canvas 依赖）
let PDFDocument: any = null

async function ensurePdfKitLoaded() {
  if (!PDFDocument) {
    try {
      const pdfkitModule = await import('pdfkit')
      PDFDocument = pdfkitModule.default
    } catch (error) {
      throw new Error(`Failed to load pdfkit: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return PDFDocument
}

// 扩展的图片类型，包含处理相关的额外字段
interface ProcessingImage extends DownloadedImage {
  processedBuffer?: Buffer
  finalFormat?: string
  galleryId?: string
  mediaId?: string
}

// 处理图片并返回最终缓冲区和格式
async function processImageBuffer(
  image: ProcessingImage,
  processor: any,
  imageCache: any,
  config: Config,
  debugLog: boolean,
): Promise<{ buffer: Buffer; format: string }> {
  // 使用预处理缓存
  if (image.processedBuffer) {
    debugLog && logger.debug(`使用预处理缓存: 图片 ${image.index + 1}`)
    return { buffer: image.processedBuffer, format: image.finalFormat || image.extension }
  }

  // 查询处理缓存
  if (imageCache) {
    const cached = await imageCache.getProcessed(
      image.galleryId,
      image.mediaId,
      image.index,
      pdfProcessVariant(config),
    )
    if (cached) {
      debugLog && logger.debug(`缓存命中(已处理): 图片 ${image.index + 1}`)
      return { buffer: cached.buffer, format: cached.format }
    }
  }

  // 单次解码完成格式转换与压缩
  const { buffer: finalBuffer, finalFormat } = await convertImageForMode(
    processor.processor,
    image.buffer,
    image.extension,
    'pdf',
    config,
  )

  // 存储处理结果到缓存
  if (imageCache && image.galleryId && image.mediaId !== undefined) {
    await imageCache.setProcessed(
      image.galleryId,
      image.mediaId,
      image.index,
      finalBuffer,
      finalFormat,
      pdfProcessVariant(config),
    )
  }

  return { buffer: finalBuffer, format: finalFormat }
}

export async function createPdf(
  imageStream: AsyncIterable<DownloadedImage>,
  galleryId: string,
  onProgress: (message: string) => void,
  password: string | undefined,
  processor: any, // Processor 实例
  config: Config,
  baseDir: string,
): Promise<string> {
  // 延迟加载 pdfkit（仅在需要时加载，避免早期加载 canvas 依赖）
  const PDFDocClass = await ensurePdfKitLoaded()

  const downloadDir = path.resolve(baseDir, config.downloadPath)
  const tempPdfPath = path.resolve(downloadDir, `temp_${galleryId}_${Date.now()}.pdf`)
  const debugLog = config.debug // 缓存 debug 标志，避免多次访问
  const abortController = new AbortController()

  // 兜底：downloadPath 可能尚未创建（例如禁用了所有缓存）
  await mkdir(downloadDir, { recursive: true })

  try {
    const docOptions: any = { bufferPages: false } // 流式写入以优化内存
    if (password) {
      docOptions.userPassword = password
      docOptions.ownerPassword = password
    }

    const doc = new PDFDocClass(docOptions)
    const writeStream = fs.createWriteStream(tempPdfPath)
    let pageCount = 0

    onProgress('正在生成 PDF...')

    const imageCache = processor.getImageCache?.()

    const processingPromise = (async () => {
      try {
        const iterator = imageStream[Symbol.asyncIterator]()
        // 预处理队列：编解码在原生线程池上跑，同时推进几张即可吃满多核，
        // 但页面必须按顺序写入 PDF，所以这里只提前处理、不提前落页。
        const inflight: Array<{
          image: ProcessingImage
          task: Promise<{ buffer: Buffer; format: string } | { error: Error }>
        }> = []

        const startNext = async (): Promise<boolean> => {
          const { value, done } = await iterator.next()
          if (done) return false
          const image = value as ProcessingImage
          const task = processImageBuffer(image, processor, imageCache, config, debugLog).catch((error) => ({
            error: error instanceof Error ? error : new Error(String(error)),
          }))
          inflight.push({ image, task })
          return true
        }

        let addedCount = 0

        while (true) {
          while (inflight.length < IMAGE_PROCESS_CONCURRENCY && (await startNext())) {
            // 填满预处理队列
          }

          const head = inflight.shift()
          if (!head) break
          if (abortController.signal.aborted) break

          const result = await head.task
          if ('error' in result) {
            logger.warn(`[Processor] 跳过处理失败的图片 ${head.image.index + 1}: ${result.error.message}`)
            if (config.debug) onProgress(`处理第 ${head.image.index + 1} 张图片失败，已跳过。`)
            continue
          }

          addedCount++
          if (addedCount % 10 === 0) onProgress(`PDF生成进度: ${addedCount} 页`)

          // 添加图片到 PDF，多页时新增页面
          if (addedCount > 1) {
            doc.addPage({ size: 'A4' })
          }
          doc.image(result.buffer, 0, 0, {
            fit: [595, 842], // A4 尺寸 (595x842pt)
            align: 'center',
            valign: 'center',
          })

          // 手动 GC 释放内存（每 N 页触发一次）
          if (addedCount % GC_TRIGGER_INTERVAL === 0 && global.gc) {
            global.gc()
          }
        }

        if (addedCount === 0) throw new Error('没有成功处理任何图片，无法生成 PDF')
        pageCount = addedCount
        onProgress(`正在保存 PDF (${addedCount} 张图片)...`)
      } catch (error) {
        abortController.abort()
        throw error
      }
    })()

    return new Promise<string>(async (resolve, reject) => {
      const cleanup = async (error?: Error) => {
        abortController.abort()
        writeStream.removeAllListeners()
        doc.removeAllListeners()

        try {
          if (!writeStream.destroyed) writeStream.destroy()
        } catch {}

        if (error) {
          await rm(tempPdfPath, { force: true }).catch(() => {})
          reject(error)
        }
      }

      try {
        await processingPromise

        writeStream.on('finish', async () => {
          try {
            const stats = fs.statSync(tempPdfPath)
            const sizeInMB = (stats.size / 1024 / 1024).toFixed(2)
            logger.info(`PDF 生成完成: ${pageCount} 页, ${sizeInMB} MB ${password ? '（已加密）' : ''}`)
            onProgress(`✓ PDF 生成完成！${password ? '（已用密码加密）' : ''}`)
            resolve(tempPdfPath)
          } catch (error) {
            await cleanup(error instanceof Error ? error : new Error(String(error)))
          }
        })

        writeStream.on('error', (err: Error) => cleanup(err))
        doc.on('error', (err: Error) => cleanup(err))

        doc.pipe(writeStream)
        doc.end()
      } catch (error) {
        await cleanup(error instanceof Error ? error : new Error(String(error)))
      }
    })
  } catch (error) {
    await rm(tempPdfPath, { force: true }).catch(() => {})
    throw error
  }
}
