import { Session, h } from 'koishi'
import { Config } from './config'
import { logger, bufferToDataURI, sleep, getErrorMessage } from './utils'
import { Gallery, SearchResult, Tag, MenuGallery } from './types'
import { ApiService } from './services/api'
import { NhentaiService } from './services/nhentai'
import { MenuService } from './services/menu'
import { FORWARD_SUPPORTED_PLATFORMS, TAG_DISPLAY_LIMIT } from './constants'
import { readFile, rm } from 'fs/promises'
import { pathToFileURL } from 'url'

export interface DownloadOptions {
  pdf?: boolean
  zip?: boolean
  image?: boolean
  key?: string
}

export interface SearchOptions {
  sort?: 'popular'
  lang?: 'chinese' | 'japanese' | 'english' | 'all'
}

export interface SearchHandlerOptions {
  showTags?: boolean
  showLink?: boolean
  useForward?: boolean
  forwardSupportedPlatforms?: string[]
}

export const tagTypeDisplayMap: Record<Tag['type'], string> = {
  parody: '原作',
  character: '角色',
  artist: '作者',
  group: '社团',
  language: '语言',
  category: '分类',
  tag: '标签',
}

async function sendWithOptionalForward(
  session: Session,
  content: h | h[],
  useForward: boolean,
  supportedPlatforms: string[],
): Promise<void> {
  const contentArray = Array.isArray(content) ? content : [content]

  if (useForward && supportedPlatforms.includes(session.platform)) {
    await session.send(h('message', { forward: true }, contentArray))
  } else {
    await session.send(contentArray.flatMap((m) => m.children || m))
  }
}

// 检查画廊是否被屏蔽
export function isGalleryBlacklisted(gallery: MenuGallery): boolean {
  const searchGallery = gallery as any
  return searchGallery.blacklisted === true
}

export function formatGalleryInfo(
  gallery: MenuGallery,
  displayIndex?: number,
  options: {
    showTags?: boolean
    showLink?: boolean
  } = {},
): h {
  const { showTags = true, showLink = true } = options
  const infoLines: string[] = []

  const isSearchGallery = typeof (gallery as any).thumbnail === 'string'

  let title = '📘 '
  if (typeof displayIndex === 'number') title += `【${displayIndex + 1}】 `

  if (isSearchGallery) {
    const sg = gallery as any
    title += sg.english_title || sg.japanese_title || `ID ${sg.id}`
  } else {
    const fg = gallery as any
    title += fg.title?.pretty || fg.title?.english || fg.title?.japanese || 'N/A'
  }
  infoLines.push(title)

  infoLines.push(`🆔 ID: ${gallery.id || 'N/A'}`)

  // 仅 Gallery 才有这些信息
  if (!isSearchGallery) {
    const fg = gallery as any
    infoLines.push(`页数: ${fg.num_pages || 'N/A'}`)
    infoLines.push(`收藏: ${fg.num_favorites || 'N/A'}`)
    if (fg.upload_date) {
      infoLines.push(`上传于: ${new Date(fg.upload_date * 1000).toLocaleDateString('zh-CN')}`)
    }
  } else {
    const sg = gallery as any
    infoLines.push(`页数: ${sg.num_pages || 'N/A'}`)
  }

  // 仅 Gallery 才有标签
  if (!isSearchGallery && showTags) {
    const fg = gallery as any
    const tagsByType = (fg.tags || []).reduce((acc: any, tag: any) => {
      if (!acc[tag.type]) acc[tag.type] = []
      acc[tag.type].push(tag.name)
      return acc
    }, {} as Record<any, string[]>)

    for (const type in tagTypeDisplayMap) {
      const key = type as keyof typeof tagTypeDisplayMap
      if (tagsByType[key]) {
        let names = tagsByType[key] as string[]

        if (key === 'language') {
          names = names.map((name: string) => name.replace(/\b\w/g, (l: string) => l.toUpperCase()))
        } else if (key === 'tag' && names.length > TAG_DISPLAY_LIMIT) {
          names = [...names.slice(0, TAG_DISPLAY_LIMIT), '...']
        }

        infoLines.push(`${tagTypeDisplayMap[key]}: ${names.join(', ')}`)
      }
    }
  }

  if (showLink && gallery.id) {
    infoLines.push(`链接: https://nhentai.net/g/${gallery.id}/`)
  }

  return h('p', infoLines.join('\n'))
}

