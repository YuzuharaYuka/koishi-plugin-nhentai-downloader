import { Session, h } from 'koishi'
import { Config } from './config'
import { logger, bufferToDataURI, sleep } from './utils'
import { Gallery, SearchResult, Tag } from './types'
import { ApiService } from './services/api'
import { NhentaiService } from './services/nhentai'
import { readFile, rm } from 'fs/promises'
import { pathToFileURL } from 'url'

export interface DownloadOptions {
  pdf?: boolean
  zip?: boolean
  image?: boolean
  key?: string
}

export interface SearchOptions {
  sort?: 'popular' | 'popular-today' | 'popular-week'
  lang?: 'chinese' | 'japanese' | 'english' | 'all'
}

export interface SearchHandlerOptions {
  showTags?: boolean
  showLink?: boolean
  useForward?: boolean
  forwardSupportedPlatforms?: string[]
}

const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot']

export const tagTypeDisplayMap: Record<Tag['type'], string> = {
  parody: '🎭 原作',
  character: '👥 角色',
  artist: '👤 作者',
  group: '🏢 社团',
  language: '🌐 语言',
  category: '📚 分类',
  tag: '🏷️ 标签',
}

async function sendWithOptionalForward(
  session: Session,
  content: h | h[],
  useForward: boolean,
  supportedPlatforms: string[],
): Promise<void> {
  if (useForward && supportedPlatforms.includes(session.platform)) {
    const contentArray = Array.isArray(content) ? content : [content]
    await session.send(h('message', { forward: true }, contentArray))
  } else {
    if (Array.isArray(content)) {
      await session.send(content.flatMap((m) => m.children || m))
    } else {
      await session.send(content)
    }
  }
}

export function formatGalleryInfo(
  gallery: Partial<Gallery>,
  displayIndex?: number,
  options: {
    showTags?: boolean
    showLink?: boolean
  } = {},
): h {
  const { showTags = true, showLink = true } = options
  const infoLines: string[] = []
  const TAG_LIMIT = 8

  let title = '📘 '
  if (typeof displayIndex === 'number') title += `【${displayIndex + 1}】 `
  title += gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese || 'N/A'
  infoLines.push(title)

  infoLines.push(`🆔 ID: ${gallery.id || 'N/A'}`)
  infoLines.push(`📄 页数: ${gallery.num_pages || 'N/A'}`)
  infoLines.push(`⭐ 收藏: ${gallery.num_favorites || 'N/A'}`)
  if (gallery.upload_date) {
    infoLines.push(`📅 上传于: ${new Date(gallery.upload_date * 1000).toLocaleDateString('zh-CN')}`)
  }

  const tagsByType = (gallery.tags || []).reduce((acc, tag) => {
    if (!acc[tag.type]) acc[tag.type] = []
    acc[tag.type].push(tag.name)
    return acc
  }, {} as Record<Tag['type'], string[]>)

  if (showTags) {
    for (const type in tagTypeDisplayMap) {
      const key = type as Tag['type']
      if (tagsByType[key]) {
        let names = tagsByType[key]

        if (key === 'language') {
          names = names.map(name => name.replace(/\b\w/g, l => l.toUpperCase()))
        } else if (key === 'tag' && names.length > TAG_LIMIT) {
          names = [...names.slice(0, TAG_LIMIT), '...']
        }

        infoLines.push(`${tagTypeDisplayMap[key]}: ${names.join(', ')}`)
      }
    }
  }

  if (showLink && gallery.id) {
    infoLines.push(`🔗 链接: https://nhentai.net/g/${gallery.id}/`)
  }

  return h('p', infoLines.join('\n'))
}

export function buildSearchQueryQueue(
  query: string,
  lang: SearchOptions['lang'],
): { query: string; message: string }[] {
  const baseQuery = query.trim()

  const buildQuery = (langFilter: string) => {
    if (baseQuery.includes('language:') || baseQuery.includes('汉化')) {
      return baseQuery
    }
    return `${baseQuery} ${langFilter}`.trim()
  }

  if (lang === 'chinese') {
    return [
      { query: buildQuery('language:chinese'), message: `正在尝试使用 \`language:chinese\`...` },
      { query: buildQuery('-language:english -language:japanese'), message: `正在尝试排除其他语言...` },
      { query: buildQuery('汉化'), message: `正在尝试使用关键词 \`汉化\`...` },
      { query: baseQuery, message: `正在尝试搜索所有语言...` },
    ]
  }

  let effectiveQuery = baseQuery
  if (lang && lang !== 'all' && !baseQuery.includes('language:')) {
    effectiveQuery = `${baseQuery} language:${lang}`.trim()
  }

  return [{ query: effectiveQuery, message: '' }]
}

export async function handleIdSearch(
  session: Session,
  id: string,
  nhentaiService: NhentaiService,
  config: Config,
  options: SearchHandlerOptions = {},
): Promise<void> {
  const { useForward = true, forwardSupportedPlatforms = ['qq', 'onebot'] } = options

  const result = await nhentaiService.getGalleryWithCover(id)
  if (!result) {
    await session.send(`获取画廊 ${id} 信息失败，请检查ID是否正确。`)
    return
  }

  const { gallery, cover } = result
  const galleryNode = formatGalleryInfo(gallery, undefined, {
    showTags: config.showTagsInSearch,
    showLink: config.showLinkInSearch,
  })
  const messageContent = h('message', {}, galleryNode)
  if (cover) {
    messageContent.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
  }

  await sendWithOptionalForward(session, messageContent, useForward, forwardSupportedPlatforms)
}

