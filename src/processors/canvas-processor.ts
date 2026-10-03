/**
 * 基于 @napi-rs/canvas 的图片处理模块
 * 提供格式转换与反和谐水印两项能力
 */
import { createCanvas, Image, Canvas, SKRSContext2D, GlobalFonts } from '@napi-rs/canvas'
import { logger } from '../utils'

// 数字字形常量 (5x7 像素位图，用于水印)
const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const WATERMARK_OPACITY = 0.15

const DIGITS = [
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,1,1, 1,0,1,0,1, 1,1,0,0,1, 1,0,0,0,1, 0,1,1,1,0], // 0
  [0,0,1,0,0, 0,1,1,0,0, 1,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 0,0,1,0,0, 1,1,1,1,1], // 1
  [0,1,1,1,0, 1,0,0,0,1, 0,0,0,0,1, 0,0,0,1,0, 0,0,1,0,0, 0,1,0,0,0, 1,1,1,1,1], // 2
  [0,1,1,1,0, 1,0,0,0,1, 0,0,0,0,1, 0,0,1,1,0, 0,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0], // 3
  [0,0,0,1,0, 0,0,1,1,0, 0,1,0,1,0, 1,0,0,1,0, 1,1,1,1,1, 0,0,0,1,0, 0,0,0,1,0], // 4
  [1,1,1,1,1, 1,0,0,0,0, 1,1,1,1,0, 0,0,0,0,1, 0,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0], // 5
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,0, 1,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0], // 6
  [1,1,1,1,1, 0,0,0,0,1, 0,0,0,1,0, 0,0,1,0,0, 0,1,0,0,0, 0,1,0,0,0, 0,1,0,0,0], // 7
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0], // 8
  [0,1,1,1,0, 1,0,0,0,1, 1,0,0,0,1, 0,1,1,1,1, 0,0,0,0,1, 1,0,0,0,1, 0,1,1,1,0], // 9
]

/**
 * Canvas 图片处理器实例
 * 提供完整的图片处理 API
 */
class CanvasImageProcessor {
  /**
   * 字形位图缓存：5x7 的小画布，绘制水印时一次性放大贴上去。
   * 原先逐像素 fillRect（一次最多上万次调用）在水印这一步就占掉了可观的耗时。
   */
  private static glyphCache = new Map<number, Canvas>()

