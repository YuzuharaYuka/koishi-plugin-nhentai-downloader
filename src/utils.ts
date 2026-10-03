import { Logger, sleep } from 'koishi'
import { PLUGIN_NAME } from './constants'

// 插件专用的 Logger 实例
export const logger = new Logger(PLUGIN_NAME)

export { sleep }

// 将 Buffer 转换为 Base64 格式的 Data URI
export function bufferToDataURI(buffer: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${buffer.toString('base64')}`
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

