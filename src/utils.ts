import { Logger, sleep } from 'koishi'

export const logger = new Logger('nhentai-downloader')

export { sleep }

export function bufferToDataURI(buffer: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}