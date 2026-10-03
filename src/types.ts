// ============================================================
// 类型定义
// 上半部分为官方 API v2 的原始响应结构（与 openapi.json 一一对应），
// 下半部分为插件内部使用的归一化结构。
// ============================================================

// ─── 官方 API v2 原始结构 ────────────────────────────────────

/** GalleryDetailResponse.cover / .thumbnail（对象为 CoverInfo） */
export interface ApiCoverInfo {
  path: string
  width: number
  height: number
}

/** GalleryDetailResponse.pages[]（对象为 PageInfo） */
export interface ApiPageInfo {
  number: number
  path: string
  width: number
  height: number
  /** 缩略图相对路径（字符串，不是对象） */
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
}

/** GalleryDetailResponse.title（对象为 GalleryTitle） */
export interface ApiGalleryTitle {
  english: string
  japanese: string | null
  pretty: string
}

/** 标签（对象为 TagResponse） */
export interface ApiTag {
  id: number
  type: string
  name: string
  slug: string
  url: string
  count: number
  description?: string | null
  is_community?: boolean | null
}

/** 列表项（对象为 GalleryListItem，用于搜索 / 热门 / 相关作品） */
export interface ApiGalleryListItem {
  id: number
  media_id: string
  english_title: string
  japanese_title: string | null
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
  num_pages?: number
  num_favorites?: number
  tag_ids?: number[]
  blacklisted?: boolean
}

/** 画廊详情（对象为 GalleryDetailResponse） */
export interface ApiGalleryDetail {
  id: number
  media_id: string
  title: ApiGalleryTitle
  cover: ApiCoverInfo
  thumbnail: ApiCoverInfo
  scanlator?: string
  upload_date: number
  tags: ApiTag[]
  num_pages: number
  num_favorites: number
  pages?: ApiPageInfo[]
  /** 仅在 include 包含对应项时返回 */
  comments?: unknown[] | null
  comment_count?: number | null
  related?: ApiGalleryListItem[] | null
  is_favorited?: boolean | null
  suggestions?: unknown
}

/** 分页响应（对象为 PaginatedResponse[T]） */
export interface ApiPaginated<T> {
  result: T[]
  num_pages: number
  per_page?: number
  total?: number | null
}

/** GET /galleries/{id}/related（对象为 RelatedGalleriesResponse，无分页字段） */
export interface ApiRelatedGalleries {
  result: ApiGalleryListItem[]
}

/** GET /cdn（对象为 CdnConfigResponse） */
export interface ApiCdnConfig {
  image_servers: string[]
  thumb_servers: string[]
}

export interface ApiAnnouncementLink {
  label?: string
  url?: string
}

export interface ApiAnnouncement {
  message: string
  links?: ApiAnnouncementLink[]
}

/** GET /config（对象为 ConfigResponse，CDN 配置的超集） */
export interface ApiAppConfig extends ApiCdnConfig {
  announcement?: ApiAnnouncement | null
}

/** GET /galleries/random（对象为 {id} 的宽松结构） */
export interface ApiRandomGallery {
  id: number
}

/** POST /galleries/{id}/download（对象为 DownloadResponse） */
export interface ApiDownloadResponse {
  url: string
  /** 过期时间（Unix 秒） */
  expires_at: number
}

/** 422 校验错误（对象为 HTTPValidationError） */
export interface ApiValidationError {
  detail?: Array<{ loc?: Array<string | number>; msg?: string; type?: string }>
}

// ─── 插件内部归一化结构 ──────────────────────────────────────

/** 页面信息：缩略图被归一化为完整相对路径字符串 */
export interface PageInfo {
  number: number
  /** 相对 CDN 路径，例如 galleries/4222903/1.webp */
  path: string
  width: number
  height: number
  /** 相对 CDN 路径，例如 galleries/4222903/1t.webp */
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
}

/** 图片对象（封面 / 缩略图） */
export interface ImageObject {
  path: string
  width: number
  height: number
}

/** 画廊图片集合 */
export interface GalleryImages {
  pages: PageInfo[]
  cover: ImageObject
  thumbnail: ImageObject
}

/** 画廊标题 */
export interface Title {
  english: string
  japanese: string
  pretty: string
}

/** 标签 */
export interface Tag {
  id: number
  type: 'tag' | 'category' | 'artist' | 'parody' | 'character' | 'group' | 'language' | string
  name: string
  url: string
  count: number
  slug?: string
}

/** 列表项归一化结构（搜索 / 热门 / 相关作品） */
export interface SearchGallery {
  id: number
  media_id: string
  english_title: string
  japanese_title: string | null
  /** CDN 相对路径 */
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
  num_pages: number
  num_favorites: number
  tag_ids: number[]
  blacklisted: boolean
}

/** 画廊详情归一化结构 */
export interface Gallery {
  id: string
  media_id: string
  title: Title
  images: GalleryImages
  scanlator: string
  upload_date: number
  tags: Tag[]
  num_pages: number
  num_favorites: number
  /** 仅在请求时带 include=related 才有值 */
  related?: SearchGallery[]
}

/** 列表结果（搜索 / 热门 / 相关作品统一结构） */
export interface SearchResult {
  result: SearchGallery[]
  num_pages: number
  per_page: number
  total?: number | null
}

/** 菜单中可以出现的画廊（列表项或详情） */
export type MenuGallery = Gallery | SearchGallery