export function buildSearchQuery(
  query: string,
  lang: SearchOptions['lang'],
): string {
  const baseQuery = query.trim()
  // 已有语言过滤则直接返回
  if (baseQuery.includes('language:') || baseQuery.includes('汉化')) return baseQuery
  // 未指定或指定 'all' 则不添加语言过滤
  const result = (lang && lang !== 'all') ? `${baseQuery} language:${lang}`.trim() : baseQuery
  return result || 'pages:>0'
}

// 分页状态
interface PaginationState {
  allResults: MenuGallery[]
  totalApiPages: number
  fetchedApiPage: number
  currentDisplayPage: number
}

function createPaginationState(initialResult: SearchResult): PaginationState {
  // 过滤被屏蔽的画廊
  const filteredResults = initialResult.result.filter((g) => !isGalleryBlacklisted(g))
  if (filteredResults.length < initialResult.result.length) {
    logger.info(`已过滤 ${initialResult.result.length - filteredResults.length} 个被屏蔽的画廊`)
  }
  return {
    allResults: filteredResults as MenuGallery[],
    totalApiPages: initialResult.num_pages,
    fetchedApiPage: 1,
    currentDisplayPage: 1,
  }
}

async function fetchMoreResults(
  state: PaginationState,
  effectiveQuery: string,
  sort: SearchOptions['sort'],
  apiService: ApiService,
): Promise<boolean> {
  const result = await apiService.searchGalleries(effectiveQuery, state.fetchedApiPage + 1, sort)
  if (!result) return false
  if (!result.result || result.result.length === 0) return false
  // 过滤已被屏蔽的画廊
  const filteredResults = result.result.filter((g) => !isGalleryBlacklisted(g))
  if (filteredResults.length < result.result.length) {
    logger.debug(`已过滤 ${result.result.length - filteredResults.length} 个被屏蔽的画廊`)
  }
  state.allResults.push(...(filteredResults as MenuGallery[]))
  if (result.num_pages > state.totalApiPages) state.totalApiPages = result.num_pages
  state.fetchedApiPage++
  return true
}

function buildPromptMessage(
  currentPage: number,
  totalPages: number,
  startIndex: number,
  endIndex: number,
  totalResults: number
): string {
  const position = `当前第 ${currentPage}/${totalPages} 页 (显示第 ${startIndex + 1}-${endIndex} 项，共约 ${totalResults} 项)`
  const prompts = ['回复序号下载']
  if (currentPage > 1) prompts.push('[B]上一页')
  if (currentPage < totalPages) prompts.push('[F]下一页')
  prompts.push('[N]退出')
  return `${position}\n${prompts.join('，')}。`
}