  private getGlyphCanvas(digit: number): Canvas {
    const cached = CanvasImageProcessor.glyphCache.get(digit)
    if (cached) return cached

    const canvas = createCanvas(GLYPH_WIDTH, GLYPH_HEIGHT) as Canvas
    const gctx = canvas.getContext('2d')
    gctx.fillStyle = '#000'
    const glyph = DIGITS[Math.min(digit, 9)]
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (glyph[gy * GLYPH_WIDTH + gx] !== 0) gctx.fillRect(gx, gy, 1, 1)
      }
    }
    CanvasImageProcessor.glyphCache.set(digit, canvas)
    return canvas
  }

  /**
   * 在 Canvas 上绘制位图数字 (用于水印)
   */
  private drawDigit(
    ctx: SKRSContext2D,
    digit: number,
    startX: number,
    startY: number,
    scale: number,
    alpha: number
  ): void {
    const glyph = this.getGlyphCanvas(digit)
    const smoothing = ctx.imageSmoothingEnabled
    const globalAlpha = ctx.globalAlpha

    ctx.imageSmoothingEnabled = false
    ctx.globalAlpha = alpha
    ctx.drawImage(glyph, startX, startY, GLYPH_WIDTH * scale, GLYPH_HEIGHT * scale)

    ctx.imageSmoothingEnabled = smoothing
    ctx.globalAlpha = globalAlpha
  }

  /**
   * 在随机角落叠加一个低透明度数字水印（5x7 字形放大绘制），再按 format 编码。
   * 水印只改像素，不改变构图，用于降低被按图库指纹拦截的概率。
   */
  async applyAntiCensorship(buffer: Uint8Array, format: string = 'webp', quality: number = 90): Promise<Uint8Array> {
    try {
      const img = new Image()
      img.src = Buffer.from(buffer)
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = reject
      })

      const { width, height } = img
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')

      // 绘制原图
      ctx.drawImage(img, 0, 0)

      // 计算水印参数
      const watermarkDigit = Math.floor(Math.random() * 10)
      const fontSize = Math.max(8, Math.floor(width / 150))
      const margin = Math.floor(fontSize / 2)
      const position = Math.floor(Math.random() * 4) // 0=TL, 1=TR, 2=BR, 3=BL

      const textW = GLYPH_WIDTH * fontSize
      const textH = GLYPH_HEIGHT * fontSize

      // 计算水印位置
      let x: number, y: number
      switch (position) {
        case 0: // Top-Left
          x = margin
          y = margin
          break
        case 1: // Top-Right
          x = width - margin - textW
          y = margin
          break
        case 2: // Bottom-Right
          x = width - margin - textW
          y = height - margin - textH
          break
        default: // Bottom-Left
          x = margin
          y = height - margin - textH
      }

      // 绘制水印数字
      this.drawDigit(ctx, watermarkDigit, x, y, fontSize, WATERMARK_OPACITY)

      // 输出为目标格式
      switch (format.toLowerCase()) {
        case 'jpeg':
        case 'jpg':
          return canvas.encode('jpeg', quality)
        case 'png':
          return canvas.encode('png')
        case 'webp':
        default:
          return canvas.encode('webp', quality)
      }
    } catch (error: any) {
      throw new Error(`Failed to apply anti-censorship: ${error?.message || String(error)}`)
    }
  }

  /** 图片最长边是否超过给定值，用于判断是否需要缩放 */
  async exceedsEdge(buffer: Uint8Array, maxEdge: number): Promise<boolean> {
    const img = await this.loadImage(buffer)
    return Math.max(img.width, img.height) > maxEdge
  }

  /** 统一图片处理管道：解码一次，可选缩放，再编码到目标格式 */
  async processImage(
    buffer: Uint8Array,
    targetFormat: string,
    quality: number,
    applyAntiCensor: boolean,
    maxEdge: number = 0,
  ): Promise<Uint8Array> {
    // 如果需要反和谐处理
    if (applyAntiCensor) {
      return this.applyAntiCensorship(buffer, targetFormat, quality)
    }

    const img = await this.loadImage(buffer)

    let width = img.width
    let height = img.height
    if (maxEdge > 0 && Math.max(width, height) > maxEdge) {
      const scale = maxEdge / Math.max(width, height)
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }

    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    // 缩放时开启平滑，避免出现锯齿
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, width, height)

    switch (targetFormat.toLowerCase()) {
      case 'jpeg':
      case 'jpg':
        return canvas.encode('jpeg', quality)
      case 'png':
        return canvas.encode('png')
      case 'webp':
        return canvas.encode('webp', quality)
      default:
        throw new Error(`Unsupported target format: ${targetFormat}`)
    }
  }

  /** 解码图片，失败时抛出带上下文的错误 */
  private async loadImage(buffer: Uint8Array): Promise<Image> {
    const img = new Image()
    img.src = Buffer.from(buffer)
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Image decode failed'))
    })
    return img
  }

}

// 单例实例
let processorInstance: CanvasImageProcessor | null = null

/**
 * 初始化图片处理器
 * @note @napi-rs/canvas 无需显式初始化，此函数保留用于兼容原 API
 */
export async function initCanvasProcessor(): Promise<void> {
  if (!processorInstance) {
    processorInstance = new CanvasImageProcessor()
    logger.debug('Canvas 图片处理器初始化成功')
  }
}

/**
 * 确保处理器已加载并返回实例
 */
export function ensureCanvasLoaded(): CanvasImageProcessor {
  if (!processorInstance) {
    processorInstance = new CanvasImageProcessor()
  }
  return processorInstance
}

export { CanvasImageProcessor, createCanvas, Image, GlobalFonts }
