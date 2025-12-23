// 定义处理器模块中使用的核心 TypeScript 类型

// Canvas 图片处理器类的接口定义 (替代原 WASM 实现)
export interface CanvasImageProcessor {
  // 将任意格式图片转换为 JPEG
  convertToJpeg(buffer: Uint8Array, quality: number): Promise<Uint8Array>
  // 将任意格式图片转换为 PNG
  convertToPng(buffer: Uint8Array): Promise<Uint8Array>
  // 将 WebP 图片转换为 JPEG
  webpToJpeg(buffer: Uint8Array, quality: number): Promise<Uint8Array>
  // 应用轻量级抗审查处理并转换为 WebP：在图片角落添加随机数字水印（0-9，低不透明度 15%）
  applyAntiCensorshipJpeg(buffer: Uint8Array, noiseIntensity?: number): Promise<Uint8Array>
  // 按指定质量压缩 JPEG 图片
  compressJpeg(buffer: Uint8Array, quality: number, skipThreshold: number): Promise<Uint8Array>
  // 获取图片尺寸
  getDimensions(buffer: Uint8Array): Promise<{ width: number; height: number }>
  // 统一图片处理管道
  processImage(
    buffer: Uint8Array,
    targetFormat: string,
    quality: number,
    applyAntiCensor: boolean,
    noiseIntensity?: number
  ): Promise<Uint8Array>
  // 批量转换图片为 JPEG
  batchConvertToJpeg(buffers: Uint8Array[], quality: number): Promise<Array<Uint8Array | string>>
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
