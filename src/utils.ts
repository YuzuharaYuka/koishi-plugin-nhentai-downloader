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
    const message = getErrorMessage(error)
    logger.error(`导入模块 "${moduleName}" 失败: ${message}`)
    throw new Error(`无法加载模块 ${moduleName}: ${message}`)
  }
}

// 统一的错误消息提取函数
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// 统一的错误日志记录函数
export function logError(context: string, identifier: string | number, error: unknown): void {
  const errorMessage = getErrorMessage(error)
  const response = (error as any)?.response?.body

  if (response) {
    logger.error(`[${context}] ${identifier} 失败: ${errorMessage}\n响应: ${JSON.stringify(response)}`)
  } else {
    logger.error(`[${context}] ${identifier} 失败: ${errorMessage}`)
  }
}
