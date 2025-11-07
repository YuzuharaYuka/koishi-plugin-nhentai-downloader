import { createCanvas, loadImage, SKRSContext2D, GlobalFonts } from '@napi-rs/canvas'
import { Gallery } from '../types'
import { Config } from '../config'
import { logger } from '../utils'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 菜单生成器配置
 */
export interface MenuGeneratorOptions {
  /** 每行显示的画廊数量 */
  columns: number
  /** 最大行数 */
  maxRows: number
  /** 缩略图宽度 */
  thumbWidth: number
  /** 缩略图高度 */
  thumbHeight: number
  /** 画布宽度 */
  canvasWidth: number
  /** 标题字体大小 */
  titleFontSize: number
  /** 信息字体大小 */
  infoFontSize: number
  /** 序号字体大小 */
  indexFontSize: number
  /** 边距 */
  padding: number
  /** 缩略图间距 */
  gap: number
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

/**
 * 图片菜单生成服务
 */
export class MenuGenerator {
  private options: MenuGeneratorOptions
  private fontLoaded: boolean = false

  constructor(private config: Config, options?: Partial<MenuGeneratorOptions>) {
    this.options = { ...defaultOptions, ...options }
    this.loadFonts()
  }

  /**
   * 加载中文字体
   */
  private loadFonts(): void {
    if (this.fontLoaded) return

    try {
      // Windows 系统字体路径
      const windowsFonts = [
        'C:\\Windows\\Fonts\\msyh.ttc',      // 微软雅黑
        'C:\\Windows\\Fonts\\simhei.ttf',    // 黑体
        'C:\\Windows\\Fonts\\simsun.ttc',    // 宋体
        'C:\\Windows\\Fonts\\simkai.ttf',    // 楷体
        'C:\\Windows\\Fonts\\msyhbd.ttc',    // 微软雅黑 Bold
      ]

      // Linux 系统字体路径
      const linuxFonts = [
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/arphic/uming.ttc',
      ]

      // macOS 系统字体路径
      const macFonts = [
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/Library/Fonts/Arial Unicode.ttf',
      ]

      const allFonts = [...windowsFonts, ...linuxFonts, ...macFonts]
      let loadedCount = 0

      for (const fontPath of allFonts) {
        if (existsSync(fontPath)) {
          try {
            GlobalFonts.registerFromPath(fontPath, 'CJK')
            loadedCount++
            if (this.config.debug) {
              logger.info(`成功加载字体: ${fontPath}`)
            }
            break // 只需要加载一个成功的字体即可
          } catch (err) {
            if (this.config.debug) {
              logger.warn(`加载字体失败 ${fontPath}: ${err.message}`)
            }
          }
        }
      }

      if (loadedCount > 0) {
        this.fontLoaded = true
        if (this.config.debug) {
          logger.info(`成功加载 ${loadedCount} 个 CJK 字体`)
        }
      } else {
        logger.warn('未找到可用的 CJK 字体，文字可能无法正常显示')
      }
    } catch (error) {
      logger.error(`字体加载失败: ${error.message}`)
    }
  }

  /**
   * 截断文本以适应宽度
   */
  private truncateText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
    const ellipsis = '...'
    let truncated = text

    while (ctx.measureText(truncated + ellipsis).width > maxWidth && truncated.length > 0) {
      truncated = truncated.slice(0, -1)
    }

    return truncated === text ? text : truncated + ellipsis
  }

  /**
   * 绘制圆角矩形
   */
  private drawRoundedRect(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
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

  /**
   * 绘制单个画廊卡片 - 简洁优雅版
   */
  private async drawGalleryCard(
    ctx: SKRSContext2D,
    gallery: Partial<Gallery>,
    thumbnail: Buffer,
    index: number,
    x: number,
    y: number
  ): Promise<void> {
    const { thumbWidth, thumbHeight, infoFontSize, indexFontSize } = this.options
    const infoAreaHeight = 90 // 增加高度以容纳两行标题
    const cardHeight = thumbHeight + infoAreaHeight

    // 绘制卡片背景
    ctx.fillStyle = '#1e1e1e'
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, 6)
    ctx.fill()

    // 绘制细边框
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    this.drawRoundedRect(ctx, x, y, thumbWidth, cardHeight, 6)
    ctx.stroke()

    try {
      // 加载并绘制缩略图
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

      // 裁剪区域为圆角矩形
      ctx.save()
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, 6)
      ctx.clip()

      // 绘制缩略图
      ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight)
      ctx.restore()

      // 绘制序号标签 - 简洁半透明设计
      const badgeSize = 44
      const badgeX = x + 8
      const badgeY = y + 8

