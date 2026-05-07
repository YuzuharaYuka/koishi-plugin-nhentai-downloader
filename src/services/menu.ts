import { Session, h } from 'koishi'
import { Config } from '../config'
import { Gallery, MenuGallery } from '../types'
import { NhentaiService } from './nhentai'
import { MenuGenerator } from './menu-generator'
import { logger } from '../utils'
import { MENU_EXPIRE_TIME_MS, MENU_CLEANUP_INTERVAL_MS } from '../constants'

// 菜单服务
export class MenuService {
  private menuGenerator: MenuGenerator
  private activeMenus: Map<string, { galleries: MenuGallery[], timestamp: number }> = new Map()
  private readonly MENU_EXPIRE_TIME = MENU_EXPIRE_TIME_MS
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(private config: Config, private nhentaiService: NhentaiService) {
    this.menuGenerator = new MenuGenerator(config, {
      columns: config.menuMode.columns,
      maxRows: config.menuMode.maxRows,
    })
    // 定期清理过期菜单
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMenus(), MENU_CLEANUP_INTERVAL_MS)
  }

  async sendSearchMenu(
    session: Session,
    galleries: MenuGallery[],
    totalResults?: number,
    startIndex?: number
  ): Promise<MenuGallery[]> {
    try {
      const maxItems = this.config.menuMode.columns * this.config.menuMode.maxRows
      const displayGalleries = galleries.slice(0, maxItems)

      const covers = await this.nhentaiService.getCoversForGalleries(displayGalleries)
      const thumbnails = displayGalleries.map(gallery => covers.get(String(gallery.id))?.buffer ?? Buffer.alloc(0))

      const menuImage = await this.menuGenerator.generateMenu(displayGalleries, thumbnails, totalResults, startIndex)

      await session.send(h.image(menuImage, 'image/png'))

      const menuKey = this.getMenuKey(session)
      this.activeMenus.set(menuKey, {
        galleries: displayGalleries,
        timestamp: Date.now(),
      })

      logger.info(`生成了包含 ${displayGalleries.length} 个画廊的菜单`)

      return displayGalleries

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error(`生成搜索菜单失败: ${err.message}`)
      throw err
    }
  }

  // 发送画廊详情菜单
  async sendDetailMenu(session: Session, gallery: Gallery, coverBuffer: Buffer, showRefreshOption: boolean = false): Promise<void> {
    try {
      const menuImage = await this.menuGenerator.generateDetailMenu(gallery, coverBuffer, showRefreshOption)

      await session.send(h.image(menuImage, 'image/png'))

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error(`生成详细菜单失败: ${err.message}`)
      throw err
    }
  }

  // 处理菜单选择
  async handleMenuSelection(session: Session, selection: string): Promise<MenuGallery | null> {
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
      this.activeMenus.delete(menuKey)
      return null
    }

    if (isNaN(index) || index < 1 || index > menu.galleries.length) {
      return null
    }

    const selectedGallery = menu.galleries[index - 1]
    this.activeMenus.delete(menuKey)
    return selectedGallery
  }

  hasActiveMenu(session: Session): boolean {
    const menuKey = this.getMenuKey(session)
    const menu = this.activeMenus.get(menuKey)
    return menu ? !this.isMenuExpired(menuKey, menu) : false
  }

  clearMenu(session: Session): void {
    const menuKey = this.getMenuKey(session)
    this.activeMenus.delete(menuKey)
  }

  private getMenuKey(session: Session): string {
    const channelId = session.guildId ?? session.userId
    return `${session.platform}:${channelId}:${session.userId}`
  }

  private isMenuExpired(menuKey: string, menu: { galleries: MenuGallery[], timestamp: number }): boolean {
    if (Date.now() - menu.timestamp > this.MENU_EXPIRE_TIME) {
      this.activeMenus.delete(menuKey)
      return true
    }
    return false
  }

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
      logger.info('菜单服务已释放')
    }
  }
}