async function handlePagination(
  session: Session,
  query: string,
  initialResult: SearchResult,
  effectiveQuery: string,
  sort: SearchOptions['sort'],
  limit: number,
  apiService: ApiService,
  config: Config,
  displayHandler: (
    displayedResults: MenuGallery[],
    startIndex: number,
    totalResults: number
  ) => Promise<void>,
  onDownload: (galleryId: string) => Promise<void>,
  onCleanup?: () => void,
): Promise<void> {
  const state = createPaginationState(initialResult)

  while (true) {
    const startIndex = (state.currentDisplayPage - 1) * limit
    const endIndex = startIndex + limit

    let loadFailed = false
    while (endIndex > state.allResults.length && state.fetchedApiPage < state.totalApiPages) {
      const success = await fetchMoreResults(state, effectiveQuery, sort, apiService)
      if (!success) {
        // 加载失败，停止尝试加载更多
        loadFailed = true
        break
      }
    }

    const displayedResults = state.allResults.slice(startIndex, endIndex)

    if (displayedResults.length === 0) {
      if (state.currentDisplayPage > 1) {
        if (loadFailed) {
          await session.send('加载更多结果失败，请检查网络连接或稍后重试。')
        } else {
          await session.send('没有更多结果了。')
        }
        state.currentDisplayPage--
        continue
      } else {
        if (loadFailed) {
          await session.send('搜索失败，请检查网络连接或稍后重试。')
        } else {
          await session.send(`未找到与"${query}"相关的漫画。`)
        }
        break
      }
    }

    // 计算实际的总结果数：只有1页时使用实际数量，多页时使用估算值
    const totalResults = initialResult.num_pages === 1
      ? initialResult.result.length
      : initialResult.num_pages * initialResult.per_page

    await displayHandler(displayedResults, startIndex, totalResults)

    const totalDisplayPages = Math.ceil(totalResults / limit), actualEndIndex = Math.min(endIndex, state.allResults.length)
    await session.send(buildPromptMessage(
      state.currentDisplayPage,
      totalDisplayPages,
      startIndex,
      actualEndIndex,
      totalResults
    ))

    const reply = await session.prompt(config.promptTimeout * 1000)
    if (!reply) {
      await session.send('操作超时，已自动取消。')
      if (onCleanup) onCleanup()
      break
    }

    if (await handleUserInput(
      reply,
      state,
      displayedResults,
      totalDisplayPages,
      session,
      onDownload,
    ) === 'break') {
      if (onCleanup) onCleanup()
      break
    }
  }
}

async function handleUserInput(
  reply: string,
  state: PaginationState,
  displayedResults: MenuGallery[],
  totalDisplayPages: number,
  session: Session,
  onDownload: (galleryId: string) => Promise<void>,
): Promise<'continue' | 'break'> {
  const lowerReply = reply.toLowerCase()

  if (lowerReply === 'n') {
    await session.send('操作已取消。')
    return 'break'
  }

  if (lowerReply === 'f' && state.currentDisplayPage < totalDisplayPages) {
    state.currentDisplayPage++
    return 'continue'
  }

  if (lowerReply === 'b' && state.currentDisplayPage > 1) {
    state.currentDisplayPage--
    return 'continue'
  }

  if (/^\d+$/.test(reply)) {
    const selectedIndex = parseInt(reply, 10) - 1
    if (selectedIndex >= 0 && selectedIndex < displayedResults.length) {
      const gallery = displayedResults[selectedIndex]
      if (gallery?.id) {
        await onDownload(String(gallery.id))
        return 'break'
      }
    }
    await session.send('无效的选择。')
    return 'continue'
  }

  await session.send('无效的输入，已退出交互。')
  return 'break'
}

export async function handleRandomWithInteraction(
  session: Session,
  nhentaiService: NhentaiService,
  menuService: MenuService | null,
  config: Config,
): Promise<void> {
  while (true) {
    try {
      const randomId = await nhentaiService.getRandomGalleryId()
      if (!randomId) {
        await session.send('获取随机画廊ID失败，请检查网络连接或稍后重试。')
        break
      }

      if (config.searchMode === 'menu' && menuService) {
        // 菜单模式
        const result = await nhentaiService.getGalleryWithCover(randomId)
        if (!result) {
          await session.send(`获取画廊 ${randomId} 信息失败。`)
          break
        }

        const { gallery, cover } = result
        const coverBuffer = cover ? cover.buffer : Buffer.alloc(0)

        try {
          await menuService.sendDetailMenu(session, gallery, coverBuffer, true)
          await session.send('[Y]下载 [F]换一个 [N]退出')

          const reply = await session.prompt(config.promptTimeout * 1000)
          if (!reply) {
            await session.send('操作超时，已自动取消。')
            menuService.clearMenu(session)
            break
          }

          const lowerReply = reply.toLowerCase()
          if (lowerReply === 'y') {
            menuService.clearMenu(session)
            await session.execute(`nh.download ${randomId}`)
            break
          } else if (lowerReply === 'f') {
            menuService.clearMenu(session)
            await session.send('正在进行一次天降好运...')
            continue
          } else if (lowerReply === 'n') {
            menuService.clearMenu(session)
            await session.send('操作已取消。')
            break
          } else {
            menuService.clearMenu(session)
            await session.send('无效输入，操作已取消。')
            break
          }
        } catch (error: any) {
          logger.error(`详细菜单处理失败: ${getErrorMessage(error)}`)
          await session.send('菜单生成失败，将使用传统模式显示结果。')
          // 切换到文本模式
          await handleRandomWithTextMode(session, randomId, nhentaiService, config)
          break
        }
      } else {
        // 文本模式
        await handleRandomWithTextMode(session, randomId, nhentaiService, config)
        break
      }
    } catch (error: any) {
      logger.error(`[随机] 处理失败: %o`, error)
      await session.send('操作失败，请稍后重试。')
      break
    }
  }
}

