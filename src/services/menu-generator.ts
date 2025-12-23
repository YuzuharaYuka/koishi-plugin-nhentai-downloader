import { Gallery } from '../types'
import { Config } from '../config'
import { logger } from '../utils'
import { createCanvas, loadImage, Image, GlobalFonts } from '../processors/canvas-processor'

// 菜单生成器配置接口
export interface MenuGeneratorOptions {
  columns: number, maxRows: number, thumbWidth: number, thumbHeight: number,
  canvasWidth: number, titleFontSize: number, infoFontSize: number, indexFontSize: number,
  padding: number, gap: number
}

const defaultOptions: MenuGeneratorOptions = {
  columns: 3,
  maxRows: 3,
  thumbWidth: 250,
  thumbHeight: 350,
  canvasWidth: 900,
  titleFontSize: 32,
  infoFontSize: 18,
  indexFontSize: 24,
  padding: 24,
  gap: 30,
}

// CJK 字体检测关键词
const CJK_FONT_KEYWORDS = [
  'cjk', 'noto', 'wenquanyi', 'wqy', 'droid',
  'han', 'chinese', 'japanese', 'korean',
  'pingfang', 'hiragino', 'microsoft yahei', 'simhei',
  'arial unicode', 'dejavu', 'liberation',
] as const

// 卡片样式配置
const CARD_STYLES = {
  cardBg: '#252525',
  cardBorder: '#3a3a3a',
  infoBg: '#1e1e1e',
  placeholderBg: '#151515',
  canvasBg: '#121212',
  titleColor: '#ffffff',
  infoColor: '#b0b0b0',
  placeholderColor: '#555555',
  badgeSize: 36,
  badgeBg: '#e91e63',
  badgeBorder: 'rgba(255, 255, 255, 0.2)',
  badgeText: '#ffffff',
  langBg: '#2e7d32',
  langText: '#ffffff',
  tagBg: '#424242',
  tagText: '#e0e0e0',
  cardRadius: 10,
  infoAreaHeight: 140,
  lineHeight: 1.5,
  shadowColor: 'rgba(0, 0, 0, 0.5)',
  shadowBlur: 12,
  shadowOffsetX: 0,
  shadowOffsetY: 6,
} as const

// 语言名称映射
const LANG_MAP: Record<string, string> = {
  'chinese': 'Chinese',
  'english': 'English',
  'japanese': 'Japanese',
  'translated': 'Translated',
} as const

// 字体常量
const CJK_FONT_FAMILY = '"Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif'

// 图片菜单生成服务
export class MenuGenerator {
  private options: MenuGeneratorOptions
  private fontLoaded: boolean = false

  constructor(private config: Config, options?: Partial<MenuGeneratorOptions>) {
    this.options = { ...defaultOptions, ...options }
    this.loadFonts()
  }

  // 加载中文字体
  private async loadFonts(): Promise<void> {
    if (this.fontLoaded) return

    try {
      // @napi-rs/canvas 会自动加载系统字体，无需手动注册
      const systemFonts = GlobalFonts.families
      const cjkFonts = systemFonts.filter((font: any) =>
        CJK_FONT_KEYWORDS.some(keyword =>
          font.family.toLowerCase().includes(keyword)
        )
      )

      if (cjkFonts.length > 0) {
        this.fontLoaded = true
        if (this.config.debug) {
          logger.info(`检测到 ${cjkFonts.length} 个 CJK 字体`)
        }
      } else {
        this.fontLoaded = true // Canvas 会 fallback 到默认字体
        if (this.config.debug) {
          logger.warn('未检测到专用 CJK 字体，将使用系统默认字体渲染中文')
        }
      }
    } catch (error) {
      this.fontLoaded = true // 避免重复尝试
      if (this.config.debug) {
        logger.error(`字体检测失败: ${error.message}，将使用系统默认字体`)
      }
    }
  }

  // 截断文本以适应宽度
  private truncateText(ctx: any, text: string, maxWidth: number): string {
    const ellipsis = '...'
    let truncated = text

    while (ctx.measureText(truncated + ellipsis).width > maxWidth && truncated.length > 0) {
      truncated = truncated.slice(0, -1)
    }

    return truncated === text ? text : truncated + ellipsis
  }

