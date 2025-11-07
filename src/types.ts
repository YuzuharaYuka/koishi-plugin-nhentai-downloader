// nhentai 画廊的图片信息
export interface GalleryImage {
  t: 'j' | 'p' | 'g' // 图片格式
  w: number // 宽度
  h: number // 高度
}

// nhentai 画廊的图片集合
export interface GalleryImages {
  pages: GalleryImage[] // 所有页面图片
  cover: GalleryImage // 封面图片
  thumbnail: GalleryImage // 缩略图
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

// nhentai 画廊的完整信息
export interface Gallery {
  id: string // 画廊 ID
  media_id: string // 媒体 ID
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
  result: Partial<Gallery>[] // 画廊列表
  num_pages: number // 总页数
  per_page: number // 每页项目数
}