async function handleRandomWithTextMode(
  session: Session,
  initialId: string,
  nhentaiService: NhentaiService,
  config: Config,
): Promise<void> {
  let currentId = initialId

  while (true) {
    const result = await nhentaiService.getGalleryWithCover(currentId)
    if (!result) {
      await session.send(`获取画廊 ${currentId} 信息失败。`)
      break
    }

    const { gallery, cover } = result
    const galleryNode = formatGalleryInfo(gallery, undefined, {
      showTags: config.textMode.showTags,
      showLink: config.textMode.showLink,
    })
    const messageContent = h('message', {}, galleryNode)
    if (cover && cover.buffer && config.textMode.showThumbnails) {
      messageContent.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
    }

    await sendWithOptionalForward(
      session,
      messageContent,
      config.textMode.useForward,
      FORWARD_SUPPORTED_PLATFORMS,
    )

    await session.send('[Y]下载 [F]换一个 [N]退出')
    const reply = await session.prompt(config.promptTimeout * 1000)

    if (!reply) {
      await session.send('操作超时，已自动取消。')
      break
    }

    const lowerReply = reply.toLowerCase()
    if (lowerReply === 'y') {
      await session.execute(`nh.download ${currentId}`)
      break
    } else if (lowerReply === 'f') {
      await session.send('正在进行一次天降好运...')
      const randomId = await nhentaiService.getRandomGalleryId()
      if (!randomId) {
        await session.send('获取随机画廊ID失败。')
        break
      }
      currentId = randomId
      continue
    } else if (lowerReply === 'n') {
      await session.send('操作已取消。')
      break
    } else {
      await session.send('无效输入，操作已取消。')
      break
    }
  }
}

export async function handleIdSearchWithMenu(
  session: Session,
  id: string,
  nhentaiService: NhentaiService,
  menuService: MenuService,
  config: Config,
): Promise<void> {
  const result = await nhentaiService.getGalleryWithCover(id)
  if (!result) {
    await session.send(`获取画廊 ${id} 信息失败，请检查ID是否正确。`)
    return
  }

  const { gallery, cover } = result
  const coverBuffer = cover ? cover.buffer : Buffer.alloc(0)

  try {
    await menuService.sendDetailMenu(session, gallery, coverBuffer, false)

    const reply = await session.prompt(config.promptTimeout * 1000)
    if (!reply) {
      await session.send('操作超时，已自动取消。')
    } else if (reply.toLowerCase() === 'y') {
      await session.execute(`nh.download ${id}`)
    } else if (reply.toLowerCase() === 'n') {
      await session.send('操作已取消。')
    } else {
       await session.send('无效输入，操作已取消。')
    }

  } catch (error: any) {
    logger.error(`详细菜单处理失败: ${getErrorMessage(error)}`)
    await session.send('菜单生成失败，将使用传统模式显示结果。')
    await handleIdSearch(session, id, nhentaiService, config, {
      useForward: config.textMode.useForward,
      showTags: config.textMode.showTags,
      showLink: config.textMode.showLink,
      promptDownload: true
    })
  }
}

