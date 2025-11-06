/**
 * PDF 生成模块，负责创建和加密 PDF 文件。
 */
import PDFDocument from 'pdfkit'
import * as fs from 'fs'
import * as path from 'path'
import { rm } from 'fs/promises'
import { DownloadedImage } from './types'
import { Config } from '../config'
import { logger } from '../utils'
import { convertImageForMode, conditionallyCompressJpeg } from './images'

export async function createPdf(
  imageStream: AsyncIterable<DownloadedImage>,
  galleryId: string,
  onProgress: (message: string) => void,
  password: string | undefined,
  processor: any, // Processor 实例
  config: Config,
  baseDir: string,
): Promise<string> {
  const downloadDir = path.resolve(baseDir, config.downloadPath)
  const tempPdfPath = path.resolve(downloadDir, `temp_${galleryId}_${Date.now()}.pdf`)

  try {
    const docOptions: any = { bufferPages: false } // 流式写入以优化内存
    if (password) {
      docOptions.userPassword = password
      docOptions.ownerPassword = password
    }

    const doc = new PDFDocument(docOptions)
    const writeStream = fs.createWriteStream(tempPdfPath)
    let pageCount = 0
    let shouldContinue = true

    onProgress('正在生成 PDF...')

    const imageCache = processor.getImageCache?.()

    const processingPromise = (async () => {
      try {
        for await (const image of imageStream) {
          if (!shouldContinue) break

          try {
            pageCount++
            if (pageCount % 10 === 0) onProgress(`PDF生成进度: ${pageCount} 页`)

            let finalBuffer: Buffer
            let finalFormat: string

            if ((image as any).processedBuffer) {
              finalBuffer = (image as any).processedBuffer
              finalFormat = (image as any).finalFormat || image.extension
              if (config.debug) logger.debug(`使用预处理缓存: 图片 ${image.index + 1}`)
            } else if (imageCache) {
              const cached = await imageCache.getProcessed(
                (image as any).galleryId,
                (image as any).mediaId,
                image.index,
              )
              if (cached) {
                finalBuffer = cached.buffer
                finalFormat = cached.extension
                if (config.debug) logger.info(`处理缓存命中: 图片 ${image.index + 1} (gid: ${(image as any).galleryId})`)
              } else {
                const { buffer: convertedBuffer, finalFormat: fmt } = await convertImageForMode(
                  processor.wasm,
                  image.buffer,
                  image.extension,
                  'pdf',
                  config,
                )
                finalBuffer = await conditionallyCompressJpeg(
                  processor.wasm,
                  convertedBuffer,
                  fmt,
                  config.pdfJpegRecompressionSize,
                  config.pdfCompressionQuality,
                  config.pdfEnableCompression,
                  config.debug,
                )
                finalFormat = fmt

                await imageCache.setProcessed(
                  (image as any).galleryId,
                  (image as any).mediaId,
                  image.index,
                  finalBuffer,
                  finalFormat,
                ).catch((err) => {
                  if (config.debug) logger.warn(`保存处理缓存失败: ${err.message}`)
                })
              }
            } else {
              const { buffer: convertedBuffer, finalFormat: fmt } = await convertImageForMode(
                processor.wasm,
                image.buffer,
                image.extension,
                'pdf',
                config,
              )
              finalBuffer = await conditionallyCompressJpeg(
                processor.wasm,
                convertedBuffer,
                fmt,
                config.pdfJpegRecompressionSize,
                config.pdfCompressionQuality,
                config.pdfEnableCompression,
                config.debug,
              )
              finalFormat = fmt
            }

            // 添加图片到 PDF
            if (pageCount > 1) {
              doc.addPage({ size: 'A4' })
            }
            doc.image(finalBuffer, 0, 0, {
              fit: [595, 842], // A4 尺寸
              align: 'center',
              valign: 'center',
            })
          } catch (imgError) {
            logger.warn(`[Processor] 跳过处理失败的图片 ${image.index + 1}: ${imgError.message}`)
            if (config.debug) onProgress(`处理第 ${pageCount} 张图片失败，已跳过。`)
          }

          // 手动GC, 释放内存
          if (pageCount % 50 === 0 && global.gc) {
            global.gc()
          }
        }

        if (pageCount === 0) throw new Error('没有成功处理任何图片，无法生成 PDF')
        onProgress(`正在保存 PDF (${pageCount} 张图片)...`)
      } catch (error) {
        shouldContinue = false
        throw error
      }
    })()

    return new Promise<string>(async (resolve, reject) => {
      let isResolved = false

      const cleanup = async (error?: Error) => {
        if (isResolved) return
        isResolved = true
        shouldContinue = false

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
          if (isResolved) return
          isResolved = true

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