      // 序号背景
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
      this.drawRoundedRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 6)
      ctx.fill()

      // 序号边框
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
      ctx.lineWidth = 1.5
      this.drawRoundedRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 6)
      ctx.stroke()

      // 绘制序号
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${indexFontSize}px Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${index}`, badgeX + badgeSize / 2, badgeY + badgeSize / 2)

    } catch (error) {
      // 如果缩略图加载失败，显示占位符
      ctx.fillStyle = '#151515'
      this.drawRoundedRect(ctx, x, y, thumbWidth, thumbHeight, 6)
      ctx.fill()

      ctx.fillStyle = '#555555'
      ctx.font = `${infoFontSize}px Arial, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('加载失败', x + thumbWidth / 2, y + thumbHeight / 2)
    }

    // 信息区域
    const infoY = y + thumbHeight
    const infoHeight = infoAreaHeight

    // 绘制信息区域背景 - 使用更深的背景色增加对比度
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(x, infoY, thumbWidth, infoHeight)

    // 绘制标题 - 支持两行显示，使用更亮的颜色
    ctx.fillStyle = '#f5f5f5'
    ctx.font = `${infoFontSize}px "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    const title = gallery.title?.pretty || gallery.title?.english || `ID ${gallery.id}`
    const maxLineWidth = thumbWidth - 16

    // 将标题分成两行
    let firstLine = title
    let secondLine = ''

    if (ctx.measureText(title).width > maxLineWidth) {
      // 标题过长，需要分两行
      let splitIndex = title.length
      while (splitIndex > 0 && ctx.measureText(title.substring(0, splitIndex)).width > maxLineWidth) {
        splitIndex--
      }

      if (splitIndex > 0) {
        firstLine = title.substring(0, splitIndex)
        secondLine = title.substring(splitIndex)

        // 如果第二行还是太长，截断并加省略号
        if (ctx.measureText(secondLine).width > maxLineWidth) {
          secondLine = this.truncateText(ctx, secondLine, maxLineWidth)
        }
      } else {
        // 单个字符就超宽，直接截断
        firstLine = this.truncateText(ctx, title, maxLineWidth)
      }
    }

    ctx.fillText(firstLine, x + 8, infoY + 6)
    if (secondLine) {
      ctx.fillText(secondLine, x + 8, infoY + 6 + infoFontSize + 2)
    }

    // 绘制信息行 - ID居左、页数居中、收藏居右
    // 始终使用两行标题的位置，保持所有卡片信息行对齐
    const infoLineY = infoY + 46
    ctx.font = `${infoFontSize - 2}px "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
    ctx.fillStyle = '#c0c0c0'  // 提高亮度，从 #999 改为 #c0c0c0

    const id = gallery.id
    const pages = gallery.num_pages || '?'
    const fav = gallery.num_favorites || 0

    // 左侧：ID
    ctx.textAlign = 'left'
    ctx.fillText(`ID: ${id}`, x + 8, infoLineY)

    // 中间：页数
    ctx.textAlign = 'center'
    ctx.fillText(`页数: ${pages}`, x + thumbWidth / 2, infoLineY)

    // 右侧：收藏
    ctx.textAlign = 'right'
    ctx.fillText(`收藏: ${fav}`, x + thumbWidth - 8, infoLineY)

    // 语言标签 - 显示详细语言信息，居中显示
    const languages = gallery.tags?.filter(tag => tag.type === 'language').map(tag => tag.name) || []
    if (languages.length > 0) {
      const langY = infoLineY + 20

      // 语言名称映射
      const langMap: Record<string, string> = {
        'chinese': 'Chinese',
        'english': 'English',
        'japanese': 'Japanese',
        'translated': 'Translated'
      }

      let langTag = langMap[languages[0]] || languages[0].toUpperCase()

      // 如果包含 translated 标签，显示更详细的信息
      if (languages.includes('translated') && languages.length > 1) {
        const mainLang = languages.find(l => l !== 'translated')
        if (mainLang) {
          langTag = `Translated: ${langMap[mainLang] || mainLang}`
        }
      }

      ctx.font = `${infoFontSize - 3}px Arial, sans-serif`
      const langWidth = ctx.measureText(langTag).width + 10

      // 计算居中位置
      const langX = x + (thumbWidth - langWidth) / 2

      // 绘制语言标签背景 - 使用更明显的背景色
      ctx.fillStyle = '#1a3a1a'
      this.drawRoundedRect(ctx, langX, langY, langWidth, 16, 3)
      ctx.fill()

      // 绘制语言标签文字 - 使用更亮的绿色，居中对齐
      ctx.textAlign = 'left'
      ctx.fillStyle = '#7ed87e'
      ctx.fillText(langTag, langX + 5, langY + 3)
    }
  }

  /**
   * 生成搜索结果菜单图片 - 简洁优雅版
   */
  async generateMenu(
    galleries: Partial<Gallery>[],
    thumbnails: Buffer[],
    totalResults?: number
  ): Promise<Buffer> {
    const { columns, maxRows, thumbWidth, thumbHeight, padding, gap, canvasWidth, titleFontSize, infoFontSize } = this.options

    // 计算实际显示的画廊数量
    const maxItems = columns * maxRows
    const displayCount = Math.min(galleries.length, maxItems)

    // 计算画布尺寸
    const rows = Math.ceil(displayCount / columns)
    const headerHeight = 80
    const footerHeight = 65 // 增加底部高度以容纳完整提示信息
    const cardHeight = thumbHeight + 90 // 与信息区域高度保持一致
    const canvasHeight = headerHeight + rows * cardHeight + (rows - 1) * gap + footerHeight + padding * 2

    // 创建画布
    const canvas = createCanvas(canvasWidth, canvasHeight)
    const ctx = canvas.getContext('2d')

    // 绘制纯黑背景
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    // 绘制顶部标题区域
    const titleY = padding + 5

    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${titleFontSize}px "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('搜索结果', canvasWidth / 2, titleY)

    // 绘制统计信息 - 提高亮度
    const statY = titleY + titleFontSize + 10
    ctx.font = `${infoFontSize}px "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
    ctx.fillStyle = '#b0b0b0'  // 提高亮度，从 #888 改为 #b0b0b0

    if (totalResults !== undefined && totalResults !== null) {
      const statsText = `共找到 ${totalResults} 个结果，当前显示前 ${displayCount} 个`
      ctx.fillText(statsText, canvasWidth / 2, statY)
    } else {
      ctx.fillText(`当前显示 ${displayCount} 个结果`, canvasWidth / 2, statY)
    }

    // 计算卡片起始位置
    const totalCardsWidth = columns * thumbWidth + (columns - 1) * gap
    const startX = (canvasWidth - totalCardsWidth) / 2
    const startY = headerHeight + padding

    // 绘制所有画廊卡片
    for (let i = 0; i < displayCount; i++) {
      const row = Math.floor(i / columns)
      const col = i % columns
      const x = startX + col * (thumbWidth + gap)
      const y = startY + row * (cardHeight + gap)

      await this.drawGalleryCard(ctx, galleries[i], thumbnails[i], i + 1, x, y)
    }

    // 绘制底部提示 - 居中对齐
    const footerY = canvasHeight - footerHeight + 15

    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'

    ctx.font = `${infoFontSize + 1}px "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
    ctx.fillStyle = '#f5f5f5'  // 保持明亮
    ctx.fillText('回复序号下载对应漫画', canvasWidth / 2, footerY)

    ctx.font = `${infoFontSize - 1}px "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
    ctx.fillStyle = '#b0b0b0'  // 提高亮度，从 #888 改为 #b0b0b0
    ctx.fillText('支持翻页 [F/B] 和退出 [N] 操作', canvasWidth / 2, footerY + 24)

    // 输出为 PNG Buffer
    return canvas.toBuffer('image/png')
  }

  /**
   * 生成单个画廊的详细信息卡片
   */
  async generateGalleryCard(gallery: Gallery, coverImage: Buffer): Promise<Buffer> {
    const cardWidth = 600
    const cardHeight = 800
    const coverWidth = 400
    const coverHeight = 550

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
    ctx.font = 'bold 24px CJK, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const title = gallery.title?.pretty || gallery.title?.english || `作品 ${gallery.id}`
    const truncatedTitle = this.truncateText(ctx, title, cardWidth - 40)
    ctx.fillText(truncatedTitle, cardWidth / 2, 40)

    try {
      // 绘制封面
      const img = await loadImage(coverImage)
      const x = (cardWidth - coverWidth) / 2
      const y = 100

      ctx.save()
      this.drawRoundedRect(ctx, x, y, coverWidth, coverHeight, 12)
      ctx.clip()
      ctx.drawImage(img, x, y, coverWidth, coverHeight)
      ctx.restore()
    } catch (error) {
      logger.warn(`封面加载失败: ${error.message}`)
    }

    // 绘制信息
    const infoY = 670
    ctx.fillStyle = '#cccccc'
    ctx.font = '18px CJK, sans-serif'
    ctx.textAlign = 'center'

    const info = [
      `ID: ${gallery.id}`,
      `页数: ${gallery.num_pages}`,
      `收藏: ${gallery.num_favorites}`,
    ]

    ctx.fillText(info.join(' | '), cardWidth / 2, infoY)

    return canvas.toBuffer('image/png')
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.config.debug) {
      logger.info('菜单生成器已清理')
    }
  }
}
