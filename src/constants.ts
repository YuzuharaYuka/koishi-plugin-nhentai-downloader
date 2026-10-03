// ============================================================
// nhentai API v2 常量
// 所有取值均来自官方文档：https://nhentai.net/api/v2/docs
// 端点/鉴权/限流对照表见 docs/nhentai-api-v2.md
// ============================================================
import { availableParallelism, cpus } from 'os'

const CPU_COUNT = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length

/** API 站点源 */
export const API_ORIGIN = 'https://nhentai.net'
/** API v2 基础 URL */
export const API_BASE = `${API_ORIGIN}/api/v2`

// ─── 客户端标识 ──────────────────────────────────────────────
// 官方文档要求：`AppName/version (contact or project URL)`
export const PLUGIN_NAME = 'koishi-plugin-nhentai-downloader'
export const PLUGIN_VERSION = '2.1.0'
export const PLUGIN_HOMEPAGE = 'https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader'
/** 官方要求写成 `AppName/version (contact or project URL)` */
export const USER_AGENT = `${PLUGIN_NAME}/${PLUGIN_VERSION} (+${PLUGIN_HOMEPAGE})`

// ─── CDN 备用主机 ────────────────────────────────────────────
// 运行时以 GET /api/v2/config 返回的 image_servers / thumb_servers 为准，这里仅作兜底
export const DEFAULT_IMAGE_CDN = 'i1.nhentai.net'
export const DEFAULT_THUMB_CDN = 't1.nhentai.net'
export const CDN_CONFIG_TTL_MS = 6 * 60 * 60 * 1000

// ─── 超时 ────────────────────────────────────────────────────
/** 元数据请求总超时 */
export const API_REQUEST_TIMEOUT_MS = 20000
/** 元数据请求并发上限（限流器按端点配额节流，这里只做整体保护） */
export const API_MAX_CONCURRENCY = 4

// ─── 官方打包直链 ────────────────────────────────────────────
/**
 * 官方 POST /galleries/{id}/download 的签发预算。
 * 文档标注 10/5min，实测签发一次后紧接着再申请必 429，故取保守值。
 */
export const OFFICIAL_ISSUE_LIMIT = 3
export const OFFICIAL_ISSUE_WINDOW_MS = 300_000
/** 相邻两次签发的最小间隔（实测约 15s 后可以再次成功） */
export const OFFICIAL_MIN_INTERVAL_MS = 15_000
/** 官方压缩包下载：传输停滞超时（毫秒） */
export const ARCHIVE_STALL_TIMEOUT_MS = 60_000
/** 官方压缩包默认总超时（秒） */
export const DEFAULT_ARCHIVE_TIMEOUT_SECONDS = 600
/** 压缩包内的图片扩展名 */
export const ARCHIVE_IMAGE_EXTENSIONS = ['.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '.bmp'] as const
/** 压缩包内的元数据文件，不参与 PDF/ZIP 输出 */
export const ARCHIVE_METADATA_FILES = ['meta.json', 'comicinfo.xml'] as const

// ─── 限流 ────────────────────────────────────────────────────
export interface RateLimitRule {
  /** 文档公布的窗口内请求数上限 */
  limit: number
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 相邻两次请求的最小间隔（毫秒） */
  minIntervalMs?: number
}

export type RateLimitKey =
  | 'search'
  | 'gallery'
  | 'galleries'
  | 'tagged'
  | 'popular'
  | 'random'
  | 'related'
  | 'download'
  | 'tagsSearch'
  | 'tagsByIds'
  | 'config'

/**
 * 官方按端点公布限额（匿名 / 携带 API Key 两档）。
 * API 不返回 X-RateLimit-* 响应头，因此必须在客户端主动节流。
 */
export const API_RATE_LIMITS: Record<RateLimitKey, { anon: RateLimitRule; auth: RateLimitRule }> = {
  search: { anon: { limit: 10, windowMs: 60_000 }, auth: { limit: 20, windowMs: 60_000 } },
  gallery: { anon: { limit: 20, windowMs: 60_000 }, auth: { limit: 45, windowMs: 60_000 } },
  galleries: { anon: { limit: 15, windowMs: 60_000 }, auth: { limit: 30, windowMs: 60_000 } },
  tagged: { anon: { limit: 15, windowMs: 60_000 }, auth: { limit: 30, windowMs: 60_000 } },
  popular: { anon: { limit: 8, windowMs: 60_000 }, auth: { limit: 8, windowMs: 60_000 } },
  random: { anon: { limit: 20, windowMs: 60_000 }, auth: { limit: 30, windowMs: 60_000 } },
  related: { anon: { limit: 12, windowMs: 60_000 }, auth: { limit: 30, windowMs: 60_000 } },
  // 官方标注 10/5min per IP，实测每成功一次后立即再申请必 429，故叠加最小间隔
  download: {
    anon: { limit: OFFICIAL_ISSUE_LIMIT, windowMs: OFFICIAL_ISSUE_WINDOW_MS, minIntervalMs: OFFICIAL_MIN_INTERVAL_MS },
    auth: { limit: OFFICIAL_ISSUE_LIMIT, windowMs: OFFICIAL_ISSUE_WINDOW_MS, minIntervalMs: OFFICIAL_MIN_INTERVAL_MS },
  },
  tagsSearch: { anon: { limit: 30, windowMs: 60_000 }, auth: { limit: 30, windowMs: 60_000 } },
  tagsByIds: { anon: { limit: 15, windowMs: 60_000 }, auth: { limit: 15, windowMs: 60_000 } },
  config: { anon: { limit: 15, windowMs: 60_000 }, auth: { limit: 30, windowMs: 60_000 } },
}

/** 主动节流安全系数：只使用文档配额的一部分，避免共享出口 IP 时的 429 */
export const RATE_LIMIT_SAFETY_FACTOR = 0.9

// ─── 查询参数取值 ────────────────────────────────────────────
/** GET /api/v2/search 与 /galleries/tagged 的 sort 枚举 */
export const VALID_SORT_OPTIONS = ['date', 'popular', 'popular-today', 'popular-week', 'popular-month'] as const
export type ValidSortOption = (typeof VALID_SORT_OPTIONS)[number]

/** 命令行的简写 → 官方枚举值 */
export const SORT_ALIASES: Record<string, ValidSortOption> = {
  today: 'popular-today',
  day: 'popular-today',
  week: 'popular-week',
  month: 'popular-month',
}

/** GET /api/v2/galleries/{id} 的 include 可选值 */
export const GALLERY_INCLUDES = ['comments', 'related', 'favorite', 'suggestions'] as const
export type GalleryInclude = (typeof GALLERY_INCLUDES)[number]

/** POST /api/v2/galleries/{id}/download 的 format 可选值 */
export const DOWNLOAD_FORMATS = ['zip', 'cbz', 'torrent'] as const
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number]

