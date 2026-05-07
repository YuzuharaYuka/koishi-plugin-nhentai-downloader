// nhentai API v2 图片页面信息
export interface PageInfo {
  number: number // 页码
  path: string // 相对 CDN 路径，例如 galleries/1900667/1.jpg
  width: number // 原图宽度
  height: number // 原图高度
  thumbnail: { // 缩略图信息
    path: string
    width: number
    height: number
  }
}

// nhentai API v2 图片信息对象（cover 和 thumbnail）
export interface ImageObject {
  path: string // 相对 CDN 路径
  width: number
  height: number
}

// nhentai 画廊的图片集合（v2 结构）
export interface GalleryImages {
  pages: PageInfo[] // 所有页面信息
  cover: ImageObject // 封面
  thumbnail: ImageObject // 缩略图
}

// nhentai 画廊的标题
export interface Title {
  english: string // 英文标题
  japanese: string // 日文标题
  pretty: string // 优化显示的标题
}

// nhentai 标签信息
export interface Tag {
  id: number
  type: 'tag' | 'category' | 'artist' | 'parody' | 'character' | 'group' | 'language'
  name: string
  url: string
  count: number
}

// nhentai API v2 搜索结果中的画廊（与完整Gallery结构不同）
export interface SearchGallery {
  id: number // 搜索结果中 id 是数字
  media_id: string
  english_title: string // 扁平结构，不是 title.english
  japanese_title: string // 扁平结构，不是 title.japanese
  thumbnail: string // CDN 相对路径，如 "galleries/3922394/thumb.webp"
  thumbnail_width: number
  thumbnail_height: number
  num_pages: number
  tag_ids: number[]
  blacklisted: boolean
}

// 任何可能来自菜单的画廊（搜索或完整获取）
export type MenuGallery = Gallery | SearchGallery

// nhentai 画廊的完整信息（getGallery 返回的格式）
export interface Gallery {
  id: string // 完整 Gallery 中 id 是字符串
  media_id: string
  title: Title // 标题
  images: GalleryImages // 图片信息
  scanlator: string // 扫描者
  upload_date: number // 上传日期 (Unix 时间戳)
  tags: Tag[] // 标签
  num_pages: number // 总页数
  num_favorites: number // 收藏数
}

// nhentai 搜索结果
export interface SearchResult {
  result: SearchGallery[] // 搜索结果中的画廊列表
  num_pages: number // 总页数
  per_page: number // 每页项目数
}
