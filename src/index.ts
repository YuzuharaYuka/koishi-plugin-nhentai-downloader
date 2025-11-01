// src/index.ts
import { Context } from 'koishi'
import { Config } from './config'
import { logger } from './utils'
import { initWasmProcessor } from './processor'
import { NhentaiPlugin } from './plugin'
import { registerAllCommands } from './commands'
import { createLinkRecognitionMiddleware } from './middleware/link-recognition'

export * from './config'
export const name = 'nhentai-downloader'
export const inject = ['http']

export const usage = `
### 本插件提供 **[nhentai](https://nhentai.net/)** 漫画的搜索与下载功能。

---

### 指令用法
\`< >\`为必需项，\`[ ]\`为可选项。
### \`nh.search <关键词> [排序] [语言]\`
根据关键词搜索漫画，支持筛选与排序。
* **别名:** \`nh搜索\`, \`nh search\`
* **选项:** 留空则使用默认配置
  * \`-s, --sort <type>\`: 按热门度排序。可选值为 \`popular\`, \`popular-today\`, \`popular-week\`。
  * \`-l, --lang <lang>\`: 筛选特定语言。可选值为 \`chinese\`, \`japanese\`, \`english\`。设为 \`all\` 则不进行语言筛选。
* **示例1:**\`nh搜索 touhou\`  搜索含 "touhou" 的作品。
* **示例2:**\`nh search touhou -s popular -l chinese\`  搜索中文的 "touhou" 作品，并按热门度排序。
* **交互:** 回复序号下载漫画，回复 \`F\` 翻至下一页，回复 \`B\` 返回上一页，回复 \`N\` 退出交互。

---

### \`nh.search <漫画ID>\`
通过漫画 ID 获取作品详情，并提示是否下载。
* **示例:** \`nh.search 177013\` 获取 ID 为 177013 的漫画信息。
* **交互:** 回复 \`Y\` 确认下载，回复 \`N\` 取消。

---

### \`nh.download <ID/链接> [发送格式] [密码]\`
使用漫画 ID 或 nhentai 官网链接直接下载作品。
* **别名:** \`nh下载\`, \`nh download\`
* **选项:** 留空则使用默认配置
  * \`-p, --pdf\`: 输出为 PDF 文件。
  * \`-z, --zip\`: 输出为 ZIP 压缩包。
  * \`-i, --image\`: 输出为逐张图片。
  * \`-k, --key <密码>\`: 为 PDF 或 ZIP 文件设置密码。
* **示例:**
  - \`nh下载 202327 -z -k 1234\` 下载 ID 为 202327 的漫画，发送加密 ZIP 文件，密码为 1234。
  - \`nh download https://nhentai.net/g/202327/ --pdf\` 下载链接对应的漫画，发送 PDF 文件。

---

### \`nh.popular\`
查看当前的热门漫画列表，功能等同于 \`nh.search "" -s popular\`
* **别名:** \`nh热门\`, \`nh popular\`

### \`nh.random\`
随机推荐一本漫画。
* **别名:** \`nh随机\`, \`nh random\`, \`天降好运\`

---

**链接识别:** 在聊天中直接发送 nhentai 画廊链接，插件会自动响应并提示下载。此功能可在配置中关闭。

## ⚠️ 注意事项
* 本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。
* 本插件仅供学习与交流使用，请勿用于商业用途。请尊重原作者的版权，合理使用下载的内容。
* 插件需要能够访问 nhentai.net，如果服务器网络受限，请确保已配置代理。
* 使用 \`help <指令名>\` (例如 \`help nh搜索\`) 可以获取详细的指令用法和选项说明。
`

export function apply(ctx: Context, config: Config) {
  const plugin = new NhentaiPlugin(ctx, config)

  ctx.on('ready', async () => {
    try {
      await initWasmProcessor()
      logger.info('图片处理已启用')

      // Initialize plugin after WASM is ready
      await plugin.initialize()
      logger.info('插件初始化完成')

      // 注册所有指令（在插件初始化完成后）
      registerAllCommands(ctx, config, plugin.getApiService(), plugin.getNhentaiService(), (session) =>
        plugin.ensureInitialized(session)
      )
    } catch (error) {
      logger.error('初始化失败:', error)
      logger.error('插件无法启动。请确保已正确安装。')
      throw error
    }
  })

  // 注册中间件
  ctx.middleware(createLinkRecognitionMiddleware(config), true)
}
