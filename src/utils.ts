import { Logger, sleep } from 'koishi'

/**
 * 插件专用的 Logger 实例。
 */
export const logger = new Logger('nhentai-downloader')

export { sleep }

/**
 * 将 Buffer 转换为 Base64 格式的 Data URI。
 * @param buffer 输入的 Buffer 对象
 * @param mime MIME 类型，默认为 'image/jpeg'
 * @returns Data URI 字符串
 */
export function bufferToDataURI(buffer: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/**
 * 动态导入 ESM 模块。
 * @param moduleName 要导入的模块名
 * @returns 导入的模块
 */
export async function importESM<T = any>(moduleName: string): Promise<T> {
  try {
    const importFn = new Function('specifier', 'return import(specifier)')
    const module = await importFn(moduleName)

    return (module.default ?? module) as T
  } catch (error) {
    logger.error(`导入模块 "${moduleName}" 失败: ${error.message}`)
    throw new Error(`无法加载模块 ${moduleName}: ${error.message}`)
  }
}