  // 分行截断长标题
  private splitLongTitle(ctx: any, title: string, maxLineWidth: number): { firstLine: string; secondLine: string } {
    let firstLine = title, secondLine = ''
    if (ctx.measureText(title).width <= maxLineWidth) return { firstLine, secondLine }

    let splitIndex = title.length
    while (splitIndex > 0 && ctx.measureText(title.substring(0, splitIndex)).width > maxLineWidth) {
      splitIndex--
    }

    if (splitIndex > 0) {
      firstLine = title.substring(0, splitIndex)
      secondLine = title.substring(splitIndex)
      if (ctx.measureText(secondLine).width > maxLineWidth) {
        secondLine = this.truncateText(ctx, secondLine, maxLineWidth)
      }
    } else {
      firstLine = this.truncateText(ctx, title, maxLineWidth)
    }
    return { firstLine, secondLine }
  }

  // 获取语言标签文本
  private getLanguageTagText(languages: string[]): string {
    if (languages.length === 0) return ''
    let langTag = LANG_MAP[languages[0]] || languages[0].toUpperCase()
    if (languages.includes('translated') && languages.length > 1) {
      const mainLang = languages.find(l => l !== 'translated')
      if (mainLang) {
        langTag = `Translated: ${LANG_MAP[mainLang] || mainLang}`
      }
    }
    return langTag
  }

  // 获取重要标签（Parody > Artist > Character）
  private getImportantTags(gallery: Partial<Gallery>): string[] {
    const tags: string[] = []
    if (!gallery.tags) return tags

    const parodies = gallery.tags.filter(t => t.type === 'parody').map(t => t.name)
    const artists = gallery.tags.filter(t => t.type === 'artist').map(t => t.name)
    // const characters = gallery.tags.filter(t => t.type === 'character').map(t => t.name)

    if (parodies.length > 0) tags.push(parodies[0])
    if (artists.length > 0) tags.push(artists[0])
    // if (tags.length < 2 && characters.length > 0) tags.push(characters[0])

    return tags.slice(0, 2) // 最多显示2个额外标签
  }

  // 绘制标签
  private drawTag(
    ctx: any,
    text: string,
    x: number,
    y: number,
    bgColor: string,
    textColor: string
  ): number {
    // 增大标签字体
    const fontSize = this.options.infoFontSize - 4
    ctx.font = `${fontSize}px Arial, sans-serif`
    const paddingX = 10
    const paddingY = 5
    const textMetrics = ctx.measureText(text)
    const width = textMetrics.width + paddingX * 2
    const height = fontSize + paddingY * 2

    ctx.fillStyle = bgColor
    this.drawRoundedRect(ctx, x, y, width, height, 6)
    ctx.fill()

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = textColor
    ctx.fillText(text, x + paddingX, y + height / 2 + 1)

    return width
  }

