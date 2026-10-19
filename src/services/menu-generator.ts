/**
 * 菜单渲染：搜索结果九宫格与作品详情卡片，输出 JPEG。
 *
 * 版式对齐 nhentai 官网：深色背景、封面在左、信息列用「标签 + 胶囊」的
 * 行式排布（原作 / 角色 / 作者 / 社团 / 类型 / 语言 / 标签），画布高度按内容自适应。
 */
import type { Gallery, MenuGallery } from '../types'
import type { Config } from '../config'
import { logger } from '../utils'
import { IMAGE_LOAD_TIMEOUT_MS, MENU_BACKGROUND_COLOR, MENU_JPEG_QUALITY } from '../constants'
import { createCanvas, Image, GlobalFonts } from '../processors/canvas-processor'

// 菜单生成器配置接口：画布宽度由列数与缩略图宽度动态计算
export interface MenuGeneratorOptions {
  columns: number, maxRows: number, thumbWidth: number, thumbHeight: number,
  titleFontSize: number, infoFontSize: number, indexFontSize: number,
  padding: number, gap: number
}

const defaultOptions: MenuGeneratorOptions = {
  columns: 3,
  maxRows: 3,
  thumbWidth: 250,
  thumbHeight: 350,
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

/** 统一色板，取自 nhentai 深色主题 */
const STYLE = {
  canvasBg: MENU_BACKGROUND_COLOR,
  cardBg: '#1c1c1c',
  cardBorder: '#2e2e2e',
  placeholderBg: '#181818',
  placeholderColor: '#9e9e9e',
  title: '#ededed',
  titleMuted: '#b8b8b8',
  label: '#8c8c8c',
  value: '#dcdcdc',
  meta: '#909090',
  divider: '#2e2e2e',
  chipBg: '#262626',
  chipBorder: '#383838',
  chipText: '#e8e8e8',
  chipCount: '#8a8a8a',
  accent: '#ed2553',
  badgeText: '#ffffff',
  cardRadius: 6,
  chipRadius: 4,
  chipHeight: 30,
  indexBadgeSize: 34,
} as const

/** 搜索结果卡片：标题两行 + 信息一行 */
const SEARCH_INFO_HEIGHT = 96
/** 含标签行的卡片（完整 Gallery）保留额外高度 */
const TAGGED_INFO_HEIGHT = 140

// 语言名称映射
const LANG_MAP: Record<string, string> = {
  'chinese': 'Chinese',
  'english': 'English',
  'japanese': 'Japanese',
  'translated': 'Translated',
} as const

const CJK_FONT_FAMILY = '"Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif'

interface DetailChip {
  name: string
  count?: string
}

interface DetailRow {
  label: string
  chips: DetailChip[]
}

// 图片菜单生成服务
export class MenuGenerator {
  private options: MenuGeneratorOptions
  private fontLoaded = false

  constructor(private config: Config, options?: Partial<MenuGeneratorOptions>) {
    this.options = { ...defaultOptions, ...options }
    this.loadFonts()
  }

  // 加载中文字体
  private async loadFonts(): Promise<void> {
    if (this.fontLoaded) return

    try {
      // @napi-rs/canvas 会自动加载系统字体，无需手动注册
      if (!GlobalFonts || !GlobalFonts.families) {
        throw new Error('GlobalFonts 未正确加载')
      }

      const cjkFonts = GlobalFonts.families.filter((font: any) =>
        CJK_FONT_KEYWORDS.some((keyword) => font.family.toLowerCase().includes(keyword)),
      )

      this.fontLoaded = true
      if (cjkFonts.length > 0) {
        if (this.config.debug) logger.info(`检测到 ${cjkFonts.length} 个 CJK 字体`)
      } else if (this.config.debug) {
        logger.warn('未检测到专用 CJK 字体，将使用系统默认字体渲染中文')
      }
    } catch (error) {
      this.fontLoaded = true
      if (this.config.debug) {
        const err = error instanceof Error ? error : new Error(String(error))
        logger.error(`字体检测失败: ${err.message}，将使用系统默认字体`)
      }
    }
  }

  // ─── 通用工具 ──────────────────────────────────────────────

  /** 解码图片；失败返回 null（由调用方画占位） */
  private async decodeImage(buffer: Buffer): Promise<Image | null> {
    if (!buffer || buffer.length === 0) return null
    try {
      const image = new Image()
      image.src = buffer
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('Image load failed'))
        }),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Image load timeout')), IMAGE_LOAD_TIMEOUT_MS)
        }),
      ])
      if (!image.width || !image.height) return null
      return image
    } catch {
      return null
    }
  }

  /** 截断文本以适应宽度 */
  private truncateText(ctx: any, text: string, maxWidth: number): string {
    const ellipsis = '…'
    let truncated = text
    while (ctx.measureText(truncated + ellipsis).width > maxWidth && truncated.length > 0) {
      truncated = truncated.slice(0, -1)
    }
    return truncated === text ? text : truncated.trimEnd() + ellipsis
  }

  /** 分行文本，尽量在空格、连字符或 CJK 边界处断开 */
  private splitLongTitle(ctx: any, title: string, maxLineWidth: number): { firstLine: string; secondLine: string } {
    if (ctx.measureText(title).width <= maxLineWidth) return { firstLine: title, secondLine: '' }

    let splitIndex = title.length
    while (splitIndex > 0 && ctx.measureText(title.substring(0, splitIndex)).width > maxLineWidth) {
      splitIndex--
    }
    if (splitIndex <= 0) return { firstLine: this.truncateText(ctx, title, maxLineWidth), secondLine: '' }

    const isBreakChar = (char: string) => /[\s\-–—/、，。！？：；）】」]/.test(char)
    const isWide = (char: string) => /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(char)
    let breakAt = splitIndex
    for (let i = splitIndex - 1; i > splitIndex - 16 && i > 0; i--) {
      if (isBreakChar(title[i])) {
        breakAt = i + 1
        break
      }
      if (isWide(title[i]) && isWide(title[i - 1])) {
        breakAt = i
        break
      }
    }

    const firstLine = title.substring(0, breakAt).trimEnd()
    let secondLine = title.substring(breakAt).trimStart()
    if (ctx.measureText(secondLine).width > maxLineWidth) {
      secondLine = this.truncateText(ctx, secondLine, maxLineWidth)
    }
    return { firstLine, secondLine }
  }

  // 绘制圆角矩形
  private drawRoundedRect(ctx: any, x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.min(radius, width / 2, height / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + width - r, y)
    ctx.arcTo(x + width, y, x + width, y + r, r)
    ctx.lineTo(x + width, y + height - r)
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
    ctx.lineTo(x + r, y + height)
    ctx.arcTo(x, y + height, x, y + height - r, r)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }

  // 数字缩写：125324 → 125.3K，2100000 → 2.1M
  private formatCount(count: number): string {
    if (!Number.isFinite(count) || count < 0) return '0'
    if (count >= 1000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`
    if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`
    return `${count}`
  }

  // 获取语言标签文本
  private getLanguageTagText(languages: string[]): string {
    if (languages.length === 0) return ''
    let langTag = LANG_MAP[languages[0]] || languages[0].toUpperCase()
    if (languages.includes('translated') && languages.length > 1) {
      const mainLang = languages.find((lang) => lang !== 'translated')
      if (mainLang) langTag = `Translated: ${LANG_MAP[mainLang] || mainLang}`
    }
    return langTag
  }

  // 获取重要标签（Parody > Artist）
  private getImportantTags(gallery: Partial<Gallery>): string[] {
    const tags: string[] = []
    if (!gallery.tags) return tags

    const parodies = gallery.tags.filter((tag) => tag.type === 'parody').map((tag) => tag.name)
    const artists = gallery.tags.filter((tag) => tag.type === 'artist').map((tag) => tag.name)
    if (parodies.length > 0) tags.push(parodies[0])
    if (artists.length > 0) tags.push(artists[0])
    return tags.slice(0, 2)
  }

  // ─── 胶囊标签 ─────────────────────────────────────────────

  /** 计算胶囊宽度：名称 + 可选的灰色计数 */
  private measureChip(ctx: any, name: string, count?: string): { width: number; nameWidth: number } {
    const paddingX = 11
    const gap = count ? 7 : 0
    ctx.font = `14px ${CJK_FONT_FAMILY}`
    let nameWidth = ctx.measureText(name).width
    // 过长的单个标签截断，避免一枚胶囊占满整行
    if (nameWidth > 200) {
      name = this.truncateText(ctx, name, 200)
      nameWidth = ctx.measureText(name).width
    }
    let width = nameWidth + paddingX * 2
    if (count) {
      ctx.font = `12px ${CJK_FONT_FAMILY}`
      width += gap + ctx.measureText(count).width
    }
    return { width, nameWidth }
  }

  /** 绘制胶囊标签，返回实际宽度 */
  private drawChip(ctx: any, x: number, y: number, name: string, count?: string): number {
    const paddingX = 11
    const gap = count ? 7 : 0
    const height = STYLE.chipHeight

    ctx.font = `14px ${CJK_FONT_FAMILY}`
    let nameWidth = ctx.measureText(name).width
    if (nameWidth > 200) {
      name = this.truncateText(ctx, name, 200)
      nameWidth = ctx.measureText(name).width
    }

    let countWidth = 0
    if (count) {
      ctx.font = `12px ${CJK_FONT_FAMILY}`
      countWidth = ctx.measureText(count).width
    }

    const width = nameWidth + paddingX * 2 + (count ? gap + countWidth : 0)

    ctx.fillStyle = STYLE.chipBg
    this.drawRoundedRect(ctx, x, y, width, height, STYLE.chipRadius)
    ctx.fill()
    ctx.strokeStyle = STYLE.chipBorder
    ctx.lineWidth = 1
    this.drawRoundedRect(ctx, x, y, width, height, STYLE.chipRadius)
    ctx.stroke()

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const textY = y + height / 2

    ctx.font = `14px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = STYLE.chipText
    ctx.fillText(name, x + paddingX, textY)

    if (count) {
      ctx.font = `12px ${CJK_FONT_FAMILY}`
      ctx.fillStyle = STYLE.chipCount
      ctx.fillText(count, x + paddingX + nameWidth + gap, textY)
    }

    return width
  }

  // ─── 搜索结果菜单 ─────────────────────────────────────────

  // 绘制单个画廊卡片
  private async drawGalleryCard(
    ctx: any,
    gallery: MenuGallery,
    thumbnail: Buffer,
    index: number,
    x: number,
    y: number,
    infoHeight: number,
  ): Promise<void> {
    const { thumbWidth, thumbHeight } = this.options
    const cardHeight = thumbHeight + infoHeight
    const radius = STYLE.cardRadius

    // 卡片背景
    ctx.fillStyle = STYLE.cardBg
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, radius)
    ctx.fill()
    ctx.strokeStyle = STYLE.cardBorder
    ctx.lineWidth = 1
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, radius)
    ctx.stroke()

    // 封面区域
    const image = await this.decodeImage(thumbnail)
    if (!image) {
      ctx.save()
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, radius)
      ctx.clip()
      ctx.fillStyle = STYLE.placeholderBg
      ctx.fillRect(x, y, thumbWidth, thumbHeight)
      ctx.restore()

      ctx.fillStyle = STYLE.placeholderColor
      ctx.font = `15px ${CJK_FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('无缩略图', x + thumbWidth / 2, y + thumbHeight / 2)
    } else {
      // contain：等比缩放居中，不裁切
      const imageAspect = image.width / image.height
      const boxAspect = thumbWidth / thumbHeight
      let drawWidth = thumbWidth
      let drawHeight = thumbHeight
      if (imageAspect > boxAspect) {
        drawHeight = thumbWidth / imageAspect
      } else {
        drawWidth = thumbHeight * imageAspect
      }
      const drawX = Math.round(x + (thumbWidth - drawWidth) / 2)
      const drawY = Math.round(y + (thumbHeight - drawHeight) / 2)

      ctx.save()
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, radius)
      ctx.clip()
      ctx.fillStyle = STYLE.placeholderBg
      ctx.fillRect(x, y, thumbWidth, thumbHeight)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, drawX, drawY, Math.round(drawWidth), Math.round(drawHeight))
      ctx.restore()
    }

    // 序号徽章
    const badgeSize = STYLE.indexBadgeSize
    const badgeX = x + 10
    const badgeY = y + 10
    ctx.fillStyle = STYLE.accent
    this.drawRoundedRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 6)
    ctx.fill()
    ctx.fillStyle = STYLE.badgeText
    ctx.font = `bold 17px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${index}`, badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 1)

    // 信息区
    const infoY = y + thumbHeight
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, infoY)
    ctx.lineTo(x + thumbWidth, infoY)
    ctx.lineTo(x + thumbWidth, y + cardHeight - radius)
    ctx.arcTo(x + thumbWidth, y + cardHeight, x + thumbWidth - radius, y + cardHeight, radius)
    ctx.lineTo(x + radius, y + cardHeight)
    ctx.arcTo(x, y + cardHeight, x, y + cardHeight - radius, radius)
    ctx.lineTo(x, infoY)
    ctx.closePath()
    ctx.fillStyle = STYLE.cardBg
    ctx.fill()
    ctx.restore()

    const isSearchGallery = typeof (gallery as any).thumbnail === 'string'
    let title: string
    let pages: string | number
    let favorites: string

    if (isSearchGallery) {
      const sg = gallery as any
      title = sg.english_title || sg.japanese_title || `ID ${sg.id}`
      pages = sg.num_pages || '?'
      favorites = typeof sg.num_favorites === 'number' ? this.formatCount(sg.num_favorites) : '?'
    } else {
      const fullGallery = gallery as any
      title = fullGallery.title?.pretty || fullGallery.title?.english || `ID ${fullGallery.id}`
      pages = fullGallery.num_pages || '?'
      favorites = this.formatCount(fullGallery.num_favorites || 0)
    }

    // 标题（两行）
    ctx.fillStyle = STYLE.title
    ctx.font = `bold 17px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const { firstLine, secondLine } = this.splitLongTitle(ctx, title, thumbWidth - 24)
    ctx.fillText(firstLine, x + 12, infoY + 14)
    if (secondLine) ctx.fillText(secondLine, x + 12, infoY + 38)

    // 信息行：ID · 页数 · 收藏
    const id = (gallery as any).id
    let infoText = `ID: ${id} · ${pages}P · ♥ ${favorites}`
    ctx.font = `13px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = STYLE.meta
    if (ctx.measureText(infoText).width > thumbWidth - 24) {
      infoText = `${id} · ${pages}P · ♥${favorites}`
    }
    ctx.fillText(infoText, x + 12, infoY + 66)

    // 标签行仅对完整画廊绘制
    if (!isSearchGallery) {
      const tagY = infoY + 92
      let currentX = x + 12
      const languages = (gallery as any).tags?.filter((tag: any) => tag.type === 'language').map((tag: any) => tag.name) || []
      const langText = this.getLanguageTagText(languages)
      if (langText) currentX += this.drawChip(ctx, currentX, tagY, langText) + 8

      ctx.font = `14px ${CJK_FONT_FAMILY}`
      for (const tag of this.getImportantTags(gallery as any)) {
        let displayTag = tag
        if (displayTag.length > 14) displayTag = displayTag.substring(0, 13) + '…'
        const width = this.measureChip(ctx, displayTag).width
        if (currentX + width > x + thumbWidth - 12) break
        currentX += this.drawChip(ctx, currentX, tagY, displayTag) + 8
      }
    }
  }

  // 生成搜索结果菜单图片
  async generateMenu(
    galleries: MenuGallery[],
    thumbnails: Buffer[],
    totalResults?: number,
    startIndex?: number,
    pageInfo?: { page: number; totalPages: number },
  ): Promise<Buffer> {
    const { columns, maxRows, thumbWidth, thumbHeight, padding, gap, titleFontSize, infoFontSize } = this.options

    const maxItems = columns * maxRows
    const displayCount = Math.min(galleries.length, maxItems)
    const rows = Math.max(1, Math.ceil(displayCount / columns))

    const headerHeight = 76
    const footerHeight = 64

    // 搜索结果都是列表项（无标签行），按较矮的信息区计算；混入完整画廊时保留完整高度
    const hasTags = galleries
      .slice(0, displayCount)
      .some((item) => typeof (item as any).thumbnail !== 'string')
    const infoHeight = hasTags ? TAGGED_INFO_HEIGHT : SEARCH_INFO_HEIGHT
    const cardHeight = thumbHeight + infoHeight

    const totalCardsWidth = columns * thumbWidth + (columns - 1) * gap
    const canvasWidth = totalCardsWidth + padding * 2
    const canvasHeight = headerHeight + rows * cardHeight + (rows - 1) * gap + footerHeight + padding * 2

    const canvas = createCanvas(canvasWidth, canvasHeight)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    ctx.fillStyle = STYLE.canvasBg
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    // 标题
    const titleY = padding + 2
    ctx.fillStyle = STYLE.title
    ctx.font = `bold ${titleFontSize}px ${CJK_FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('搜索结果', canvasWidth / 2, titleY)

    // 统计信息
    const statY = titleY + titleFontSize + 8
    ctx.font = `${infoFontSize - 1}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = STYLE.meta
    if (totalResults !== undefined && totalResults !== null) {
      const start = (startIndex ?? 0) + 1
      const end = (startIndex ?? 0) + displayCount
      ctx.fillText(`共找到约 ${totalResults} 个结果，当前显示第 ${start}-${end} 项`, canvasWidth / 2, statY)
    } else {
      ctx.fillText(`当前显示 ${displayCount} 个结果`, canvasWidth / 2, statY)
    }

    // 卡片
    const startX = (canvasWidth - totalCardsWidth) / 2
    const startY = headerHeight + padding
    for (let i = 0; i < displayCount; i++) {
      const row = Math.floor(i / columns)
      const col = i % columns
      const x = startX + col * (thumbWidth + gap)
      const y = startY + row * (cardHeight + gap)
      await this.drawGalleryCard(ctx, galleries[i], thumbnails[i], i + 1, x, y, infoHeight)
    }

    // 底部提示
    const footerY = canvasHeight - footerHeight + 12
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = `bold ${infoFontSize - 1}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = STYLE.title
    const pageSuffix = pageInfo ? `（第 ${pageInfo.page}/${pageInfo.totalPages} 页）` : ''
    ctx.fillText(`回复序号下载对应漫画${pageSuffix}`, canvasWidth / 2, footerY)
    ctx.font = `${infoFontSize - 3}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = STYLE.meta
    ctx.fillText('支持翻页 [F/B] 和退出 [N] 操作', canvasWidth / 2, footerY + 24)

    return Buffer.from(await canvas.encode('jpeg', MENU_JPEG_QUALITY))
  }

  // ─── 详情菜单 ─────────────────────────────────────────────

  /** 按 nhentai 的分组顺序整理标签行 */
  private buildDetailRows(gallery: Gallery): DetailRow[] {
    const rows: DetailRow[] = []
    const groups: Array<[string, string]> = [
      ['parody', '原作'],
      ['character', '角色'],
      ['artist', '作者'],
      ['group', '社团'],
      ['category', '类型'],
      ['language', '语言'],
      ['tag', '标签'],
    ]

    for (const [type, label] of groups) {
      const tags = (gallery.tags || []).filter((tag) => tag.type === type)
      if (tags.length === 0) continue
      rows.push({
        label,
        chips: tags.map((tag) => ({ name: tag.name, count: typeof tag.count === 'number' ? this.formatCount(tag.count) : undefined })),
      })
    }
    return rows
  }

  /**
   * 绘制详情卡片主体，返回内容占用到的 Y 坐标。
   * 传入 canvasHeight = 0 表示只测量不画页脚（用于先算画布高度）。
   */
  private paintDetail(
    ctx: any,
    canvasWidth: number,
    canvasHeight: number,
    gallery: Gallery,
    image: Image | null,
    rows: DetailRow[],
    showRefreshOption: boolean,
  ): number {
    const padding = 36
    const coverMaxWidth = 340
    const coverMaxHeight = 520
    const infoX = padding + coverMaxWidth + 32
    const infoWidth = canvasWidth - infoX - padding

    // 封面：等比缩放到框内，且不放大（保持原始清晰度）
    let coverWidth = 0
    let coverHeight = 0
    if (image) {
      const aspect = image.width / image.height
      coverWidth = coverMaxWidth
      coverHeight = Math.round(coverWidth / aspect)
      if (coverHeight > coverMaxHeight) {
        coverHeight = coverMaxHeight
        coverWidth = Math.round(coverHeight * aspect)
      }
      if (coverWidth > image.width) {
        coverHeight = Math.round(coverHeight * (image.width / coverWidth))
        coverWidth = image.width
      }
      const x = padding
      const y = padding
      ctx.save()
      this.drawRoundedRect(ctx, x, y, coverWidth, coverHeight, 4)
      ctx.clip()
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, x, y, coverWidth, coverHeight)
      ctx.restore()
      ctx.strokeStyle = '#343434'
      ctx.lineWidth = 1
      this.drawRoundedRect(ctx, x, y, coverWidth, coverHeight, 4)
      ctx.stroke()
    } else {
      ctx.fillStyle = STYLE.placeholderBg
      this.drawRoundedRect(ctx, padding, padding, coverMaxWidth, 480, 4)
      ctx.fill()
      ctx.fillStyle = STYLE.placeholderColor
      ctx.font = `18px ${CJK_FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('无封面', padding + coverMaxWidth / 2, padding + 240)
      coverWidth = coverMaxWidth
      coverHeight = 480
    }

    // 信息列
    let y = padding
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    // ID：像官网一样用灰色小字
    ctx.fillStyle = STYLE.label
    ctx.font = `15px ${CJK_FONT_FAMILY}`
    ctx.fillText(`#${gallery.id}`, infoX, y)
    y += 26

    // 标题
    const englishTitle = gallery.title?.english || gallery.title?.pretty || `Gallery ${gallery.id}`
    const japaneseTitle = gallery.title?.japanese
    ctx.fillStyle = STYLE.title
    ctx.font = `bold 29px ${CJK_FONT_FAMILY}`
    const titleLines = this.wrapLines(ctx, englishTitle, infoWidth, 3)
    for (const line of titleLines) {
      ctx.fillText(line, infoX, y)
      y += 40
    }

    // 日文标题
    if (japaneseTitle && japaneseTitle !== englishTitle) {
      y += 4
      ctx.fillStyle = STYLE.titleMuted
      ctx.font = `16px ${CJK_FONT_FAMILY}`
      const jpLines = this.wrapLines(ctx, japaneseTitle, infoWidth, 2)
      for (const line of jpLines) {
        ctx.fillText(line, infoX, y)
        y += 24
      }
    }

    // 分隔线
    y += 16
    ctx.strokeStyle = STYLE.divider
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(infoX, y)
    ctx.lineTo(canvasWidth - padding, y)
    ctx.stroke()
    y += 16

    // 元信息：页数 / 收藏 / 日期 / 汉化
    const metaItems: Array<[string, string, boolean]> = [
      ['页数', String(gallery.num_pages ?? '?'), false],
      ['收藏', this.formatCount(gallery.num_favorites || 0), true],
    ]
    if (gallery.upload_date) {
      const date = new Date(gallery.upload_date * 1000)
      metaItems.push(['日期', date.toLocaleDateString('zh-CN'), false])
    }
    const scanlator = (gallery as any).scanlator
    if (scanlator && typeof scanlator === 'string') metaItems.push(['汉化', scanlator, false])

    let metaX = infoX
    const metaY = y
    for (const [label, value, highlight] of metaItems) {
      ctx.font = `14px ${CJK_FONT_FAMILY}`
      ctx.fillStyle = STYLE.label
      ctx.fillText(label, metaX, metaY)
      metaX += ctx.measureText(label).width + 6

      ctx.fillStyle = highlight ? STYLE.accent : STYLE.value
      const remaining = canvasWidth - padding - metaX
      const text = ctx.measureText(value).width > remaining ? this.truncateText(ctx, value, remaining) : value
      ctx.fillText(text, metaX, metaY)
      metaX += ctx.measureText(text).width + 24
      if (metaX > canvasWidth - padding - 60) break
    }
    y = metaY + 24

    // 分隔线
    y += 12
    ctx.strokeStyle = STYLE.divider
    ctx.beginPath()
    ctx.moveTo(infoX, y)
    ctx.lineTo(canvasWidth - padding, y)
    ctx.stroke()
    y += 14

    // 标签行
    const labelWidth = 46
    const chipGap = 8
    const rowGap = 12
    const chipsX = infoX + labelWidth + 10
    const chipsMaxX = canvasWidth - padding

    for (const row of rows) {
      ctx.font = `14px ${CJK_FONT_FAMILY}`
      ctx.fillStyle = STYLE.label
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(row.label, infoX, y + 7)

      let chipX = chipsX
      let chipY = y
      let lineCount = 1
      let drawn = 0

      for (const chip of row.chips) {
        const { width } = this.measureChip(ctx, chip.name, chip.count)
        if (chipX + width > chipsMaxX) {
          if (lineCount >= 4) break
          chipX = chipsX
          chipY += STYLE.chipHeight + chipGap
          lineCount++
        }
        ctx.font = `14px ${CJK_FONT_FAMILY}`
        this.drawChip(ctx, chipX, chipY, chip.name, chip.count)
        chipX += width + chipGap
        drawn++
      }

      // 超出行数上限时追加数量提示
      if (drawn < row.chips.length) {
        const rest = `+${row.chips.length - drawn}`
        const width = this.measureChip(ctx, rest).width
        if (chipX + width <= chipsMaxX) this.drawChip(ctx, chipX, chipY, rest)
      }

      y = chipY + STYLE.chipHeight + rowGap
    }

    // 页脚
    if (canvasHeight > 0) {
      const prompt = showRefreshOption
        ? '回复 [Y] 下载 · [F] 换一个 · [N] 取消'
        : '回复 [Y] 下载 · [N] 取消'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = STYLE.title
      ctx.font = `bold 18px ${CJK_FONT_FAMILY}`
      ctx.fillText(prompt, canvasWidth / 2, canvasHeight - 30)
    }

    return Math.max(y, padding + coverHeight)
  }

  /** 生成单个画廊的详细信息菜单 */
  async generateDetailMenu(gallery: Gallery, coverImage: Buffer, showRefreshOption = false): Promise<Buffer> {
    const image = await this.decodeImage(coverImage)
    const rows = this.buildDetailRows(gallery)
    const canvasWidth = 1200

    // 第一遍只测量内容高度（页脚不画）
    const scratch = createCanvas(canvasWidth, 800)
    const contentEnd = this.paintDetail(scratch.getContext('2d'), canvasWidth, 0, gallery, image, rows, showRefreshOption)

    const canvasHeight = Math.ceil(contentEnd + 62)
    const canvas = createCanvas(canvasWidth, canvasHeight)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = STYLE.canvasBg
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    this.paintDetail(ctx, canvasWidth, canvasHeight, gallery, image, rows, showRefreshOption)

    return Buffer.from(await canvas.encode('jpeg', MENU_JPEG_QUALITY))
  }

  // ─── 文本排版 ─────────────────────────────────────────────

  /** 按宽度折行，返回不超过 maxLines 行 */
  private wrapLines(ctx: any, text: string, maxWidth: number, maxLines: number): string[] {
    const tokens = text.match(/(\s+|[\x21-\x7e]+|[^])/g) || [text]
    const lines: string[] = []
    let current = ''

    for (const token of tokens) {
      const candidate = current + token
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current.trimEnd())
        current = /^\s+$/.test(token) ? '' : token
        if (lines.length === maxLines) break
      } else {
        current = candidate
      }
    }

    if (lines.length < maxLines && current) lines.push(current.trimEnd())
    if (lines.length === 0) lines.push(this.truncateText(ctx, text, maxWidth))

    // 最后一行放不下时截断
    if (lines.length === maxLines && ctx.measureText(lines[maxLines - 1]).width > maxWidth) {
      lines[maxLines - 1] = this.truncateText(ctx, lines[maxLines - 1], maxWidth)
    }
    return lines
  }

  // 释放资源
  dispose(): void {
    if (this.config.debug) {
      logger.info('菜单生成器已释放')
    }
  }
}
