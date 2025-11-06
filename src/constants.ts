// nhentai API and CDN hosts
export const API_BASE = 'https://nhentai.net/api';
export const IMAGE_HOST_PRIMARY = 'i.nhentai.net';
export const IMAGE_HOST_FALLBACK = ['i2.nhentai.net', 'i3.nhentai.net', 'i4.nhentai.net'];
export const THUMB_HOST_PRIMARY = 't.nhentai.net';
export const THUMB_HOST_FALLBACK = ['t2.nhentai.net', 't3.nhentai.net', 't4.nhentai.net'];

// Supported nhentai hosts for link recognition
export const NHENTAI_HOSTS = ['nhentai.net', 'nhentai.to'];
const hostsRegexPart = NHENTAI_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|');
// Regex to extract gallery ID from URL
export const galleryUrlRegex = new RegExp(`(?:https?://)?(?:${hostsRegexPart})/g/(\\d+)/?`);

// Map nhentai image type character to file extension
export const imageExtMap: Record<string, 'jpg' | 'png' | 'gif' | 'webp'> = {
  j: 'jpg',
  p: 'png',
  g: 'gif',
  w: 'webp',
};
