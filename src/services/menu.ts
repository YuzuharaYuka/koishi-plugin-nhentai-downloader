/**
 * 菜单服务：取封面 → 渲染 → 发送，本身不保存状态。
 */
import { Session, h } from 'koishi'
import type { Config } from '../config'
import type { Gallery, MenuGallery } from '../types'
import { NhentaiService } from './nhentai'
import { MenuGenerator } from './menu-generator'
import { logger } from '../utils'

// 菜单服务
export class MenuService {
  private menuGenerator: MenuGenerator

  constructor(private config: Config, private nhentaiService: NhentaiService) {
    this.menuGenerator = new MenuGenerator(config, {
      columns: config.menuMode.columns,
      maxRows: config.menuMode.maxRows,
    })
  }

  async sendSearchMenu(
    session: Session,
    galleries: MenuGallery[],
    totalResults?: number,
    startIndex?: number,
    pageInfo?: { page: number; totalPages: number },
  ): Promise<MenuGallery[]> {
    try {
      const maxItems = this.config.menuMode.columns * this.config.menuMode.maxRows
      const displayGalleries = galleries.slice(0, maxItems)

      // 缩略图会合成进菜单图片，水印无意义（原图指纹已不可比），跳过一次重编码
      const covers = await this.nhentaiService.getCoversForGalleries(displayGalleries, { watermark: false })
      const thumbnails = displayGalleries.map(gallery => covers.get(String(gallery.id))?.buffer ?? Buffer.alloc(0))

      const menuImage = await this.menuGenerator.generateMenu(
        displayGalleries,
        thumbnails,
        totalResults,
        startIndex,
        pageInfo,
      )

      await session.send(h.image(menuImage, 'image/jpeg'))

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

      await session.send(h.image(menuImage, 'image/jpeg'))

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.error(`生成详细菜单失败: ${err.message}`)
      throw err
    }
  }

  // 释放资源
  dispose(): void {
    this.menuGenerator.dispose()
    if (this.config.debug) {
      logger.info('菜单服务已释放')
    }
  }
}
