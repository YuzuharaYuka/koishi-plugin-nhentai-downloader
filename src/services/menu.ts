import { Session, h } from 'koishi'
import { Config } from '../config'
import { Gallery } from '../types'
import { NhentaiService } from './nhentai'
import { MenuGenerator } from './menu-generator'
import { logger } from '../utils'

// 菜单交互服务，用于管理图片菜单的生成和用户交互
export class MenuService {
  private menuGenerator: MenuGenerator
  private activeMenus: Map<string, { galleries: Partial<Gallery>[], timestamp: number }> = new Map()
  private readonly MENU_EXPIRE_TIME = 5 * 60 * 1000 // 5分钟过期
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(private config: Config, private nhentaiService: NhentaiService) {
    this.menuGenerator = new MenuGenerator(config, {
      columns: config.menuMode.columns,
      maxRows: config.menuMode.maxRows,
    })
    // 定期清理过期的菜单
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMenus(), 60000)
  }

  // 生成并发送搜索结果图片菜单
  async sendSearchMenu(
    session: Session,
    galleries: Partial<Gallery>[],
    totalResults?: number,
    startIndex?: number
  ): Promise<Partial<Gallery>[]> {
    try {
      const maxItems = this.config.menuMode.columns * this.config.menuMode.maxRows
      const displayGalleries = galleries.slice(0, maxItems)

      // 图片菜单模式始终获取缩略图
      const covers = await this.nhentaiService.getCoversForGalleries(displayGalleries)
      const thumbnails = displayGalleries.map(gallery => covers.get(gallery.id as string)?.buffer ?? Buffer.alloc(0))

      // 生成菜单图片
      const menuImage = await this.menuGenerator.generateMenu(displayGalleries, thumbnails, totalResults, startIndex)

      // 发送菜单图片
      await session.send(h.image(menuImage, 'image/png'))

      // 保存当前菜单到会话状态
      const menuKey = this.getMenuKey(session)
      this.activeMenus.set(menuKey, {
        galleries: displayGalleries,
        timestamp: Date.now(),
      })

      logger.info(`生成了包含 ${displayGalleries.length} 个画廊的菜单`)

      return displayGalleries

    } catch (error) {
      logger.error(`生成搜索菜单失败: ${error.message}`)
      throw error
    }
  }

  // 处理用户的菜单选择
  async handleMenuSelection(session: Session, selection: string): Promise<Partial<Gallery> | null> {
    const menuKey = this.getMenuKey(session)
    const menu = this.activeMenus.get(menuKey)

    if (!menu) {
      return null
    }

    if (this.isMenuExpired(menuKey, menu)) {
      return null
    }

    const index = parseInt(selection, 10)

    if (index === 0) {
      this.activeMenus.delete(menuKey) // 用户取消选择
      return null
    }

    if (isNaN(index) || index < 1 || index > menu.galleries.length) {
      return null
    }

    const selectedGallery = menu.galleries[index - 1]
    this.activeMenus.delete(menuKey) // 清除菜单状态
    return selectedGallery
  }

  // 检查会话是否有活跃的菜单
  hasActiveMenu(session: Session): boolean {
    const menuKey = this.getMenuKey(session)
    const menu = this.activeMenus.get(menuKey)
    return menu ? !this.isMenuExpired(menuKey, menu) : false
  }

  // 清除会话的菜单状态
  clearMenu(session: Session): void {
    const menuKey = this.getMenuKey(session)
    this.activeMenus.delete(menuKey)
  }

  // 获取菜单键（平台:群组ID:用户ID）
  private getMenuKey(session: Session): string {
    const channelId = session.guildId ?? session.userId
    return `${session.platform}:${channelId}:${session.userId}`
  }

  // 检查菜单是否过期
  private isMenuExpired(menuKey: string, menu: { galleries: Partial<Gallery>[], timestamp: number }): boolean {
    if (Date.now() - menu.timestamp > this.MENU_EXPIRE_TIME) {
      this.activeMenus.delete(menuKey)
      return true
    }
    return false
  }

  // 清理过期的菜单
  private cleanupExpiredMenus(): void {
    const now = Date.now()
    let cleanedCount = 0

    for (const [key, menu] of this.activeMenus.entries()) {
      if (now - menu.timestamp > this.MENU_EXPIRE_TIME) {
        this.activeMenus.delete(key)
        cleanedCount++
      }
    }

    if (cleanedCount > 0 && this.config.debug) {
      logger.info(`清理了 ${cleanedCount} 个过期菜单`)
    }
  }

  // 释放资源
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer) // 清除定时器，防止内存泄漏
      this.cleanupTimer = null
    }
    this.activeMenus.clear()
    this.menuGenerator.dispose()
    if (this.config.debug) {
      logger.info('菜单服务已清理')
    }
  }
}
