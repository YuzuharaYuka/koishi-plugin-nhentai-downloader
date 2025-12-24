// nhentai API 和 CDN 主机
export const API_BASE = 'https://nhentai.net/api';
export const IMAGE_HOST_PRIMARY = 'i.nhentai.net';
export const IMAGE_HOST_FALLBACK = ['i2.nhentai.net', 'i3.nhentai.net', 'i4.nhentai.net'];
export const THUMB_HOST_PRIMARY = 't.nhentai.net';
export const THUMB_HOST_FALLBACK = ['t2.nhentai.net', 't3.nhentai.net', 't4.nhentai.net'];

// 支持的 nhentai 主机列表
export const NHENTAI_HOSTS = ['nhentai.net', 'nhentai.to'];
// 从完整 URL 提取画廊 ID 的正则表达式（只匹配 URL，不匹配纯数字）
export const galleryUrlRegex = new RegExp(`(?:https?://)?(?:${NHENTAI_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|')})/g/(\\d+)/?`);
// 从 URL 或纯 ID 字符串提取画廊 ID 的正则表达式（兼容纯数字输入）
export const galleryIdRegex = new RegExp(`^(?:(?:https?://)?(?:${NHENTAI_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|')})/g/)?(\\d+)/?$`);

// nhentai 图片类型字符到文件扩展名的映射
export const imageExtMap: Record<string, 'jpg' | 'png' | 'gif' | 'webp'> = {
  j: 'jpg',
  p: 'png',
  g: 'gif',
  w: 'webp',
};

// 支持转发消息的平台
export const FORWARD_SUPPORTED_PLATFORMS = ['qq', 'onebot'];

// 语言显示名称映射
export const LANGUAGE_DISPLAY_MAP: Record<string, string> = {
  chinese: '中文',
  japanese: '日语',
  english: '英语',
  all: '',
};

// 有效的排序选项
export const VALID_SORT_OPTIONS = ['popular', 'popular-today', 'popular-week'];

// 有效的语言选项
export const VALID_LANG_OPTIONS = ['chinese', 'japanese', 'english', 'all'];

// 画廊信息中的标签显示限制数量
export const TAG_DISPLAY_LIMIT = 8;

// ==================== 性能和内存管理常量 ====================
// GC 触发间隔（处理多少页后触发垃圾回收）
export const GC_TRIGGER_INTERVAL = 50;

// 轮询间隔（毫秒）
export const POLLING_INTERVAL_MS = 50;

// 进度更新节流间隔（毫秒）
export const PROGRESS_UPDATE_INTERVAL_MS = 1500;

// 菜单过期时间（毫秒）
export const MENU_EXPIRE_TIME_MS = 5 * 60 * 1000; // 5分钟

// 菜单清理间隔（毫秒）
export const MENU_CLEANUP_INTERVAL_MS = 60 * 1000; // 1分钟

// 图片加载超时时间（毫秒）
export const IMAGE_LOAD_TIMEOUT_MS = 5000; // 5秒

// 封面下载超时时间（毫秒）
export const COVER_DOWNLOAD_TIMEOUT_MS = 30000; // 30秒

// AntiGzip 处理超时时间（毫秒）
export const ANTI_GZIP_TIMEOUT_MS = 10000; // 10秒
