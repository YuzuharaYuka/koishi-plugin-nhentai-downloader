// 定义处理器模块中使用的核心 TypeScript 类型

// Canvas 图片处理器类的接口定义
export interface CanvasImageProcessor {
  // 应用抗审查处理并编码为指定格式（jpeg / png / webp）
  applyAntiCensorship(buffer: Uint8Array, format?: string, quality?: number): Promise<Uint8Array>
  // 最长边是否超过给定值
  exceedsEdge(buffer: Uint8Array, maxEdge: number): Promise<boolean>
  // 统一图片处理管道：解码一次，可选缩放，再编码到目标格式
  processImage(
    buffer: Uint8Array,
    targetFormat: string,
    quality: number,
    applyAntiCensor: boolean,
    maxEdge?: number
  ): Promise<Uint8Array>
}

// 表示已下载的原始图片数据
export interface DownloadedImage {
  // 图片在画廊中的索引（从 0 开始）
  index: number
  // 图片的原始二进制数据
  buffer: Buffer
  // 图片的原始文件扩展名（如 'jpg', 'png'）
  extension: string
  // 下载过程中发生的错误（可选）
  error?: Error
  // 画廊 ID（可选，用于缓存）
  galleryId?: string
  // 媒体 ID（可选，用于缓存）
  mediaId?: string
}

// 表示已处理的图片数据，继承自 DownloadedImage
export interface ProcessedImage extends DownloadedImage {
  // 处理后的图片二进制数据
  processedBuffer?: Buffer
  // 处理后的最终图片格式
  finalFormat?: string
}
