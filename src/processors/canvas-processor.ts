/**
 * 基于 @napi-rs/canvas 的高性能图片处理模块
 * 替代原 WASM 实现，提供图片格式转换、质量压缩和反和谐处理
 */
import { createCanvas, loadImage, Image, SKRSContext2D } from '@napi-rs/canvas'
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

// 质量优化常量
const LARGE_IMAGE_MP = 4.0  // 大图定义: > 4MP
const SMALL_IMAGE_MP = 0.5  // 小图定义: < 0.5MP
const LARGE_IMAGE_QUALITY_DELTA = 10 // 大图质量降低
const SMALL_IMAGE_QUALITY_DELTA = 5  // 小图质量提升

/**
 * Canvas 图片处理器实例
 * 提供与原 WASM 模块相同的 API 接口
 */
class CanvasImageProcessor {
  /**
   * 根据图片尺寸计算最优 JPEG 质量
   * 大图降低质量提升压缩率，小图提升质量增强视觉效果
   */
  private calculateOptimalQuality(width: number, height: number, baseQuality: number): number {
    const megapixels = (width * height) / 1_000_000

    let adjusted = baseQuality
    if (megapixels > LARGE_IMAGE_MP) {
      adjusted = Math.max(1, baseQuality - LARGE_IMAGE_QUALITY_DELTA)
    } else if (megapixels < SMALL_IMAGE_MP) {
      adjusted = Math.min(100, baseQuality + SMALL_IMAGE_QUALITY_DELTA)
    }

    return Math.max(1, Math.min(100, adjusted))
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
    const glyph = DIGITS[Math.min(digit, 9)]
    const width = ctx.canvas.width
    const height = ctx.canvas.height

    // 设置绘制样式
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`

    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        const pixelOn = glyph[gy * GLYPH_WIDTH + gx] !== 0
        if (!pixelOn) continue

        // 放大每个字形像素
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = startX + gx * scale + sx
            const y = startY + gy * scale + sy

            if (x < 0 || y < 0 || x >= width || y >= height) continue
            ctx.fillRect(x, y, 1, 1)
          }
        }
      }
    }
  }

  /**
   * 添加随机像素噪点 (用于反和谐)
   * @deprecated 当前策略使用水印替代噪点
   */
  private addNoise(imageData: ImageData, intensity: number): void {
    const data = imageData.data
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * intensity * 2
      data[i] = Math.max(0, Math.min(255, data[i] + noise))     // R
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise)) // G
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise)) // B
      // data[i + 3] 保持 Alpha 不变
    }
  }

  /**
   * 将任意格式图片转换为 JPEG
   * @param buffer 原始图片 Buffer
   * @param quality JPEG 质量 (1-100)
   * @returns JPEG 格式的 Buffer
   */
  async convertToJpeg(buffer: Uint8Array, quality: number): Promise<Uint8Array> {
    try {
      const img = new Image()
      img.src = Buffer.from(buffer)
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = reject
      })

      // 直接使用用户配置的质量值，不进行自动调整
      const finalQuality = Math.max(1, Math.min(100, quality))

      const canvas = createCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      return canvas.encode('jpeg', finalQuality)
    } catch (error) {
      throw new Error(`Failed to convert to JPEG: ${error.message}`)
    }
  }

  /**
   * WebP 转 JPEG (优化路径)
   * @param buffer 原始图片 Buffer (任意格式)
   * @param quality JPEG 质量
   */
  async webpToJpeg(buffer: Uint8Array, quality: number): Promise<Uint8Array> {
    // Canvas 自动处理各种格式，无需特殊检测
    return this.convertToJpeg(buffer, quality)
  }

  /**
   * 将任意格式图片转换为 PNG
   * @param buffer 原始图片 Buffer
   * @returns PNG 格式的 Buffer
   */
  async convertToPng(buffer: Uint8Array): Promise<Uint8Array> {
    try {
      const img = new Image()
      img.src = Buffer.from(buffer)
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = reject
      })

      const canvas = createCanvas(img.width, img.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      return canvas.encode('png')
    } catch (error) {
      throw new Error(`Failed to convert to PNG: ${error.message}`)
    }
  }

  /**
   * 压缩 JPEG 图片
   * @param buffer 原始 JPEG Buffer
   * @param quality 目标质量
   * @param skipThreshold 跳过阈值 (字节)，低于此值不压缩
   */
  async compressJpeg(buffer: Uint8Array, quality: number, skipThreshold: number): Promise<Uint8Array> {
    if (skipThreshold > 0 && buffer.length < skipThreshold) {
      return buffer
    }
    return this.convertToJpeg(buffer, quality)
  }

  /**
   * 获取图片尺寸 (无需完整解码)
   */
  async getDimensions(buffer: Uint8Array): Promise<{ width: number; height: number }> {
    try {
      const img = new Image()
      img.src = Buffer.from(buffer)
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = reject
      })
      return { width: img.width, height: img.height }
    } catch (error) {
      throw new Error(`Failed to get dimensions: ${error.message}`)
    }
  }

  /**
   * 应用轻量级抗审查处理并转换为 WebP 格式
   * 策略：在随机角落添加随机数字水印 (15% 不透明度)
   *
   * @param buffer 原始图片 Buffer
   * @param format 目标格式 ('jpeg' | 'png' | 'webp')
   * @param quality 质量 (1-100)
   * @returns 处理后的图片 Buffer
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
    } catch (error) {
      throw new Error(`Failed to apply anti-censorship: ${error.message}`)
    }
  }

  /**
   * 统一图片处理管道
   * @param buffer 原始图片
   * @param targetFormat 目标格式 ('jpeg' | 'png' | 'webp')
   * @param quality 质量 (1-100)
   * @param applyAntiCensor 是否应用反和谐
   * @param noiseIntensity 噪点强度 (保留参数)
   */
  async processImage(
    buffer: Uint8Array,
    targetFormat: string,
    quality: number,
    applyAntiCensor: boolean,
    noiseIntensity: number = 5.0
  ): Promise<Uint8Array> {
    // 如果需要反和谐处理
    if (applyAntiCensor) {
      return this.applyAntiCensorship(buffer, targetFormat, quality)
    }

    // 标准格式转换
    const img = new Image()
    img.src = Buffer.from(buffer)
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = reject
    })

    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)

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

  /**
   * 批量转换图片为 JPEG
   * @param buffers 图片 Buffer 数组
   * @param quality JPEG 质量
   * @returns 转换结果数组 (成功返回 Buffer，失败返回错误字符串)
   */
  async batchConvertToJpeg(buffers: Uint8Array[], quality: number): Promise<Array<Uint8Array | string>> {
    const results = await Promise.allSettled(
      buffers.map(buffer => this.convertToJpeg(buffer, quality))
    )

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value
      } else {
        logger.warn(`批量转换失败 [${index}]: ${result.reason}`)
        return `Error: ${result.reason.message || result.reason}`
      }
    })
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

/**
 * 获取处理器实例 (如果未初始化则返回 null)
 */
export function getCanvasProcessor(): CanvasImageProcessor | null {
  return processorInstance
}

export { CanvasImageProcessor, createCanvas, loadImage, Image, GlobalFonts }
