// src/formatters/gallery-formatter.ts
import { h } from 'koishi'
import { Gallery, Tag } from '../types'

/**
 * 标签类型显示映射
 */
export const tagTypeDisplayMap: Record<Tag['type'], string> = {
  parody: '🎭 原作',
  character: '👥 角色',
  artist: '👤 作者',
  group: '🏢 社团',
  language: '🌐 语言',
  category: '📚 分类',
  tag: '🏷️ 标签',
}

/**
 * 格式化画廊信息为消息节点
 */
export function formatGalleryInfo(
  gallery: Partial<Gallery>,
  displayIndex?: number,
  options: {
    showTags?: boolean
    showLink?: boolean
  } = {}
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

  for (const type in tagTypeDisplayMap) {
    const key = type as Tag['type']
    if (tagsByType[key] && showTags) {
      let names = tagsByType[key]

      if (key === 'language') {
        names = names.map(name => name.replace(/\b\w/g, l => l.toUpperCase()))
      }

      if (key === 'tag' && names.length > TAG_LIMIT) {
        names = [...names.slice(0, TAG_LIMIT), '...']
      }

      infoLines.push(`${tagTypeDisplayMap[key]}: ${names.join(', ')}`)
    }
  }

  if (showLink && gallery.id) {
    infoLines.push(`🔗 链接: https://nhentai.net/g/${gallery.id}/`)
  }

  return h('p', infoLines.join('\n'))
}