  // 绘制圆角矩形
  private drawRoundedRect(ctx: any, x: number, y: number, width: number, height: number, radius: number): void {
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + width - radius, y)
    ctx.arcTo(x + width, y, x + width, y + radius, radius)
    ctx.lineTo(x + width, y + height - radius)
    ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius)
    ctx.lineTo(x + radius, y + height)
    ctx.arcTo(x, y + height, x, y + height - radius, radius)
    ctx.lineTo(x, y + radius)
    ctx.arcTo(x, y, x + radius, y, radius)
    ctx.closePath()
  }

  // 绘制单个画廊卡片
  private async drawGalleryCard(
    ctx: any,
    gallery: Partial<Gallery>,
    thumbnail: Buffer,
    index: number,
    x: number,
    y: number
  ): Promise<void> {
    const { thumbWidth, thumbHeight, infoFontSize, indexFontSize } = this.options
    const cardHeight = thumbHeight + CARD_STYLES.infoAreaHeight

    // 绘制卡片阴影和背景
    ctx.save()
    ctx.shadowColor = CARD_STYLES.shadowColor
    ctx.shadowBlur = CARD_STYLES.shadowBlur
    ctx.shadowOffsetX = CARD_STYLES.shadowOffsetX
    ctx.shadowOffsetY = CARD_STYLES.shadowOffsetY

    ctx.fillStyle = CARD_STYLES.cardBg
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, CARD_STYLES.cardRadius)
    ctx.fill()
    ctx.restore()

    // 绘制卡片边框
    ctx.strokeStyle = CARD_STYLES.cardBorder
    ctx.lineWidth = 1
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, CARD_STYLES.cardRadius)
    ctx.stroke()

    // 检查缩略图是否有效
    if (!thumbnail || thumbnail.length === 0) {
      // 显示占位符
      ctx.fillStyle = CARD_STYLES.placeholderBg
      // 仅填充上半部分（缩略图区域）
      ctx.save()
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, CARD_STYLES.cardRadius)
      ctx.clip()
      ctx.fillRect(x, y, thumbWidth, thumbHeight)
      ctx.restore()

      ctx.fillStyle = CARD_STYLES.placeholderColor
      ctx.font = `${infoFontSize}px Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('无缩略图', x + thumbWidth / 2, y + thumbHeight / 2)
    } else {
      try {
        // 使用 Data URL 加载图片，避免 Buffer 兼容性问题
        const img = new Image()

        // 简单的 MIME 检测
        let mime = 'image/jpeg'
        if (thumbnail.length > 12 && thumbnail.slice(0, 4).toString() === 'RIFF' && thumbnail.slice(8, 12).toString() === 'WEBP') {
          mime = 'image/webp'
        } else if (thumbnail.length > 4 && thumbnail[0] === 0x89 && thumbnail.slice(1, 4).toString() === 'PNG') {
          mime = 'image/png'
        }

        img.src = `data:${mime};base64,${thumbnail.toString('base64')}`

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = (err) => reject(new Error('Image load failed'))
        })

        if (img.width === 0 || img.height === 0) {
          throw new Error('Image has 0 dimensions')
        }

        // 计算缩略图实际尺寸（保持宽高比，覆盖模式）
        const imgAspect = img.width / img.height
        const thumbAspect = thumbWidth / thumbHeight
        let drawWidth = thumbWidth
        let drawHeight = thumbHeight
        let drawX = x
        let drawY = y

        if (imgAspect > thumbAspect) {
          drawHeight = thumbWidth / imgAspect
          drawY = y + (thumbHeight - drawHeight) / 2
        } else {
          drawWidth = thumbHeight * imgAspect
          drawX = x + (thumbWidth - drawWidth) / 2
        }

        // 取整以避免渲染伪影
        drawX = Math.floor(drawX)
        drawY = Math.floor(drawY)
        drawWidth = Math.floor(drawWidth)
        drawHeight = Math.floor(drawHeight)

        ctx.save()
        try {
          // 创建圆角裁剪区域（仅针对顶部圆角）
          ctx.beginPath()
          ctx.moveTo(x + CARD_STYLES.cardRadius, y)
          ctx.lineTo(x + thumbWidth - CARD_STYLES.cardRadius, y)
          ctx.arcTo(x + thumbWidth, y, x + thumbWidth, y + CARD_STYLES.cardRadius, CARD_STYLES.cardRadius)
          ctx.lineTo(x + thumbWidth, y + thumbHeight)
          ctx.lineTo(x, y + thumbHeight)
          ctx.lineTo(x, y + CARD_STYLES.cardRadius)
          ctx.arcTo(x, y, x + CARD_STYLES.cardRadius, y, CARD_STYLES.cardRadius)
          ctx.closePath()
          ctx.clip()

          ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
        } finally {
          ctx.restore()
        }

        // 绘制序号标签 (圆形)
        const badgeRadius = CARD_STYLES.badgeSize / 2
        const badgeX = x + 10 + badgeRadius
        const badgeY = y + 10 + badgeRadius

        ctx.beginPath()
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2)
        ctx.fillStyle = CARD_STYLES.badgeBg
        ctx.fill()

        ctx.lineWidth = 2
        ctx.strokeStyle = CARD_STYLES.badgeBorder
        ctx.stroke()

        ctx.fillStyle = CARD_STYLES.badgeText
        ctx.font = `bold ${indexFontSize - 2}px Arial, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${index}`, badgeX, badgeY + 1)

      } catch (error) {
        // 缩略图加载失败显示占位符
        logger.error(`加载缩略图失败 (索引 ${index}, 大小: ${thumbnail.length} bytes): ${error.message}`)
        ctx.fillStyle = CARD_STYLES.placeholderBg
        ctx.save()
        this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, CARD_STYLES.cardRadius)
        ctx.clip()
        ctx.fillRect(x, y, thumbWidth, thumbHeight)
        ctx.restore()

        ctx.fillStyle = CARD_STYLES.placeholderColor
        ctx.font = `${infoFontSize}px Arial, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('加载失败', x + thumbWidth / 2, y + thumbHeight / 2)
      }
    }

    const infoY = y + thumbHeight
    // 绘制信息区域背景 (下半部分圆角)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, infoY)
    ctx.lineTo(x + thumbWidth, infoY)
    ctx.lineTo(x + thumbWidth, y + cardHeight - CARD_STYLES.cardRadius)
    ctx.arcTo(x + thumbWidth, y + cardHeight, x + thumbWidth - CARD_STYLES.cardRadius, y + cardHeight, CARD_STYLES.cardRadius)
    ctx.lineTo(x + CARD_STYLES.cardRadius, y + cardHeight)
    ctx.arcTo(x, y + cardHeight, x, y + cardHeight - CARD_STYLES.cardRadius, CARD_STYLES.cardRadius)
    ctx.lineTo(x, infoY)
    ctx.closePath()
    ctx.fillStyle = CARD_STYLES.infoBg
    ctx.fill()
    ctx.restore()

    // 绘制标题（支持两行显示）
    ctx.fillStyle = CARD_STYLES.titleColor
    ctx.font = `bold ${infoFontSize + 2}px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    const title = gallery.title?.pretty || gallery.title?.english || `ID ${gallery.id}`
    const { firstLine, secondLine } = this.splitLongTitle(ctx, title, thumbWidth - 24)
    ctx.fillText(firstLine, x + 12, infoY + 12)
    if (secondLine) {
      ctx.fillText(secondLine, x + 12, infoY + 12 + infoFontSize + 6)
    }

    // 绘制信息行 - ID | 页数 | 收藏
    // 动态计算 Y 坐标，确保在标题下方
    const infoLineY = infoY + 12 + (infoFontSize + 6) * 2 + 10
    ctx.font = `${infoFontSize}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = CARD_STYLES.infoColor
    ctx.textAlign = 'left'

    const id = gallery.id
    const pages = gallery.num_pages || '?'
    const fav = gallery.num_favorites || 0

    const infoText = `ID: ${id}  •  ${pages}P  •  ♥ ${fav}`
    ctx.fillText(infoText, x + 12, infoLineY)

    // 绘制标签行
    const tagY = infoLineY + infoFontSize + 12
    let currentX = x + 12

    // 1. 语言标签
    const languages = gallery.tags?.filter(tag => tag.type === 'language').map(tag => tag.name) || []
    const langText = this.getLanguageTagText(languages)
    if (langText) {
      currentX += this.drawTag(ctx, langText, currentX, tagY, CARD_STYLES.langBg, CARD_STYLES.langText) + 8
    }

    // 2. 重要标签 (Parody / Artist)
    const importantTags = this.getImportantTags(gallery)
    const fontSize = this.options.infoFontSize - 4
    ctx.font = `${fontSize}px Arial, sans-serif`
    const paddingX = 10

    for (const tag of importantTags) {
      // 截断过长的标签
      let displayTag = tag
      if (displayTag.length > 14) displayTag = displayTag.substring(0, 13) + '...'

      // 预计算标签宽度
      const textMetrics = ctx.measureText(displayTag)
      const tagWidth = textMetrics.width + paddingX * 2

      // 检查是否超出宽度 (保留 4px 右边距)
      if (currentX + tagWidth > x + thumbWidth - 4) break

      currentX += this.drawTag(ctx, displayTag, currentX, tagY, CARD_STYLES.tagBg, CARD_STYLES.tagText) + 8
    }
  }

  // 生成搜索结果菜单图片
  async generateMenu(
    galleries: Partial<Gallery>[],
    thumbnails: Buffer[],
    totalResults?: number,
    startIndex?: number
  ): Promise<Buffer> {
    const { columns, maxRows, thumbWidth, thumbHeight, padding, gap, titleFontSize, infoFontSize } = this.options

    // 计算实际显示的画廊数量
    const maxItems = columns * maxRows
    const displayCount = Math.min(galleries.length, maxItems)

    // 计算画布尺寸
    const rows = Math.ceil(displayCount / columns)
    const headerHeight = 80
    const footerHeight = 65 // 增加底部高度以容纳完整提示信息
    const cardHeight = thumbHeight + CARD_STYLES.infoAreaHeight // 确保与实际绘制高度一致

    // 动态计算画布宽度：根据列数自适应
    const totalCardsWidth = columns * thumbWidth + (columns - 1) * gap
    const canvasWidth = totalCardsWidth + padding * 2
    const canvasHeight = headerHeight + rows * cardHeight + (rows - 1) * gap + footerHeight + padding * 2

    // 创建画布
    const canvas = createCanvas(canvasWidth, canvasHeight)
    const ctx = canvas.getContext('2d')

    // 绘制纯黑背景
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    // 绘制顶部标题
    const titleY = padding + 5
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${titleFontSize}px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('搜索结果', canvasWidth / 2, titleY)

    // 绘制统计信息
    const statY = titleY + titleFontSize + 10
    ctx.font = `${infoFontSize}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = '#b0b0b0'
    if (totalResults !== undefined && totalResults !== null) {
      const start = (startIndex ?? 0) + 1, end = (startIndex ?? 0) + displayCount
      ctx.fillText(`共找到约 ${totalResults} 个结果，当前显示第 ${start}-${end} 项`, canvasWidth / 2, statY)
    } else {
      ctx.fillText(`当前显示 ${displayCount} 个结果`, canvasWidth / 2, statY)
    }

    // 计算卡片起始位置
    const startX = (canvasWidth - totalCardsWidth) / 2, startY = headerHeight + padding

    // 绘制所有画廊卡片
    for (let i = 0; i < displayCount; i++) {
      const row = Math.floor(i / columns), col = i % columns
      const x = startX + col * (thumbWidth + gap), y = startY + row * (cardHeight + gap)
      await this.drawGalleryCard(ctx, galleries[i], thumbnails[i], i + 1, x, y)
    }

    // 绘制底部提示
    const footerY = canvasHeight - footerHeight + 15
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'

    ctx.font = `${infoFontSize + 1}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = '#f5f5f5'
    ctx.fillText('回复序号下载对应漫画', canvasWidth / 2, footerY)

    ctx.font = `${infoFontSize - 1}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = '#b0b0b0'
    ctx.fillText('支持翻页 [F/B] 和退出 [N] 操作', canvasWidth / 2, footerY + 24)

    // 输出为 PNG Buffer
    return canvas.toBuffer('image/png')
  }

  // 生成单个画廊的详细信息卡片
  async generateGalleryCard(gallery: Gallery, coverImage: Buffer): Promise<Buffer> {
    const cardWidth = 600, cardHeight = 800, coverWidth = 400, coverHeight = 550
    const canvas = createCanvas(cardWidth, cardHeight)
    const ctx = canvas.getContext('2d')

    // 绘制背景
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, cardWidth, cardHeight)

    // 绘制标题区域
    ctx.fillStyle = '#2a2a2a'
    ctx.fillRect(0, 0, cardWidth, 80)

    // 绘制标题
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold 24px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const title = gallery.title?.pretty || gallery.title?.english || `作品 ${gallery.id}`
    const truncatedTitle = this.truncateText(ctx, title, cardWidth - 40)
    ctx.fillText(truncatedTitle, cardWidth / 2, 40)

    try {
      // 使用 Data URL 加载图片
      const img = new Image()

      // 简单的 MIME 检测
      let mime = 'image/jpeg'
      if (coverImage.length > 12 && coverImage.slice(0, 4).toString() === 'RIFF' && coverImage.slice(8, 12).toString() === 'WEBP') {
        mime = 'image/webp'
      } else if (coverImage.length > 4 && coverImage[0] === 0x89 && coverImage.slice(1, 4).toString() === 'PNG') {
        mime = 'image/png'
      }

      img.src = `data:${mime};base64,${coverImage.toString('base64')}`

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = (err) => reject(new Error('Image load failed'))
      })

      if (img.width === 0 || img.height === 0) {
        throw new Error('Image has 0 dimensions')
      }

      const x = (cardWidth - coverWidth) / 2, y = 100
      ctx.save()
      try {
        this.drawRoundedRect(ctx, x, y, coverWidth, coverHeight, 12)
        ctx.clip() // 圆角裁剪
        ctx.drawImage(img, x, y, coverWidth, coverHeight)
      } finally {
        ctx.restore()
      }
    } catch (error) {
      logger.warn(`封面加载失败: ${error.message}`)
    }

    // 绘制信息
    const infoY = 670
    ctx.fillStyle = '#cccccc'
    ctx.font = `18px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'center'

    const info = [
      `ID: ${gallery.id}`,
      `页数: ${gallery.num_pages}`,
      `收藏: ${gallery.num_favorites}`,
    ]

    ctx.fillText(info.join(' | '), cardWidth / 2, infoY)

    return canvas.toBuffer('image/png')
  }

  // 释放资源
  dispose(): void {
    if (this.config.debug) {
      logger.info('菜单生成器已清理')
    }
  }
}