export async function handleKeywordSearch(
  session: Session,
  query: string,
  options: SearchOptions,
  apiService: ApiService,
  nhentaiService: NhentaiService,
  config: Config,
  handlerOptions: SearchHandlerOptions = {},
): Promise<void> {
  const {
    useForward = true,
    forwardSupportedPlatforms = ['qq', 'onebot'],
    showTags = true,
    showLink = true,
  } = handlerOptions

  const limit = config.searchResultLimit > 0 ? config.searchResultLimit : 10
  const sort = options.sort
  const lang = options.lang || config.defaultSearchLanguage

  const queryQueue = buildSearchQueryQueue(query, lang)
  let effectiveQuery = ''
  let initialResult: SearchResult | null = null

  for (const { query: currentQuery, message } of queryQueue) {
    effectiveQuery = currentQuery
    if (message) await session.send(message)
    const result = await apiService.searchGalleries(effectiveQuery, 1, sort)
    if (result?.result.length > 0) {
      initialResult = result
      break
    }
  }

  if (!initialResult) {
    await session.send(`未找到与"${query}"相关的漫画。`)
    return
  }

  let allResults: Partial<Gallery>[] = initialResult.result
  let totalApiPages = initialResult.num_pages
  let fetchedApiPage = 1
  let currentDisplayPage = 1

  const fetchApiPage = async (apiPageNum: number) => {
    const result = await apiService.searchGalleries(effectiveQuery, apiPageNum, sort)
    if (!result?.result.length) return false
    allResults.push(...result.result)
    if (result.num_pages > totalApiPages) totalApiPages = result.num_pages
    fetchedApiPage = apiPageNum
    return true
  }

  while (true) {
    const startIndex = (currentDisplayPage - 1) * limit
    const endIndex = startIndex + limit

    while (endIndex > allResults.length && fetchedApiPage < totalApiPages) {
      await session.send(
        h('quote', { id: session.messageId }) +
          `正在加载更多结果 (第 ${fetchedApiPage + 1} / ${totalApiPages} API页)...`,
      )
      await fetchApiPage(fetchedApiPage + 1)
    }

    const displayedResults = allResults.slice(startIndex, endIndex)

    if (displayedResults.length === 0) {
      await session.send(currentDisplayPage > 1 ? '没有更多结果了。' : `未找到与"${query}"相关的漫画。`)
      if (currentDisplayPage > 1) currentDisplayPage--
      else break
      continue
    }

    const covers = await nhentaiService.getCoversForGalleries(displayedResults)
    const messageNodes = displayedResults.map((gallery, index) => {
      const galleryInfoNode = formatGalleryInfo(gallery, index, { showTags, showLink })
      const cover = covers.get(gallery.id as string)
      const messageNode = h('message', {}, galleryInfoNode)
      if (cover) {
        messageNode.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
      }
      return messageNode
    })

    const totalDisplayPages = Math.ceil(allResults.length / limit)
    const headerText = `共约 ${initialResult.num_pages * initialResult.per_page} 个结果, 当前显示 ${startIndex + 1}-${
      startIndex + displayedResults.length
    } (第 ${currentDisplayPage} / ${totalDisplayPages} 页)`
    const header = h('message', {}, h('p', headerText))

    await sendWithOptionalForward(session, [header, ...messageNodes], useForward, forwardSupportedPlatforms)

    const prompts = ['回复序号下载']
    if (currentDisplayPage > 1) prompts.push('[B]上一页')
    if (currentDisplayPage < totalDisplayPages) prompts.push('[F]下一页')
    prompts.push('[N]退出')
    await session.send(prompts.join('，') + '。')

    const reply = await session.prompt(config.promptTimeout * 1000)
    if (!reply) {
      await session.send('操作超时，已自动取消。')
      break
    }

    const lowerReply = reply.toLowerCase()
    if (lowerReply === 'n') {
      await session.send('操作已取消。')
      break
    } else if (lowerReply === 'f' && currentDisplayPage < totalDisplayPages) {
      currentDisplayPage++
    } else if (lowerReply === 'b' && currentDisplayPage > 1) {
      currentDisplayPage--
    } else if (/^\d+$/.test(reply)) {
      const selectedIndex = parseInt(reply, 10) - 1
      if (selectedIndex >= 0 && selectedIndex < displayedResults.length) {
        const gallery = displayedResults[selectedIndex]
        if (gallery?.id) {
          await session.execute(`nh.download ${gallery.id}`)
          return
        }
      }
      await session.send('无效的选择。')
    } else {
      await session.send('无效的输入，已退出交互。')
      break
    }
  }
}

export async function handleDownloadCommand(
  session: Session,
  id: string,
  options: DownloadOptions,
  statusMessageId: string,
  nhentaiService: NhentaiService,
  config: Config,
): Promise<void> {
  let tempPdfPath: string | undefined
  let shouldCleanupPdf = false

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
        shouldCleanupPdf = result.isTemporary
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
        const imageElements = result.images

        if (useForward) {
          const imageMessages = imageElements.map((item) =>
            h('message', {}, [h.image(bufferToDataURI(item.buffer, `image/${item.extension}`))]),
          )
          await session.send(h('message', { forward: true }, imageMessages))
        } else {
          for (let i = 0; i < imageElements.length; i++) {
            const { index, buffer, extension } = imageElements[i]
            await session.send(
              `正在发送图片: ${index + 1} / ${result.images.length + result.failedIndexes.length}` +
                h.image(bufferToDataURI(buffer, `image/${extension}`)),
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
    if (tempPdfPath && shouldCleanupPdf) {
      try {
        await rm(tempPdfPath, { force: true })
        if (config.debug) logger.info(`临时 PDF 文件已清理: ${tempPdfPath}`)
      } catch (e) {
        if (config.debug) logger.warn('删除临时PDF文件失败: %o', e)
      }
    }
  }
}
