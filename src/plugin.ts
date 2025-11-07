import { Context, Session } from 'koishi'
import { Config } from './config'
import { logger } from './utils'
import { Processor, initWasmProcessor } from './processor'
import { ApiService } from './services/api'
import { NhentaiService } from './services/nhentai'
import { MenuService } from './services/menu'

// 插件主类，负责初始化和管理所有服务
export class NhentaiPlugin {
  private processor: Processor | null = null
  private apiService: ApiService
  private nhentaiService!: NhentaiService
  private menuService: MenuService | null = null
  private isInitialized = false

  constructor(private ctx: Context, private config: Config) {
    this.apiService = new ApiService(ctx, config)
    this.debugLog('调试模式已启用')
  }

  // 调试日志辅助方法
  private debugLog(message: string): void {
    if (this.config.debug) {
      logger.info(message)
    }
  }

  // 初始化插件，加载WASM模块并创建服务实例
  public async initialize(): Promise<void> {
    await initWasmProcessor()
    this.debugLog('图片处理器加载成功')

    await this.apiService.initialize()
    this.processor = new Processor(this.ctx, this.config)
    await this.processor.initializeCache()
    this.nhentaiService = new NhentaiService(this.apiService, this.config, this.processor)

    // 初始化菜单服务
    if (this.config.enableImageMenu) {
      this.menuService = new MenuService(this.config, this.nhentaiService)
      this.debugLog('图片菜单服务已启用')
    }

    this.isInitialized = true
  }

  // 确保插件已初始化，否则向用户发送提示
  public ensureInitialized(session: Session): boolean {
    if (!this.isInitialized) {
      session.send('插件正在初始化，请稍候...')
      return false
    }
    return true
  }

  // 获取 ApiService 实例
  public getApiService(): ApiService {
    return this.apiService
  }

  // 获取 NhentaiService 实例
  public getNhentaiService(): NhentaiService {
    return this.nhentaiService
  }

  // 获取 MenuService 实例
  public getMenuService(): MenuService | null {
    return this.menuService
  }

  // 获取插件配置
  public getConfig(): Config {
    return this.config
  }

  // 清理插件资源，支持热重载
  public dispose(): void {
    this.menuService?.dispose()
    this.apiService?.dispose()
    this.processor?.dispose()
    this.isInitialized = false
    this.debugLog('NhentaiPlugin 资源已清理')
  }
}

