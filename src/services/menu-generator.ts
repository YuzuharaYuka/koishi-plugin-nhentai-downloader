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
      if (!GlobalFonts || !GlobalFonts.families) {
        throw new Error('GlobalFonts 未正确加载')
      }

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

  // 绘制部分圆角矩形
  private drawPartiallyRoundedRect(ctx: any, x: number, y: number, width: number, height: number, radius: number, corners: { tl: boolean, tr: boolean, br: boolean, bl: boolean }): void {
    ctx.beginPath()

    // Top-Left start
    if (corners.tl) {
      ctx.moveTo(x + radius, y)
    } else {
      ctx.moveTo(x, y)
    }

    // Top-Right
    if (corners.tr) {
      ctx.lineTo(x + width - radius, y)
      ctx.arcTo(x + width, y, x + width, y + radius, radius)
    } else {
      ctx.lineTo(x + width, y)
    }

    // Bottom-Right
    if (corners.br) {
      ctx.lineTo(x + width, y + height - radius)
      ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius)
    } else {
      ctx.lineTo(x + width, y + height)
    }

    // Bottom-Left
    if (corners.bl) {
      ctx.lineTo(x + radius, y + height)
      ctx.arcTo(x, y + height, x, y + height - radius, radius)
    } else {
      ctx.lineTo(x, y + height)
    }

    // Top-Left end
    if (corners.tl) {
      ctx.lineTo(x, y + radius)
      ctx.arcTo(x, y, x + radius, y, radius)
    } else {
      ctx.lineTo(x, y)
    }

    ctx.closePath()
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
        if (thumbnail.length > 12) {
          const header = thumbnail.slice(0, 4).toString('ascii')
          const webpSig = thumbnail.slice(8, 12).toString('ascii')
          if (header === 'RIFF' && webpSig === 'WEBP') {
            mime = 'image/webp'
          }
        }
        if (thumbnail.length > 4 && thumbnail[0] === 0x89 && thumbnail[1] === 0x50 && thumbnail[2] === 0x4E && thumbnail[3] === 0x47) {
          mime = 'image/png'
        }

        img.src = `data:${mime};base64,${thumbnail.toString('base64')}`

        // 添加超时保护防止图片加载挂起
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = (err) => reject(new Error('Image load failed'))
          }),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('Image load timeout')), 5000)
          })
        ])

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

    // 优化：使用较小字体和紧凑格式防止溢出
    const metaFontSize = infoFontSize - 2
    ctx.font = `${metaFontSize}px ${CJK_FONT_FAMILY}`
    ctx.fillStyle = CARD_STYLES.infoColor
    ctx.textAlign = 'left'

    const id = gallery.id
    const pages = gallery.num_pages || '?'
    const fav = this.formatCount(gallery.num_favorites || 0)

    let infoText = `ID: ${id} · ${pages}P · ♥ ${fav}`

    // 检查宽度，如果溢出则进一步压缩
    if (ctx.measureText(infoText).width > thumbWidth - 24) {
       infoText = `${id} · ${pages}P · ♥${fav}`
    }

    ctx.fillText(infoText, x + 12, infoLineY)

    // 绘制标签行
    const tagY = infoLineY + metaFontSize + 12
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

  // 格式化数字为 K/M 格式
  private formatCount(count: number): string {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`
    }
    if (count >= 1000) {
      return `${Math.floor(count / 1000)}K`
    }
    return `${count}`
  }

  // 生成单个画廊的详细信息菜单
  async generateDetailMenu(gallery: Gallery, coverImage: Buffer): Promise<Buffer> {
    // 1. 先加载图片获取尺寸
    let img: any
    let imgAspect = 0.7 // 默认纵横比
    try {
      img = new Image()
      let mime = 'image/jpeg'
      if (coverImage.length > 12) {
        const header = coverImage.slice(0, 4).toString('ascii')
        const webpSig = coverImage.slice(8, 12).toString('ascii')
        if (header === 'RIFF' && webpSig === 'WEBP') {
          mime = 'image/webp'
        }
      }
      if (coverImage.length > 4 && coverImage[0] === 0x89 && coverImage[1] === 0x50 && coverImage[2] === 0x4E && coverImage[3] === 0x47) {
        mime = 'image/png'
      }
      img.src = `data:${mime};base64,${coverImage.toString('base64')}`

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = (err) => reject(new Error('Image load failed'))
      })
      imgAspect = img.width / img.height
    } catch (error) {
      // 图片加载失败，使用默认值
    }

    // 2. 动态布局参数
    const canvasWidth = 1200
    const canvasHeight = 720
    const padding = 40

    // 根据图片比例调整封面宽度
    let coverWidth = 400
    if (imgAspect > 1.2) {
        coverWidth = 600 // 横图加宽
    } else if (imgAspect > 0.9) {
        coverWidth = 500 // 方图稍宽
    }

    const coverHeight = 600
    const infoX = padding + coverWidth + 40
    const infoWidth = canvasWidth - infoX - padding

    const canvas = createCanvas(canvasWidth, canvasHeight)
    const ctx = canvas.getContext('2d')

    // 3. 绘制背景
    ctx.fillStyle = '#121212'
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    // 4. 绘制封面
    if (img) {
      // 计算封面尺寸 (Contain)
      const targetAspect = coverWidth / coverHeight
      let drawWidth = coverWidth
      let drawHeight = coverHeight

      if (imgAspect > targetAspect) {
        drawHeight = coverWidth / imgAspect
      } else {
        drawWidth = coverHeight * imgAspect
      }

      // 垂直居中
      const drawX = padding + (coverWidth - drawWidth) / 2
      const drawY = padding + (coverHeight - drawHeight) / 2

      // 封面阴影
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
      ctx.shadowBlur = 20
      ctx.shadowOffsetY = 10

      // 绘制图片
      this.drawRoundedRect(ctx, drawX, drawY, drawWidth, drawHeight, 8)
      ctx.clip()
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
      ctx.restore()

      // 边框
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 1
      this.drawRoundedRect(ctx, drawX, drawY, drawWidth, drawHeight, 8)
      ctx.stroke()
    } else {
      // 封面加载失败占位
      ctx.fillStyle = '#252525'
      this.drawRoundedRect(ctx, padding, padding, coverWidth, 560, 8)
      ctx.fill()
      ctx.fillStyle = '#555'
      ctx.font = '24px Arial'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('无封面', padding + coverWidth / 2, padding + 280)
    }

    // 5. 绘制信息
    let currentY = padding
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    // ID Badge
    const idText = `# ${gallery.id}`
    ctx.font = 'bold 22px Arial'
    const idWidth = ctx.measureText(idText).width + 24

    ctx.fillStyle = '#e91e63'
    this.drawRoundedRect(ctx, infoX, currentY, idWidth, 34, 17)
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.fillText(idText, infoX + 12, currentY + 17)
    ctx.textBaseline = 'top'

    // Category Badge
    if (gallery.tags) {
        const categoryTag = gallery.tags.find(t => t.type === 'category')
        if (categoryTag) {
            const catText = categoryTag.name.toUpperCase()
            ctx.font = 'bold 16px Arial'
            const catWidth = ctx.measureText(catText).width + 24
            const catX = infoX + idWidth + 12

            ctx.fillStyle = '#333'
            this.drawRoundedRect(ctx, catX, currentY + 2, catWidth, 30, 6)
            ctx.fill()

            ctx.fillStyle = '#ccc'
            ctx.textBaseline = 'middle'
            ctx.fillText(catText, catX + 12, currentY + 2 + 15)
            ctx.textBaseline = 'top'
        }
    }

    currentY += 50

    // 标题
    ctx.font = `bold 32px ${CJK_FONT_FAMILY}`
    const prettyTitle = gallery.title?.pretty
    const englishTitle = gallery.title?.english || prettyTitle || `Gallery ${gallery.id}`
    const japaneseTitle = gallery.title?.japanese

    // 1. 绘制英文标题 (包含 pretty 部分高亮)
    const engSegments = this.parseTitle(englishTitle, prettyTitle)
    if (engSegments.length === 0) {
        engSegments.push({ text: englishTitle, color: '#ffffff' })
    }

    currentY = this.drawRichText(ctx, engSegments, infoX, currentY, infoWidth, 42, 3)

    // 2. 绘制日文标题 (如果有且不同)
    if (japaneseTitle && japaneseTitle !== englishTitle) {
        currentY += 8
        ctx.font = `20px ${CJK_FONT_FAMILY}`
        const jpSegments = this.parseTitle(japaneseTitle, prettyTitle)
        currentY = this.drawRichText(ctx, jpSegments, infoX, currentY, infoWidth, 28, 2)
    }

    currentY += 20

    // 元数据行 (Pages | Date | Favorites)
    ctx.fillStyle = '#aaa'
    ctx.font = `16px ${CJK_FONT_FAMILY}`
    let metaX = infoX

    // Pages
    ctx.fillText(`页数: ${gallery.num_pages}`, metaX, currentY)
    metaX += ctx.measureText(`页数: ${gallery.num_pages}`).width + 30

    // Date
    if (gallery.upload_date) {
        const date = new Date(gallery.upload_date * 1000)
        const dateStr = date.toLocaleDateString('zh-CN')
        ctx.fillText(`日期: ${dateStr}`, metaX, currentY)
        metaX += ctx.measureText(`日期: ${dateStr}`).width + 30
    }

    // Favorites
    ctx.fillText(`收藏: ${gallery.num_favorites}`, metaX, currentY)

    currentY += 30

    // 分隔线
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(infoX, currentY)
    ctx.lineTo(canvasWidth - padding, currentY)
    ctx.stroke()

    currentY += 25

    // 标签列表
    const tagTypes = [
      { type: 'parody', label: '原作' },
      { type: 'character', label: '角色' },
      { type: 'tag', label: '标签' },
      { type: 'artist', label: '作者' },
      { type: 'group', label: '社团' },
      { type: 'language', label: '语言' },
    ]

    const labelWidth = 60

    for (const { type, label } of tagTypes) {
      const tags = gallery.tags?.filter(t => t.type === type)
      if (tags && tags.length > 0) {
        // Label
        ctx.fillStyle = '#bbb'
        ctx.font = `bold 16px ${CJK_FONT_FAMILY}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(label, infoX, currentY + 6)

        // Tags
        let currentTagX = infoX + labelWidth
        let currentTagY = currentY
        const tagHeight = 28
        const tagGap = 8
        const textPaddingX = 10
        const textGap = 8

        for (const tag of tags) {
           const tagName = tag.name
           const tagCount = this.formatCount(tag.count)

           // 测量宽度
           ctx.font = `bold 14px ${CJK_FONT_FAMILY}`
           const nameWidth = ctx.measureText(tagName).width
           ctx.font = `12px Arial`
           const countWidth = ctx.measureText(tagCount).width

           // 计算两部分宽度
           const leftWidth = textPaddingX + nameWidth + textGap / 2
           const rightWidth = textGap / 2 + countWidth + textPaddingX
           const tagWidth = leftWidth + rightWidth

           if (currentTagX + tagWidth > canvasWidth - padding) {
              currentTagX = infoX + labelWidth
              currentTagY += tagHeight + tagGap
              if (currentTagY > canvasHeight - 80) break // 防止溢出
           }

           // Tag Background - Left (Name)
           ctx.fillStyle = '#3e3e3e'
           this.drawPartiallyRoundedRect(ctx, currentTagX, currentTagY, leftWidth, tagHeight, 4, { tl: true, tr: false, br: false, bl: true })
           ctx.fill()

           // Tag Background - Right (Count)
           ctx.fillStyle = '#222222'
           this.drawPartiallyRoundedRect(ctx, currentTagX + leftWidth, currentTagY, rightWidth, tagHeight, 4, { tl: false, tr: true, br: true, bl: false })
           ctx.fill()

           // Tag Name
           ctx.fillStyle = '#eeeeee'
           ctx.font = `bold 14px ${CJK_FONT_FAMILY}`
           ctx.textAlign = 'left'
           ctx.textBaseline = 'middle'
           const textY = currentTagY + tagHeight / 2 - 1 // 微调垂直居中
           ctx.fillText(tagName, currentTagX + textPaddingX, textY)

           // Tag Count
           ctx.fillStyle = '#aaaaaa'
           ctx.font = `12px Arial`
           ctx.fillText(tagCount, currentTagX + leftWidth + textGap / 2, textY)

           currentTagX += tagWidth + tagGap
        }

        currentY = currentTagY + tagHeight + 15
        if (currentY > canvasHeight - 80) break
      }
    }

    // 底部操作提示
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#eee'
    ctx.font = `bold 20px ${CJK_FONT_FAMILY}`
    ctx.fillText('回复 [Y] 下载 · [F] 换一个 · [N] 取消', canvasWidth / 2, canvasHeight - 20)

    return canvas.toBuffer('image/png')
  }

  // 解析标题结构
  private parseTitle(fullTitle: string, prettyTitle?: string): { text: string, color: string }[] {
    const gray = '#888888'
    const white = '#ffffff'

    if (!fullTitle) return []

    // 尝试使用 prettyTitle 进行匹配
    if (prettyTitle && fullTitle.includes(prettyTitle)) {
      const index = fullTitle.indexOf(prettyTitle)
      const prefix = fullTitle.substring(0, index)
      const suffix = fullTitle.substring(index + prettyTitle.length)
      return [
        { text: prefix, color: gray },
        { text: prettyTitle, color: white },
        { text: suffix, color: gray }
      ].filter(p => p.text)
    }

    // 正则启发式匹配
    const startRegex = /^((?:\s*(?:\[[^\]]+\]|\([^)]+\)|\{[^}]+\})\s*)+)/
    const endRegex = /((?:\s*(?:\[[^\]]+\]|\([^)]+\)|\{[^}]+\})\s*)+)$/

    let prefix = ''
    let body = fullTitle
    let suffix = ''

    const startMatch = fullTitle.match(startRegex)
    if (startMatch) {
      prefix = startMatch[1]
      body = body.substring(prefix.length)
    }

    const endMatch = body.match(endRegex)
    if (endMatch) {
      suffix = endMatch[1]
      body = body.substring(0, body.length - suffix.length)
    }

    return [
      { text: prefix, color: gray },
      { text: body, color: white },
      { text: suffix, color: gray }
    ].filter(p => p.text)
  }

  // 绘制富文本（自动换行）
  private drawRichText(ctx: any, segments: { text: string, color: string }[], x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number = 10): number {
    let currentY = y
    let lineCount = 1

    const tokens: { text: string, color: string, width: number }[] = []

    for (const segment of segments) {
      // 使用更细粒度的分词正则：区分空格、ASCII单词、其他字符(CJK)
      const parts = segment.text.match(/(\s+|[\x21-\x7e]+|[^])/g) || [segment.text]
      for (const part of parts) {
         tokens.push({
             text: part,
             color: segment.color,
             width: ctx.measureText(part).width
         })
      }
    }

    let currentLineWidth = 0
    let lineBuffer: typeof tokens = []

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (currentLineWidth + token.width > maxWidth) {
            let drawX = x
            for (const t of lineBuffer) {
                ctx.fillStyle = t.color
                ctx.fillText(t.text, drawX, currentY)
                drawX += t.width
            }

            currentY += lineHeight
            lineCount++
            if (lineCount > maxLines) break

            lineBuffer = []
            currentLineWidth = 0

            if (/^\s+$/.test(token.text)) continue
        }

        lineBuffer.push(token)
        currentLineWidth += token.width
    }

    if (lineBuffer.length > 0 && lineCount <= maxLines) {
        let drawX = x
        for (const t of lineBuffer) {
            ctx.fillStyle = t.color
            ctx.fillText(t.text, drawX, currentY)
            drawX += t.width
        }
        currentY += lineHeight
    }

    return currentY
  }

  // 释放资源
  dispose(): void {
    if (this.config.debug) {
      logger.info('菜单生成器已清理')
    }
  }
}
