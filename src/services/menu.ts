import { Session, h } from 'koishi'
import { Config } from '../config'
import { Gallery } from '../types'
import { NhentaiService } from './nhentai'
import { MenuGenerator } from './menu-generator'
import { logger } from '../utils'

/**
 * 菜单交互服务，用于管理图片菜单的生成和用户交互
 */
export class MenuService {
  private menuGenerator: MenuGenerator
  private activeMenus: Map<string, { galleries: Partial<Gallery>[], timestamp: number }> = new Map()
  private readonly MENU_EXPIRE_TIME = 5 * 60 * 1000 // 5分钟过期

  constructor(private config: Config, private nhentaiService: NhentaiService) {
    this.menuGenerator = new MenuGenerator(config, {
      columns: config.imageMenuColumns,
      maxRows: config.imageMenuMaxRows,
    })

    // 定期清理过期的菜单
    setInterval(() => this.cleanupExpiredMenus(), 60000)
  }

  /**
   * 生成并发送搜索结果图片菜单
   */
  async sendSearchMenu(
    session: Session,
    galleries: Partial<Gallery>[],
    totalResults?: number
  ): Promise<Partial<Gallery>[]> {
    try {
      const maxItems = this.config.imageMenuColumns * this.config.imageMenuMaxRows
      const displayGalleries = galleries.slice(0, maxItems)

      // 获取缩略图
      const covers = await this.nhentaiService.getCoversForGalleries(displayGalleries)
      const thumbnails: Buffer[] = []

      for (const gallery of displayGalleries) {
        const cover = covers.get(gallery.id as string)
        if (cover) {
          thumbnails.push(cover.buffer)
        } else {
          // 如果缩略图获取失败，使用空 Buffer
          thumbnails.push(Buffer.alloc(0))
        }
      }

      // 生成菜单图片
      const menuImage = await this.menuGenerator.generateMenu(displayGalleries, thumbnails, totalResults)

      // 发送菜单图片
      await session.send(h.image(menuImage, 'image/png'))

      // 保存当前菜单到会话状态
      const menuKey = this.getMenuKey(session)
      this.activeMenus.set(menuKey, {
        galleries: displayGalleries,
        timestamp: Date.now(),
      })

      if (this.config.debug) {
        logger.info(`生成了包含 ${displayGalleries.length} 个画廊的菜单`)
      }

      return displayGalleries

    } catch (error) {
      logger.error(`生成搜索菜单失败: ${error.message}`)
      throw error
    }
  }

  /**
   * 处理用户的菜单选择
   */
  async handleMenuSelection(session: Session, selection: string): Promise<Partial<Gallery> | null> {
    const menuKey = this.getMenuKey(session)
    const menu = this.activeMenus.get(menuKey)

    if (!menu) {
      return null
    }

    // 检查菜单是否过期
    if (Date.now() - menu.timestamp > this.MENU_EXPIRE_TIME) {
      this.activeMenus.delete(menuKey)
      return null
    }

    // 解析选择
    const index = parseInt(selection, 10)

    if (index === 0) {
      // 用户取消选择
      this.activeMenus.delete(menuKey)
      return null
    }

    if (isNaN(index) || index < 1 || index > menu.galleries.length) {
      return null
    }

    // 返回选中的画廊
    const selectedGallery = menu.galleries[index - 1]

    // 清除菜单状态
    this.activeMenus.delete(menuKey)

    return selectedGallery
  }

  /**
   * 检查会话是否有活跃的菜单
   */
  hasActiveMenu(session: Session): boolean {
    const menuKey = this.getMenuKey(session)
    const menu = this.activeMenus.get(menuKey)

    if (!menu) {
      return false
    }

    // 检查是否过期
    if (Date.now() - menu.timestamp > this.MENU_EXPIRE_TIME) {
      this.activeMenus.delete(menuKey)
      return false
    }

    return true
  }

  /**
   * 清除会话的菜单状态
   */
  clearMenu(session: Session): void {
    const menuKey = this.getMenuKey(session)
    this.activeMenus.delete(menuKey)
  }

  /**
   * 获取菜单键
   */
  private getMenuKey(session: Session): string {
    return `${session.platform}:${session.guildId || session.userId}:${session.userId}`
  }

  /**
   * 清理过期的菜单
   */
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

  /**
   * 释放资源
   */
  dispose(): void {
    this.activeMenus.clear()
    this.menuGenerator.dispose()
    if (this.config.debug) {
      logger.info('菜单服务已清理')
    }
  }
}
