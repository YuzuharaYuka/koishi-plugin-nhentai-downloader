import { Gallery } from '../types'
import { Config } from '../config'
import { logger } from '../utils'

// 延迟加载 @napi-rs/canvas（避免在模块初始化时加载）
let canvasModule: any = null
let isCanvasInitialized = false

async function ensureCanvasInitialized() {
  if (!isCanvasInitialized) {
    try {
      canvasModule = await import('@napi-rs/canvas')
      isCanvasInitialized = true
    } catch (error) {
      throw new Error(`Failed to load @napi-rs/canvas: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return canvasModule
}

// 菜单生成器配置接口
export interface MenuGeneratorOptions {
  columns: number, maxRows: number, thumbWidth: number, thumbHeight: number,
  canvasWidth: number, titleFontSize: number, infoFontSize: number, indexFontSize: number,
  padding: number, gap: number
}

const defaultOptions: MenuGeneratorOptions = {
  columns: 3,
  maxRows: 3,
  thumbWidth: 240,
  thumbHeight: 320,
  canvasWidth: 800,
  titleFontSize: 26,
  infoFontSize: 14,
  indexFontSize: 22,
  padding: 20,
  gap: 16,
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
  cardBg: '#1e1e1e',
  cardBorder: '#2a2a2a',
  infoBg: '#0a0a0a',
  placeholderBg: '#151515',
  canvasBg: '#000000',
  titleColor: '#f5f5f5',
  infoColor: '#c0c0c0',
  placeholderColor: '#555555',
  badgeSize: 44,
  badgeBg: 'rgba(0, 0, 0, 0.75)',
  badgeBorder: 'rgba(255, 255, 255, 0.2)',
  badgeText: '#ffffff',
  langBg: '#1a3a1a',
  langText: '#7ed87e',
  cardRadius: 6,
  infoAreaHeight: 90,
  lineHeight: 2,
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
  private canvasLib: any = null

  constructor(private config: Config, options?: Partial<MenuGeneratorOptions>) {
    this.options = { ...defaultOptions, ...options }
    this.loadFonts()
  }

  // 加载中文字体
  private async loadFonts(): Promise<void> {
    if (this.fontLoaded) return

    try {
      const canvasLib = await ensureCanvasInitialized()
      // @napi-rs/canvas 会自动加载系统字体，无需手动注册
      const systemFonts = canvasLib.GlobalFonts.families
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

  // 绘制语言标签
  private drawLanguageTag(
    ctx: any,
    languages: string[],
    x: number,
    y: number,
    width: number
  ): void {
    const langTag = this.getLanguageTagText(languages)
    if (!langTag) return

    ctx.font = `${this.options.infoFontSize - 3}px Arial, sans-serif`
    const langWidth = ctx.measureText(langTag).width + 10
    const langX = x + (width - langWidth) / 2

    ctx.fillStyle = CARD_STYLES.langBg
    this.drawRoundedRect(ctx, langX, y, langWidth, 16, 3)
    ctx.fill()

    ctx.textAlign = 'left'
    ctx.fillStyle = CARD_STYLES.langText
    ctx.fillText(langTag, langX + 5, y + 3)
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
    // 获取已初始化的 canvas 库
    if (!this.canvasLib) {
      this.canvasLib = await ensureCanvasInitialized()
    }
    const { loadImage } = this.canvasLib

    const { thumbWidth, thumbHeight, infoFontSize, indexFontSize } = this.options
    const cardHeight = thumbHeight + CARD_STYLES.infoAreaHeight

    ctx.fillStyle = CARD_STYLES.cardBg // 卡片背景
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, CARD_STYLES.cardRadius)
    ctx.fill()

    ctx.strokeStyle = CARD_STYLES.cardBorder // 细边框
    ctx.lineWidth = 1
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, CARD_STYLES.cardRadius)
    ctx.stroke()

    try {
      const img = await loadImage(thumbnail)

      // 计算缩略图实际尺寸（保持宽高比）
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

      ctx.save()
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, 6)
      ctx.clip() // 裁剪为圆角
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
      ctx.restore()

      // 绘制序号标签
      const badgeX = x + 8, badgeY = y + 8
      ctx.fillStyle = CARD_STYLES.badgeBg
      this.drawRoundedRect(ctx, badgeX, badgeY, CARD_STYLES.badgeSize, CARD_STYLES.badgeSize, 6)
      ctx.fill()

      ctx.strokeStyle = CARD_STYLES.badgeBorder
      ctx.lineWidth = 1.5
      this.drawRoundedRect(ctx, badgeX, badgeY, CARD_STYLES.badgeSize, CARD_STYLES.badgeSize, 6)
      ctx.stroke()

      ctx.fillStyle = CARD_STYLES.badgeText
      ctx.font = `bold ${indexFontSize}px Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${index}`, badgeX + CARD_STYLES.badgeSize / 2, badgeY + CARD_STYLES.badgeSize / 2)

    } catch (error) {
      // 缩略图加载失败显示占位符
      ctx.fillStyle = CARD_STYLES.placeholderBg
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, CARD_STYLES.cardRadius)
      ctx.fill()

      ctx.fillStyle = CARD_STYLES.placeholderColor
      ctx.font = `${infoFontSize}px Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('加载失败', x + thumbWidth / 2, y + thumbHeight / 2)
    }

    const infoY = y + thumbHeight
    ctx.fillStyle = CARD_STYLES.infoBg
    ctx.fillRect(x, infoY, thumbWidth, CARD_STYLES.infoAreaHeight)

    // 绘制标题（支持两行显示）
    ctx.fillStyle = CARD_STYLES.titleColor
    ctx.font = `${infoFontSize}px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    const title = gallery.title?.pretty || gallery.title?.english || `ID ${gallery.id}`
    const { firstLine, secondLine } = this.splitLongTitle(ctx, title, thumbWidth - 16)
    ctx.fillText(firstLine, x + 8, infoY + 6)
    if (secondLine) {
      ctx.fillText(secondLine, x + 8, infoY + 6 + infoFontSize + 2)
    }
    // 绘制信息行 - ID居左、页数居中、收藏居右（两行标题位置固定）
    const infoLineY = infoY + 46
    ctx.font = `${infoFontSize - 2}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = CARD_STYLES.infoColor

    const id = gallery.id, pages = gallery.num_pages || '?', fav = gallery.num_favorites || 0
    ctx.textAlign = 'left'
    ctx.fillText(`ID: ${id}`, x + 8, infoLineY) // 左侧
    ctx.textAlign = 'center'
    ctx.fillText(`页数: ${pages}`, x + thumbWidth / 2, infoLineY) // 中间
    ctx.textAlign = 'right'
    ctx.fillText(`收藏: ${fav}`, x + thumbWidth - 8, infoLineY) // 右侧

    // 语言标签（居中显示）
    const languages = gallery.tags?.filter(tag => tag.type === 'language').map(tag => tag.name) || []
    if (languages.length > 0) {
      this.drawLanguageTag(ctx, languages, x, infoLineY + 20, thumbWidth)
    }
  }

  // 生成搜索结果菜单图片
  async generateMenu(
    galleries: Partial<Gallery>[],
    thumbnails: Buffer[],
    totalResults?: number,
    startIndex?: number
  ): Promise<Buffer> {
    // 延迟加载 canvas（仅在需要时加载）
    const canvasLib = await ensureCanvasInitialized()
    const { createCanvas, loadImage } = canvasLib

    const { columns, maxRows, thumbWidth, thumbHeight, padding, gap, titleFontSize, infoFontSize } = this.options

    // 计算实际显示的画廊数量
    const maxItems = columns * maxRows
    const displayCount = Math.min(galleries.length, maxItems)

    // 计算画布尺寸
    const rows = Math.ceil(displayCount / columns)
    const headerHeight = 80
    const footerHeight = 65 // 增加底部高度以容纳完整提示信息
    const cardHeight = thumbHeight + 90 // 与信息区域高度保持一致

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
    // 延迟加载 canvas（仅在需要时加载）
    if (!this.canvasLib) {
      this.canvasLib = await ensureCanvasInitialized()
    }
    const { createCanvas, loadImage } = this.canvasLib

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
      // 绘制封面
      const img = await loadImage(coverImage)
      const x = (cardWidth - coverWidth) / 2, y = 100
      ctx.save()
      this.drawRoundedRect(ctx, x, y, coverWidth, coverHeight, 12)
      ctx.clip() // 圆角裁剪
      ctx.drawImage(img, x, y, coverWidth, coverHeight)
      ctx.restore()
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
