import { Middleware, Session } from 'koishi'
import { Config } from './config'
import { logger } from './utils'
import { galleryUrlRegex } from './constants'

export function createLinkRecognitionMiddleware(config: Config): Middleware {
  return async (session: Session, next) => {
    if (session.content.startsWith(session.resolve('nh')) || session.content.startsWith(session.resolve('nhentai'))) {
      return next()
    }

    const match = session.stripped.content.match(galleryUrlRegex)
    if (config.enableLinkRecognition && match && match[1]) {
      // 在消息中发现 nhentai 链接，自动执行下载
      if (config.debug) {
        logger.info(`nhentai 链接: ${match[1]}`)
      }
      return session.execute(`nh.download ${match[1]}`)
    }

    return next()
  }
}
