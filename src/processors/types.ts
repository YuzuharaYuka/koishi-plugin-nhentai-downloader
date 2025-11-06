/**
 * 定义处理器模块中使用的核心 TypeScript 类型。
 */

/**
 * WebAssembly 图片处理器模块的接口定义。
 */
export interface WasmImageProcessor {
  /** 将任意格式图片转换为 JPEG。 */
  convert_to_jpeg(buffer: Uint8Array, quality: number): Uint8Array
  /** 将 WebP 图片转换为 JPEG。 */
  webp_to_jpeg(buffer: Uint8Array, quality: number): Uint8Array
  /** 应用轻量级抗审查处理并转换为WebP格式（避免QQ对JPEG的检测）。 */
  apply_anti_censorship_jpeg(buffer: Uint8Array, noise_intensity: number, add_border: boolean, quality: number): Uint8Array
  /** 按指定质量压缩 JPEG 图片。 */
  compress_jpeg(buffer: Uint8Array, quality: number, skip_threshold: number): Uint8Array
  /** 获取图片尺寸。 */
  get_dimensions(buffer: Uint8Array): { width: number; height: number }
  /** 完整处理流程：转换、反和谐、压缩。 */
  process_image(
    buffer: Uint8Array,
    target_format: string,
    quality: number,
    apply_anti_censor: boolean,
    noise_intensity: number,
    add_border: boolean,
  ): Uint8Array
  /** 批量对图片应用抗审查处理并转换为WebP。 */
  batch_apply_anti_censorship_jpeg(
    buffers: Uint8Array[],
    noise_intensity: number,
    add_border: boolean,
    quality: number,
  ): Uint8Array[]
}

/**
 * 表示已下载的原始图片数据。
 */
export interface DownloadedImage {
  /** 图片在画廊中的索引（从 0 开始）。 */
  index: number
  /** 图片的原始二进制数据。 */
  buffer: Buffer
  /** 图片的原始文件扩展名（如 'jpg', 'png'）。 */
  extension: string
  /** 下载过程中发生的错误（可选）。 */
  error?: Error
  /** 画廊 ID（可选，用于缓存）。 */
  galleryId?: string
  /** 媒体 ID（可选，用于缓存）。 */
  mediaId?: string
}

/**
 * 表示已处理的图片数据，继承自 DownloadedImage。
 */
export interface ProcessedImage extends DownloadedImage {
  /** 处理后的图片二进制数据。 */
  processedBuffer?: Buffer
  /** 处理后的最终图片格式。 */
  finalFormat?: string
}