// ─── 语言映射 ────────────────────────────────────────────────
export const LANGUAGE_DISPLAY_MAP: Record<string, string> = {
  chinese: '中文',
  japanese: '日语',
  english: '英语',
  all: '',
}

export const VALID_LANG_OPTIONS = ['chinese', 'japanese', 'english', 'all'] as const
// ─── nhentai 链接 ────────────────────────────────────────────
export const NHENTAI_HOSTS = ['nhentai.net', 'nhentai.to']
const hostPattern = NHENTAI_HOSTS.map((host) => host.replace(/\./g, '\\.')).join('|')
export const galleryUrlRegex = new RegExp(`(?:https?://)?(?:${hostPattern})/g/(\\d+)/?`)
export const galleryIdRegex = new RegExp(`^(?:(?:https?://)?(?:${hostPattern})/g/)?(\\d+)/?$`)

// ─── 界面 ────────────────────────────────────────────────────
export const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot']
export const TAG_DISPLAY_LIMIT = 8

// ─── 默认值 ──────────────────────────────────────────────────
// 配置默认值集中在此，schema 与运行时钳制共用同一份，避免两处走样
export const DEFAULT_DOWNLOAD_PATH = './data/temp/nhentai-downloader'
export const DEFAULT_PROMPT_TIMEOUT = 60
export const DEFAULT_IMAGE_SEND_DELAY = 1
export const DEFAULT_COMPRESSION_QUALITY = 85
export const DEFAULT_COMPRESSION_THRESHOLD_KB = 500
/** PDF 内页最长边上限，0 为不限制。实测 1600 可让体积降约 22% 且不增加耗时 */
export const DEFAULT_COMPRESSION_MAX_EDGE = 0
/** 逐张发送的图片质量。实测 90 → 82 体积降约 26%，观感无明显差别 */
export const IMAGE_SEND_QUALITY = 82
/** 菜单图片质量。菜单含照片缩略图，q95 的伪影不可见而体积只有 PNG 的三分之一 */
export const MENU_JPEG_QUALITY = 95
/** 菜单画布背景：比卡片底色略深，让卡片有边界感 */
export const MENU_BACKGROUND_COLOR = '#121212'
/** ZIP 压缩级别：0 为存储模式（图片已是压缩格式，deflate 无收益） */
export const ZIP_COMPRESSION_LEVEL = 0
export const DEFAULT_DOWNLOAD_CONCURRENCY = 10
export const DEFAULT_DOWNLOAD_TIMEOUT = 30
export const DEFAULT_DOWNLOAD_RETRIES = 3
export const DEFAULT_RETRY_DELAY_SECONDS = 2
export const DEFAULT_API_CACHE_TTL_MINUTES = 10
export const DEFAULT_IMAGE_CACHE_TTL_HOURS = 24
export const DEFAULT_IMAGE_CACHE_MAX_MB = 1024
export const DEFAULT_PDF_CACHE_TTL_HOURS = 72
export const DEFAULT_PDF_CACHE_MAX_MB = 2048

// ─── 性能常数 ────────────────────────────────────────────────
export const GC_TRIGGER_INTERVAL = 100
export const PROGRESS_UPDATE_INTERVAL_MS = 1500
export const IMAGE_LOAD_TIMEOUT_MS = 5000
export const COVER_DOWNLOAD_TIMEOUT_MS = 30000

/**
 * 图片解码/编码的并发度。
 *
 * 实测：canvas 的编解码走 libuv 线程池，同时进行的操作数一旦超过
 * UV_THREADPOOL_SIZE（默认 4）会直接段错误崩溃，因此以线程池大小为硬上限。
 * 并发 4 相对 1 有约 2.9 倍吞吐，继续提高收益有限但内存翻倍，故封顶 4。
 */
export const IMAGE_PROCESS_CONCURRENCY = Math.max(
  1,
  Math.min(4, Math.max(1, Number(process.env.UV_THREADPOOL_SIZE) || 4), CPU_COUNT),
)

/** AntiGzip 处理超时时间（毫秒） */
export const ANTI_GZIP_TIMEOUT_MS = 10000
