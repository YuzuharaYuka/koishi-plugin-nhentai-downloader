// src/handlers/download-handler.ts
import { Session, h } from 'koishi'
import { Config } from '../config'
import { logger, bufferToDataURI, sleep } from '../utils'
import { NhentaiService } from '../services/nhentai'
import { readFile, rm } from 'fs/promises'
import { pathToFileURL } from 'url'

export interface DownloadOptions {
  pdf?: boolean
  zip?: boolean
  image?: boolean
  key?: string
}

const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot']

/**
 * 处理下载命令
 */
export async function handleDownloadCommand(
  session: Session,
  id: string,
  options: DownloadOptions,
  statusMessageId: string,
  nhentaiService: NhentaiService,
  config: Config
): Promise<void> {
  let tempPdfPath: string | undefined

  try {
    let outputType: 'zip' | 'pdf' | 'img' = config.defaultOutput
    if (options.pdf) outputType = 'pdf'
    else if (options.zip) outputType = 'zip'
    else if (options.image) outputType = 'img'
    const password = options.key || config.defaultPassword

    const updateStatus = async (text: string) => {
      if (typeof session.bot.editMessage === 'function') {
        try {
          await session.bot.editMessage(session.channelId, statusMessageId, text)
        } catch (error) {
          if (config.debug) logger.warn('编辑状态消息失败 (忽略): %o', error)
        }
      }
    }

    const result = await nhentaiService.downloadGallery(id, outputType, password, updateStatus)

    if ('error' in result) {
      await session.send(result.error)
      return
    }

    let successMessage = `任务完成: ${result.filename.split('.').slice(0, -1).join('.')}`
    if (['zip', 'pdf'].includes(result.type) && password) {
      successMessage += `，密码为: ${password}`
    }

    switch (result.type) {
      case 'pdf':
        tempPdfPath = result.path
        if (config.pdfSendMethod === 'buffer') {
          const pdfBuffer = await readFile(tempPdfPath)
          await session.send(h.file(pdfBuffer, 'application/pdf', { title: result.filename }))
        } else {
          await session.send(h.file(pathToFileURL(tempPdfPath).href, { title: result.filename }))
        }
        break

      case 'zip':
        await session.send(h.file(result.buffer, 'application/zip', { title: result.filename }))
        break

      case 'images':
        const useForward = config.useForwardForDownload && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform)
        const imageElements = result.images // Anti-gzip is already applied

        if (useForward) {
          await session.send(
            h(
              'figure',
              {},
              imageElements.map((item) => h.image(bufferToDataURI(item.buffer, `image/${item.extension}`)))
            )
          )
        } else {
          for (const { index, buffer, extension } of imageElements) {
            await session.send(
              `正在发送图片: ${index + 1} / ${result.images.length + result.failedIndexes.length}` +
                h.image(bufferToDataURI(buffer, `image/${extension}`))
            )
            await sleep(config.imageSendDelay * 1000)
          }
        }

        if (result.failedIndexes.length > 0) {
          const failedPages = result.failedIndexes.map((i) => i + 1).join(', ')
          await session.send(`有 ${result.failedIndexes.length} 张图片下载失败，页码为: ${failedPages}。`)
        }
        break
    }
    await session.send(successMessage)
  } finally {
    if (tempPdfPath) {
      try {
        await rm(tempPdfPath, { force: true })
      } catch (e) {
        // 忽略删除失败
      }
    }
  }
}