export async function handleIdSearch(
  session: Session,
  id: string,
  nhentaiService: NhentaiService,
  config: Config,
  options: SearchHandlerOptions & { promptDownload?: boolean } = {},
): Promise<void> {
  const { useForward = true, forwardSupportedPlatforms = FORWARD_SUPPORTED_PLATFORMS, promptDownload = false } = options

  const result = await nhentaiService.getGalleryWithCover(id)
  if (!result) {
    await session.send(`获取画廊 ${id} 信息失败，请检查ID是否正确。`)
    return
  }

  const { gallery, cover } = result
  const galleryNode = formatGalleryInfo(gallery, undefined, {
    showTags: config.textMode.showTags,
    showLink: config.textMode.showLink,
  })
  const messageContent = h('message', {}, galleryNode)
  if (cover && cover.buffer && config.textMode.showThumbnails) {
    messageContent.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
  }

  await sendWithOptionalForward(session, messageContent, useForward, forwardSupportedPlatforms)

  if (promptDownload) {
    await session.send(`是否下载 ID ${id} 的漫画? [Y/N]`)
    const reply = await session.prompt(config.promptTimeout * 1000)
    if (!reply) {
      await session.send('操作超时，已自动取消。')
    } else if (reply.toLowerCase() === 'y') {
      await session.execute(`nh.download ${id}`)
    } else {
      await session.send('操作已取消。')
    }
  }
}

export async function handleKeywordSearchWithMenu(
  session: Session,
  query: string,
  options: SearchOptions,
  apiService: ApiService,
  nhentaiService: NhentaiService,
  menuService: MenuService,
  config: Config,
): Promise<void> {
  const sort = options.sort, lang = options.lang || config.defaultSearchLanguage, limit = config.menuMode.columns * config.menuMode.maxRows
  const effectiveQuery = buildSearchQuery(query, lang)
  const initialResult = await apiService.searchGalleries(effectiveQuery, 1, sort)

  if (!initialResult || initialResult.result.length === 0) {
    await session.send(`未找到与"${query}"相关的漫画。`)
    return
  }

  try {
    await handlePagination(
      session,
      query,
      initialResult,
      effectiveQuery,
      sort,
      limit,
      apiService,
      config,
      async (displayedResults, startIndex, totalResults) => {
        await menuService.sendSearchMenu(session, displayedResults, totalResults, startIndex)
      },
      async (galleryId) => {
        menuService.clearMenu(session)
        await session.execute(`nh.download ${galleryId}`)
      },
      () => menuService.clearMenu(session),
    )
  } catch (error: any) {
    logger.error(`图片菜单处理失败: ${getErrorMessage(error)}`)
    await session.send('菜单生成失败，将使用传统模式显示搜索结果。')
    await handleKeywordSearch(session, query, options, apiService, nhentaiService, config)
  }
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
    forwardSupportedPlatforms = FORWARD_SUPPORTED_PLATFORMS,
    showTags = true,
    showLink = true,
  } = handlerOptions

  const limit = config.textMode.searchResultLimit > 0 ? config.textMode.searchResultLimit : 10, sort = options.sort, lang = options.lang || config.defaultSearchLanguage
  const effectiveQuery = buildSearchQuery(query, lang)
  const initialResult = await apiService.searchGalleries(effectiveQuery, 1, sort)

  if (!initialResult || initialResult.result.length === 0) {
    await session.send(`未找到与"${query}"相关的漫画。`)
    return
  }

  await handlePagination(
    session,
    query,
    initialResult,
    effectiveQuery,
    sort,
    limit,
    apiService,
    config,
    async (displayedResults, startIndex, totalResults) => {
      const covers = config.textMode.showThumbnails
        ? await nhentaiService.getCoversForGalleries(displayedResults)
        : new Map()
      const messageNodes = displayedResults.map((gallery, index) => {
        const galleryInfoNode = formatGalleryInfo(gallery, index, { showTags, showLink })
        const cover = covers.get(gallery.id as string)
        const messageNode = h('message', {}, galleryInfoNode)
        if (cover && cover.buffer && config.textMode.showThumbnails) {
          messageNode.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
        }
        return messageNode
      })

      const totalDisplayPages = Math.ceil(totalResults / limit)
      const headerText = `共约 ${totalResults} 个结果, 当前显示 ${startIndex + 1}-${
        startIndex + displayedResults.length
      } (第 ${Math.floor(startIndex / limit) + 1} / ${totalDisplayPages} 页)`
      const header = h('message', {}, h('p', headerText))

      await sendWithOptionalForward(session, [header, ...messageNodes], useForward, forwardSupportedPlatforms)
    },
    async (galleryId) => {
      await session.execute(`nh.download ${galleryId}`)
    },
  )
}

