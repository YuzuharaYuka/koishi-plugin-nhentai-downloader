// PDF 生成模块，负责创建和加密 PDF 文件。
import * as fs from 'fs'
import * as path from 'path'
import { rm } from 'fs/promises'
import { DownloadedImage } from './types'
import { Config } from '../config'
import { logger } from '../utils'
import { convertImageForMode, conditionallyCompressJpeg } from './images'

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
    const cached = await imageCache.getProcessed(image.galleryId, image.mediaId, image.index)
    if (cached) {
      debugLog && logger.info(`处理缓存命中: 图片 ${image.index + 1} (gid: ${image.galleryId})`)
      return { buffer: cached.buffer, format: cached.extension }
    }

    // 缓存未命中，进行处理并保存
    const { buffer: convertedBuffer, finalFormat: fmt } = await convertImageForMode(
      processor.wasm,
      image.buffer,
      image.extension,
      'pdf',
      config,
    )
    const compressed = await conditionallyCompressJpeg(
      processor.wasm,
      convertedBuffer,
      fmt,
      config.pdfJpegRecompressionSize,
      config.pdfCompressionQuality,
      config.pdfEnableCompression,
      debugLog,
    )

    await imageCache.setProcessed(image.galleryId, image.mediaId, image.index, compressed, fmt).catch(
      (err) => {
        debugLog && logger.warn(`保存处理缓存失败: ${err.message}`)
      },
    )
    return { buffer: compressed, format: fmt }
  }

  // 无缓存，直接处理
  const { buffer: convertedBuffer, finalFormat: fmt } = await convertImageForMode(
    processor.wasm,
    image.buffer,
    image.extension,
    'pdf',
    config,
  )
  const compressed = await conditionallyCompressJpeg(
    processor.wasm,
    convertedBuffer,
    fmt,
    config.pdfJpegRecompressionSize,
    config.pdfCompressionQuality,
    config.pdfEnableCompression,
    debugLog,
  )
  return { buffer: compressed, format: fmt }
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
        for await (const image of imageStream) {
          if (abortController.signal.aborted) break

          try {
            pageCount++
            if (pageCount % 10 === 0) onProgress(`PDF生成进度: ${pageCount} 页`)

            const { buffer: finalBuffer, format: finalFormat } = await processImageBuffer(
              image as ProcessingImage,
              processor,
              imageCache,
              config,
              debugLog,
            )

            // 添加图片到 PDF，多页时新增页面
            if (pageCount > 1) {
              doc.addPage({ size: 'A4' })
            }
            doc.image(finalBuffer, 0, 0, {
              fit: [595, 842], // A4 尺寸 (595x842pt)
              align: 'center',
              valign: 'center',
            })
          } catch (imgError) {
            logger.warn(`[Processor] 跳过处理失败的图片 ${image.index + 1}: ${imgError.message}`)
            if (config.debug) onProgress(`处理第 ${pageCount} 张图片失败，已跳过。`)
          }

          // 手动 GC 释放内存（每 50 页触发一次）
          if (pageCount % 50 === 0 && global.gc) {
            global.gc()
          }
        }

        if (pageCount === 0) throw new Error('没有成功处理任何图片，无法生成 PDF')
        onProgress(`正在保存 PDF (${pageCount} 张图片)...`)
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
            await cleanup(error)
          }
        })

        writeStream.on('error', (err) => cleanup(err))
        doc.on('error', (err) => cleanup(err))

        doc.pipe(writeStream)
        doc.end()
      } catch (error) {
        await cleanup(error)
      }
    })
  } catch (error) {
    await rm(tempPdfPath, { force: true }).catch(() => {})
    throw error
  }
}
