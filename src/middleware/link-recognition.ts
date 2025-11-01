// src/middleware/link-recognition.ts
import { Middleware } from 'koishi'
import { Config } from '../config'
import { logger } from '../utils'
import { galleryUrlRegex } from '../constants'

/**
 * 创建链接识别中间件
 * 自动识别消息中的 nhentai 链接并执行下载
 */
export function createLinkRecognitionMiddleware(config: Config): Middleware {
  return async (session, next) => {
    // 如果消息已经是以指令开头，直接跳过
    if (session.content.startsWith(session.resolve('nh')) || session.content.startsWith(session.resolve('nhentai'))) {
      return next()
    }

    // 检查是否包含 nhentai 链接
    const match = session.stripped.content.match(galleryUrlRegex)
    if (config.enableLinkRecognition && match && match[1]) {
      if (config.debug) {
        logger.info(`发现 nhentai 链接: ${match[1]}，自动执行下载。`)
      }
      return session.execute(`nh download ${match[1]}`)
    }

    return next()
  }
}

