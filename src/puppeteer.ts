// src/puppeteer.ts
import { Context, Logger } from 'koishi'
import { Config } from './config'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import find from 'puppeteer-finder'
import type { Browser, Page } from 'puppeteer-core'

const logger = new Logger('nhentai-downloader:puppeteer')
puppeteer.use(StealthPlugin())

export class PuppeteerManager {
    private _browserPromise: Promise<Browser> | null = null;
    private _closeTimer: NodeJS.Timeout | null = null;

    constructor(private ctx: Context, private config: Config) {}

    public async initialize(): Promise<void> {
        if (!this.config.puppeteer.persistentBrowser) return;
        logger.info('[Stealth] 正在预初始化常驻浏览器实例...');
        try {
            await this.getBrowser();
            logger.info('[Stealth] 常驻浏览器实例已成功预初始化。');
        } catch (error) {
            logger.error('[Stealth] 预初始化常驻浏览器实例失败:', error);
        }
    }

    private async getBrowserPath(): Promise<string> {
        const customPath = this.config.puppeteer.chromeExecutablePath;
        if (customPath) {
            if (this.config.debug) logger.info(`[Stealth] 使用用户配置的浏览器路径: ${customPath}`);
            return customPath;
        }
        
        try {
            if (this.config.debug) logger.info('[Stealth] 正在使用 puppeteer-finder 自动检测浏览器...');
            const browserPath = await find();
            logger.info(`[Stealth] 自动检测到浏览器路径: ${browserPath}`);
            return browserPath;
        } catch (error) {
            logger.warn('[Stealth] puppeteer-finder 未能找到任何浏览器。');
            throw new Error('未能找到任何兼容的浏览器。请在插件的浏览器设置中手动指定路径，或确保已安装 Chrome/Chromium。');
        }
    }

    private async launchBrowser(): Promise<Browser> {
        const executablePath = await this.getBrowserPath();
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                `--user-agent=${this.config.userAgent}`
            ],
            executablePath: executablePath,
        });

        browser.on('disconnected', () => {
            logger.warn('[Stealth] 共享浏览器实例已断开连接。');
            this._browserPromise = null;
        });
        return browser;
    }

    private getBrowser(): Promise<Browser> {
        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }

        if (this._browserPromise) {
            return this._browserPromise.then(browser => {
                if (browser.isConnected()) return browser;
                this._browserPromise = this.launchBrowser().catch(err => { this._browserPromise = null; throw err; });
                return this._browserPromise;
            });
        }
        this._browserPromise = this.launchBrowser().catch(err => { this._browserPromise = null; throw err; });
        return this._browserPromise;
    }
    
    private async scheduleClose() {
        if (this.config.puppeteer.persistentBrowser || this._closeTimer) return;

        const browser = await this.getBrowser();
        if ((await browser.pages()).length > 1) return;

        const timeout = this.config.puppeteer.browserCloseTimeout * 1000;
        if (timeout <= 0) {
             this.dispose();
             return;
        }

        this._closeTimer = setTimeout(() => {
            this.dispose();
            this._closeTimer = null;
        }, timeout);
    }

    public async getPage(): Promise<Page> {
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        await page.setBypassCSP(true);
        return page;
    }

    // [优化] 新增一个释放页面的方法，封装关闭逻辑
    public async releasePage(page: Page): Promise<void> {
        if (page && !page.isClosed()) {
            try {
                await page.close();
            } catch (error) {
                logger.warn('[Stealth] 关闭页面时发生错误:', error);
            }
        }
        // 如果不是常驻模式，每次关闭页面后都检查是否可以关闭整个浏览器
        if (!this.config.puppeteer.persistentBrowser) {
            this.scheduleClose();
        }
    }

    public async dispose() {
        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }

        if (this._browserPromise) {
            try {
                const browser = await this._browserPromise;
                if (browser?.isConnected()) {
                    await browser.close();
                }
            } catch (error) {
                logger.warn('[Stealth] 关闭浏览器实例时发生错误:', error);
            }
            this._browserPromise = null;
        }
    }
}