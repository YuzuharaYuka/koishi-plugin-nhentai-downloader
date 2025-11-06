/**
 * WebAssembly (WASM) 模块加载器。
 * 负责在不同环境（开发、生产）下定位并初始化图片处理的 WASM 模块。
 */
import { logger } from '../utils'
import * as path from 'path'
import * as fs from 'fs'
import { WasmImageProcessor } from './types'

let wasmModule: WasmImageProcessor | null = null

/**
 * 初始化 WASM 图片处理模块。
 * 自动搜索并加载 WASM 文件，只在首次调用时执行。
 */
export async function initWasmProcessor(): Promise<void> {
  if (wasmModule) {
    return
  }

  try {
    // 定义可能的 WASM 模块路径
    const searchPaths = [
      path.join(__dirname, '../../wasm-dist/wasm_image_processor.js'), // 生产环境路径
      path.join(__dirname, '../../../wasm-dist/wasm_image_processor.js'), // 开发环境路径 1
      path.resolve(process.cwd(), 'external/nhentai-downloader/wasm-dist/wasm_image_processor.js'), // 开发环境路径 2
    ]

    const wasmJsPath = searchPaths.find((p) => fs.existsSync(p))

    if (!wasmJsPath) {
      throw new Error(
        'WASM module not found. Please ensure the plugin is properly installed.\n' +
          'If building from source, run: yarn build:wasm\n' +
          `Tried paths:\n${searchPaths.join('\n')}`,
      )
    }

    logger.debug(`找到 WASM 模块: ${wasmJsPath}`)

    // 切换工作目录以确保 WASM 能正确加载其依赖
    const wasmDir = path.dirname(wasmJsPath)
    const originalCwd = process.cwd()
    try {
      process.chdir(wasmDir)

      delete require.cache[wasmJsPath] // 清除缓存以支持热重载
      const wasm = require(wasmJsPath)

      if (typeof wasm.init === 'function') {
        wasm.init()
      }

      wasmModule = wasm as WasmImageProcessor
    } finally {
      process.chdir(originalCwd) // 恢复原始工作目录
    }
  } catch (error) {
    throw new Error(`Failed to initialize WASM processor: ${error.message}`)
  }
}

/**
 * 确保 WASM 模块已加载并返回其实例。
 * 如果未加载，则抛出错误。
 */
export function ensureWasmLoaded(): WasmImageProcessor {
  if (!wasmModule) {
    throw new Error('WASM module not initialized. Call initWasmProcessor() first in ctx.on("ready", ...)')
  }
  return wasmModule
}

/**
 * 获取已加载的 WASM 模块实例，如果未加载则返回 null。
 */
export function getWasmModule(): WasmImageProcessor | null {
  return wasmModule
}
