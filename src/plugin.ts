// src/plugin.ts
import { Context } from 'koishi'
import { Config } from './config'
import { logger } from './utils'
import { Processor, initWasmProcessor } from './processor'
import { ApiService } from './services/api'
import { NhentaiService } from './services/nhentai'
import { Session } from 'koishi'

/**
 * 插件主类
 * 负责初始化和管理所有服务
 */
export class NhentaiPlugin {
  private processor: Processor | null = null
  private apiService: ApiService
  private nhentaiService: NhentaiService | null = null
  private isInitialized: boolean = false

  constructor(private ctx: Context, private config: Config) {
    if (config.debug) {
      logger.info('调试模式已启用。')
    }
    this.apiService = new ApiService(ctx, config)
  }

  /**
   * 初始化插件
   * 必须在 WASM 模块加载后调用
   */
  public async initialize(): Promise<void> {
    // Initialize Processor after WASM is loaded
    this.processor = new Processor(this.ctx, this.config)
    // Initialize image cache
    await this.processor.initializeCache()
    this.nhentaiService = new NhentaiService(this.config, this.apiService, this.processor)
    this.isInitialized = true
  }

  /**
   * 检查插件是否已初始化
   */
  public ensureInitialized(session: Session): boolean {
    if (!this.isInitialized) {
      session.send('插件正在初始化中，请稍后再试...')
      return false
    }
    return true
  }

  /**
   * 获取 API 服务
   */
  public getApiService(): ApiService {
    return this.apiService
  }

  /**
   * 获取 Nhentai 服务
   */
  public getNhentaiService(): NhentaiService {
    if (!this.nhentaiService) {
      throw new Error('插件尚未初始化')
    }
    return this.nhentaiService
  }

  /**
   * 获取配置
   */
  public getConfig(): Config {
    return this.config
  }
}