export async function handleDownloadCommand(
  session: Session,
  id: string,
  options: DownloadOptions,
  statusMessageId: string,
  nhentaiService: NhentaiService,
  config: Config,
  baseDir?: string,
): Promise<void> {
  let tempPdfPath: string | undefined, shouldCleanupPdf = false

  try {
    const outputType: 'zip' | 'pdf' | 'img' = options.pdf ? 'pdf' : options.zip ? 'zip' : options.image ? 'img' : config.defaultOutput, password = options.key || config.defaultPassword

    const result = await nhentaiService.downloadGallery(id, outputType, password)

    if ('error' in result) {
      await session.send(result.error)
      return
    }

    let successMessage = `任务完成: ${result.filename.split('.').slice(0, -1).join('.')}`
    if (['zip', 'pdf'].includes(result.type) && password) {
      successMessage += `\n密码: ${password}`
    }

    switch (result.type) {
      case 'pdf':
        tempPdfPath = result.path
        shouldCleanupPdf = result.isTemporary
        if (config.fileSendMethod === 'buffer') {
          const pdfBuffer = await readFile(tempPdfPath)
          await session.send(h.file(pdfBuffer, 'application/pdf', { title: result.filename }))
        } else {
          await session.send(h.file(pathToFileURL(tempPdfPath).href, { title: result.filename }))
        }
        break

      case 'zip':
        if (config.fileSendMethod === 'buffer') {
          await session.send(h.file(result.buffer, 'application/zip', { title: result.filename }))
        } else {
          // file 模式：将 ZIP 保存为临时文件后发送文件路径
          const { writeFile } = await import('fs/promises')
          const { join, resolve } = await import('path')
          // 使用 baseDir 解析绝对路径，确保在 Docker 容器中正确工作
          const downloadDir = baseDir ? resolve(baseDir, config.downloadPath) : config.downloadPath
          const tempZipPath = join(downloadDir, `temp_${id}_${Date.now()}.zip`)
          await writeFile(tempZipPath, result.buffer)
          await session.send(h.file(pathToFileURL(tempZipPath).href, { title: result.filename }))
          // 发送后立即删除临时文件
          await rm(tempZipPath, { force: true }).catch(e => {
            if (config.debug) logger.warn('删除临时 ZIP 文件失败: %o', e)
          })
        }
        break

      case 'images':
        const useForward = config.useForwardForDownload && FORWARD_SUPPORTED_PLATFORMS.includes(session.platform), imageElements = result.images

        if (useForward) {
          const imageMessages = imageElements
            .filter((item) => !!item.buffer)
            .map((item) => h('message', {}, [h.image(bufferToDataURI(item.buffer as Buffer, `image/${item.extension}`))]))
          if (imageMessages.length > 0) {
            await session.send(h('message', { forward: true }, imageMessages))
          }
        } else {
          for (let i = 0; i < imageElements.length; i++) {
            const { index, buffer, extension } = imageElements[i]
            if (!buffer) continue
            await session.send(
              `正在发送图片: ${index + 1} / ${result.images.length + result.failedIndexes.length}` +
                h.image(bufferToDataURI(buffer as Buffer, `image/${extension}`)),
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
