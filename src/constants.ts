// nhentai API v2 基础 URL
export const API_BASE = 'https://nhentai.net/api/v2'

// CDN 备用主机（从 /api/v2/cdn 动态获取）
export const DEFAULT_IMAGE_CDN = 'i.nhentai.net'
export const DEFAULT_THUMB_CDN = 't.nhentai.net'
export const CDN_CONFIG_TTL_MS = 24 * 60 * 60 * 1000

// User-Agent
export const USER_AGENT_TEMPLATE = 'nhentai-api-client/1.0 (https://nhentai.net)'

// nhentai 主机列表
export const NHENTAI_HOSTS = ['nhentai.net', 'nhentai.to']
export const galleryUrlRegex = new RegExp(`(?:https?://)?(?:${NHENTAI_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|')})/g/(\\d+)/?`)
export const galleryIdRegex = new RegExp(`^(?:(?:https?://)?(?:${NHENTAI_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|')})/g/)?(\\d+)/?$`)

// 支持转发的平台
export const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot']

// 语言映射
export const LANGUAGE_DISPLAY_MAP: Record<string, string> = {
  chinese: '中文',
  japanese: '日语',
  english: '英语',
  all: '',
}

// 排序选项（仅官方 API 支持的选项）
export const VALID_SORT_OPTIONS = ['popular'] as const
export type ValidSortOption = typeof VALID_SORT_OPTIONS[number]

// 语言选项
export const VALID_LANG_OPTIONS = ['chinese', 'japanese', 'english', 'all'] as const
export type ValidLangOption = typeof VALID_LANG_OPTIONS[number]

// 标签显示数量限制
export const TAG_DISPLAY_LIMIT = 8

// 性能常数
export const POLLING_INTERVAL_MS = 50
export const PROGRESS_UPDATE_INTERVAL_MS = 1500
export const MENU_EXPIRE_TIME_MS = 5 * 60 * 1000
export const MENU_CLEANUP_INTERVAL_MS = 60 * 1000
export const GC_TRIGGER_INTERVAL = 100
export const IMAGE_LOAD_TIMEOUT_MS = 5000
export const COVER_DOWNLOAD_TIMEOUT_MS = 30000

// AntiGzip 处理超时时间（毫秒）
export const ANTI_GZIP_TIMEOUT_MS = 10000; // 10秒
