// src/handlers/search-handler.ts
import { Session } from 'koishi'
import { Config } from '../config'
import { logger, bufferToDataURI } from '../utils'
import { Gallery, SearchResult } from '../types'
import { ApiService } from '../services/api'
import { NhentaiService } from '../services/nhentai'
import { formatGalleryInfo } from '../formatters/gallery-formatter'
import { h } from 'koishi'

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

/**
 * 构建搜索查询队列（优先级列表）
 */
export function buildSearchQueryQueue(
  query: string,
  lang: SearchOptions['lang']
): { query: string; message: string }[] {
  const baseQuery = query.trim()

  const buildQuery = (langFilter: string) => {
    // 避免重复添加过滤器
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

/**
 * 处理ID搜索
 */
export async function handleIdSearch(
  session: Session,
  id: string,
  nhentaiService: NhentaiService,
  config: Config,
  options: SearchHandlerOptions = {}
): Promise<void> {
  const { useForward = true, forwardSupportedPlatforms = ['qq', 'onebot'] } = options

  const result = await nhentaiService.getGalleryWithCover(id)
  if (!result) {
    await session.send(`获取画廊 ${id} 信息失败，请检查ID或链接是否正确。`)
    return
  }

  const { gallery, cover } = result
  const galleryNode = formatGalleryInfo(gallery, undefined, {
    showTags: config.showTagsInSearch,
    showLink: config.showLinkInSearch,
  })
  const message = h('message', galleryNode)
  if (cover) {
    message.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
  }

  if (useForward && forwardSupportedPlatforms.includes(session.platform)) {
    await session.send(h('figure', {}, message))
  } else {
    await session.send(message)
  }
}

/**
 * 处理关键词搜索
 */
export async function handleKeywordSearch(
  session: Session,
  query: string,
  options: SearchOptions,
  apiService: ApiService,
  nhentaiService: NhentaiService,
  config: Config,
  handlerOptions: SearchHandlerOptions = {}
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

  // 遍历查询队列找到结果
  for (const { query: currentQuery, message } of queryQueue) {
    effectiveQuery = currentQuery
    if (message) {
      await session.send(message)
    }
    const result = await apiService.searchGalleries(effectiveQuery, 1, sort)
    if (result && result.result.length > 0) {
      initialResult = result
      break // 找到结果，退出循环
    }
  }

  if (!initialResult) {
    await session.send(`未找到与"${query}"相关的漫画。`)
    return
  }

  let allResults: Partial<Gallery>[] = initialResult.result
  let totalApiPages = initialResult.num_pages
  let totalResultsCount = initialResult.num_pages * initialResult.per_page
  let fetchedApiPage = 1
  let currentDisplayPage = 1

  const fetchApiPage = async (apiPageNum: number) => {
    const result = await apiService.searchGalleries(effectiveQuery, apiPageNum, sort)
    if (!result || result.result.length === 0) return false

    allResults.push(...result.result)
    // API 可能在后续请求中返回稍有不同的总页数，需要更新
    if (result.num_pages > totalApiPages) totalApiPages = result.num_pages
    fetchedApiPage = apiPageNum
    return true
  }

  let displayedResults: Partial<Gallery>[] = []

  while (true) {
    const startIndex = (currentDisplayPage - 1) * limit
    const endIndex = startIndex + limit

    while (endIndex > allResults.length && fetchedApiPage < totalApiPages) {
      await session.send(
        h('quote', { id: session.messageId }) +
          `正在加载更多结果 (第 ${fetchedApiPage + 1} / ${totalApiPages} API页)...`
      )
      await fetchApiPage(fetchedApiPage + 1)
    }

    displayedResults = allResults.slice(startIndex, endIndex)

    if (displayedResults.length === 0 && currentDisplayPage > 1) {
      await session.send('没有更多结果了。')
      currentDisplayPage--
      continue
    }

    if (displayedResults.length === 0 && currentDisplayPage === 1) {
      // 如果 initialResult 成功，这不应该发生，但作为安全措施
      await session.send(`未找到与"${query}"相关的漫画。`)
      return
    }

    const covers = await nhentaiService.getCoversForGalleries(displayedResults)

    const messageNodes: h[] = []
    for (const [index, gallery] of displayedResults.entries()) {
      const galleryInfoNode = formatGalleryInfo(gallery, index, {
        showTags: config.showTagsInSearch && showTags,
        showLink: config.showLinkInSearch && showLink,
      })
      const cover = covers.get(gallery.id as string)
      const messageNode = h('message', galleryInfoNode)
      if (cover) {
        messageNode.children.push(h.image(bufferToDataURI(cover.buffer, `image/${cover.extension}`)))
      }
      messageNodes.push(messageNode)
    }

    // 根据实际结果数量重新计算总显示页数
    const dynamicTotalResults = allResults.length < totalResultsCount ? allResults.length : totalResultsCount
    const totalDisplayPages = Math.ceil(dynamicTotalResults / limit)
    const headerText = `共约 ${totalResultsCount} 个结果, 当前显示第 ${startIndex + 1}-${startIndex + displayedResults.length} 条 (第 ${currentDisplayPage} / ${totalDisplayPages} 页)`
    const header = h('message', h('p', headerText))

    if (useForward && forwardSupportedPlatforms.includes(session.platform)) {
      await session.send(h('figure', {}, [header, ...messageNodes]))
    } else {
      await session.send([header, ...messageNodes.flatMap((m) => m.children)])
    }

    const prompts = ['回复序号下载']
    if (currentDisplayPage > 1) prompts.push('[B]上一页')
    if (currentDisplayPage < totalDisplayPages && endIndex < dynamicTotalResults) prompts.push('[F]下一页')
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
    } else if (lowerReply === 'f') {
      if (currentDisplayPage < totalDisplayPages && endIndex < dynamicTotalResults) {
        currentDisplayPage++
      } else {
        await session.send('已经是最后一页了。')
      }
    } else if (lowerReply === 'b') {
      if (currentDisplayPage > 1) {
        currentDisplayPage--
      } else {
        await session.send('已经是第一页了。')
      }
    } else if (/^\d+$/.test(reply)) {
      const selectedIndex = parseInt(reply, 10) - 1
      if (selectedIndex >= 0 && selectedIndex < displayedResults.length) {
        const gallery = displayedResults[selectedIndex]
        if (gallery?.id) {
          await session.execute(`nh download ${gallery.id}`)
          return
        }
      }
      await session.send('无效的选择，请输入列表中的序号。')
      break // 无效选择后退出
    } else {
      await session.send('无效的输入，已退出交互。')
      break // 无效输入直接退出
    }
  }
}

