// src/constants.ts

// [OPTIMIZE] 根据用户测试结果，更新为准确可用的 CDN 域名列表
export const API_BASE = 'https://nhentai.net/api';
export const IMAGE_HOST_PRIMARY = 'i.nhentai.net';
export const IMAGE_HOST_FALLBACK = ['i2.nhentai.net', 'i3.nhentai.net', 'i4.nhentai.net'];
export const THUMB_HOST_PRIMARY = 't.nhentai.net';
export const THUMB_HOST_FALLBACK = ['t2.nhentai.net', 't3.nhentai.net', 't4.nhentai.net'];


// 链接识别仍然可以支持多个域名
export const NHENTAI_HOSTS = ['nhentai.net', 'nhentai.to'];
const hostsRegexPart = NHENTAI_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|');
export const galleryUrlRegex = new RegExp(`(?:https?://)?(?:${hostsRegexPart})/g/(\\d+)/?`);

// 图片扩展名映射
export const imageExtMap: Record<string, 'jpg' | 'png' | 'gif' | 'webp'> = {
  j: 'jpg', 
  p: 'png', 
  g: 'gif',
  w: 'webp',
};