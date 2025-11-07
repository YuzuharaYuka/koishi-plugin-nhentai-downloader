import { Logger, sleep } from 'koishi'

// 插件专用的 Logger 实例
export const logger = new Logger('nhentai-downloader')

export { sleep }

// 将 Buffer 转换为 Base64 格式的 Data URI
export function bufferToDataURI(buffer: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

// 动态导入 ESM 模块
export async function importESM<T = any>(moduleName: string): Promise<T> {
  try {
    const module = await import(moduleName)
    return (module.default ?? module) as T
  } catch (error) {
    logger.error(`导入模块 "${moduleName}" 失败: ${error.message}`)
    throw new Error(`无法加载模块 ${moduleName}: ${error.message}`)
  }
}

// 统一的错误日志记录函数
export function logError(context: string, identifier: string | number, error: any): void {
  const errorMessage = error.response?.body
    ? JSON.stringify(error.response.body)
    : error.message || String(error)
  logger.error(`${context} ${identifier} 失败: ${errorMessage}`)
}
