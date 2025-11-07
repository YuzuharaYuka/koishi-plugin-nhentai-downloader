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
      path.join(__dirname, '../wasm-dist/wasm_image_processor.js'), // 生产环境路径（打包后 lib/index.js）
      path.join(__dirname, '../../wasm-dist/wasm_image_processor.js'), // 开发环境路径 1（lib/processors/wasm.js）
      path.join(__dirname, '../../../wasm-dist/wasm_image_processor.js'), // 开发环境路径 2
      path.join(process.cwd(), 'external', 'nhentai-downloader', 'wasm-dist', 'wasm_image_processor.js'), // 开发环境路径 3
      // 添加 npm 安装后的标准路径（适用于插件市场安装）
      path.join(__dirname, '../../../wasm-dist/wasm_image_processor.js'),
      path.join(__dirname, '../../../../koishi-plugin-nhentai-downloader/wasm-dist/wasm_image_processor.js'),
    ]

    const wasmJsPath = searchPaths.find((p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    })

    if (!wasmJsPath) {
      const errorMsg =
        'WASM module not found. Please ensure the plugin is properly installed.\n' +
        'If building from source, run: yarn build:wasm\n' +
        `Tried paths:\n${searchPaths.map((p, i) => `[${i + 1}] ${p}`).join('\n')}`
      logger.error(errorMsg)
      // 不抛出异常，而是让调用方处理
      throw new Error(errorMsg)
    }

    logger.debug(`找到 WASM 模块: ${wasmJsPath}`)

    // 使用 require 加载模块，避免修改全局 cwd
    const wasmDir = path.dirname(wasmJsPath)
    let wasm: any

    try {
      delete require.cache[wasmJsPath]

      // 保存原始模块搜索路径
      const originalPaths = [...(require.main?.paths || [])]

      // 临时添加 WASM 目录到搜索路径
      if (require.main?.paths) {
        require.main.paths.unshift(wasmDir)
      }

      try {
        wasm = require(wasmJsPath)
      } finally {
        // 恢复原始搜索路径
        if (require.main?.paths) {
          require.main.paths = originalPaths
        }
      }

      if (typeof wasm.init === 'function') {
        wasm.init()
      }

      wasmModule = wasm as WasmImageProcessor
      logger.debug('WASM 模块加载成功')
    } catch (loadError) {
      logger.error(`WASM 模块加载失败: ${loadError.message}`)
      throw new Error(`Failed to load WASM module from ${wasmJsPath}: ${loadError.message}`)
    }
  } catch (error) {
    logger.error(`WASM 处理器初始化失败: ${error.message}`)
    throw error
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
