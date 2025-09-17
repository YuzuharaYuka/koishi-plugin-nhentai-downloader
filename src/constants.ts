// src/constants.ts

// [修改] 恢复所有 URL 为固定的官方源
export const API_BASE = 'https://nhentai.net/api';
export const IMAGE_BASE = 'https://i.nhentai.net';
export const THUMB_BASE = 'https://t.nhentai.net';

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