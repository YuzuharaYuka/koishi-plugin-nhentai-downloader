# koishi-plugin-nhentai-downloader

[![npm](https://img.shields.io/npm/v/koishi-plugin-nhentai-downloader?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-nhentai-downloader)

适用于 [Koishi](https://koishi.chat/) 的 [nhentai](https://nhentai.net/) 漫画搜索与下载插件。

**注意：本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。**

## ✨ 功能特性

- **强大搜索**: 支持关键词搜索、ID 精准查询，并可按热门度（总热门、今日、本周）排序、按语言（中/日/英）筛选。
- **智能交互**: 搜索结果支持多页浏览，可通过 `F` (下一页)、`B` (上一页) 轻松翻页，回复序号即可下载。
- **多种格式**: 可将漫画打包为 `PDF` 文件、`ZIP` 压缩包，或以 `逐张图片` 的形式发送，满足不同场景需求。
- **自动识别**: 可自动识别聊天中出现的 nhentai 链接并触发下载，方便快捷。
- **文件加密**: 支持为 `PDF` 和 `ZIP` 文件设置密码。

## 🚀 安装

前往 Koishi 插件市场搜索 `nhentai-downloader` 并安装。

## 📖 指令说明

### `nh.search <关键词/ID> [选项]`

根据关键词或漫画 ID 进行搜索。这是插件的核心指令。

- **别名**: `nh搜索`, `search`

#### **1. 关键词搜索**

- **说明**: 根据关键词返回分页的搜索结果。
- **选项**:
  - `-s, --sort <type>`: 按热门度排序。可选值: `popular`, `popular-today`, `popular-week`。
  - `-l, --lang <lang>`: 筛选特定语言。可选值: `chinese`, `japanese`, `english`, `all`。
- **示例**:
  - `nh.search touhou`
  - `nh.search touhou -s popular-week -l chinese` (搜索本周热门的 "touhou" 中文作品)

#### **2. ID 查询**

- **说明**: 根据漫画 ID 获取该作品的详细信息，并提示是否下载。
- **示例**: `nh.search 177013`

---

### `nh.download <ID/链接> [选项]`

根据漫画 ID 或 nhentai 官网链接直接下载作品。

- **别名**: `nh下载`, `download`
- **选项**:
  - `-p, --pdf`: 输出为 PDF 文件。
  - `-z, --zip`: 输出为 ZIP 压缩包。
  - `-i, --image`: 输出为逐张图片。
  - `-k, --key <密码>`: 为 PDF 或 ZIP 文件设置密码。
- **示例**:
  - `nh.download 123456 -z`
  - `nh.download https://nhentai.net/g/123456/ -p -k mypassword`

---

### `nh.popular`

获取 nhentai 当前的热门漫画列表。

- **别名**: `nh热门`, `popular`
- **说明**: 此指令为 `nh.search "" -s popular` 的快捷方式。

---

### `nh.random`

随机获取一本漫画的详细信息，并提示是否下载。

- **别名**: `nh随机`, `random`, `天降好运`

---

## ⚙️ 配置项

插件提供多种配置项，可在 Koishi 控制台内调整。

### 通用设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enableLinkRecognition` | `boolean` | `true` | 启用后，将自动识别消息中的 nhentai 链接并触发下载。 |
| `searchResultLimit` | `number` | `10` | 搜索指令单页显示的最大结果数量。 |
| `promptTimeout` | `number` | `60000` | 交互式操作（如翻页、下载确认）的等待超时时间（毫秒）。 |
| `defaultSearchLanguage` | `string` | `all` | 搜索指令未指定语言时的默认筛选。 |

### 消息设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `useForwardForSearch` | `boolean` | `true` | 以合并转发形式发送搜索结果。 |
| `useForwardForDownload` | `boolean` | `true` | 以图片(image)形式发送漫画时使用合并转发。 |
| `showTagsInSearch` | `boolean` | `true` | 在搜索结果中显示作品更详细的信息（原作、角色、标签等）。 |
| `showLinkInSearch` | `boolean` | `true` | 在搜索结果中附带 nhentai 链接。 |

### 下载设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `downloadPath` | `string` | `./data/downloads/nhentai` | 漫画文件及临时文件的本地存储路径。 |
| `defaultOutput` | `string` | `pdf` | 下载指令未指定输出格式时的默认选项 (`pdf`/`zip`/`img`)。 |
| `defaultPassword` | `string` | (空) | 为生成的 PDF 或 ZIP 文件设置的默认密码。 |
| `pdfSendMethod` | `string` | `buffer` | 发送文件的方式。若无法共享文件系统，请选择“内存模式”。 |
| `imageSendDelay` | `number` | `1500` | 以图片形式发送时，每张图片间的发送延迟（毫秒）。 |
| `antiGzip.enabled` | `boolean` | `true` | 【实验性】启用图片抗风控处理。 |

### 压缩设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `pdfEnableCompression` | `boolean` | `true` | 启用图片压缩以减小 PDF 文件的体积。 |
| `pdfCompressionQuality`| `number` | `85` | JPEG 压缩质量 (1-100)。 |
| `zipCompressionLevel` | `number` | `9` | ZIP 文件的压缩等级 (0-9)。 |

### 网络设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `downloadConcurrency` | `number` | `5` | 下载图片时的最大并发数。 |
| `downloadTimeout` | `number` | `15000` | 单张图片下载的超时时间（毫秒）。 |
| `downloadRetries` | `number` | `3` | 单张图片下载失败后的最大重试次数。 |
| `downloadRetryDelay` | `number` | `2000` | 每次重试前的等待时间（毫秒）。 |
| `userAgent` | `string` | (浏览器 UA) | 插件进行网络请求时使用的 User-Agent 标识。 |

### 高级设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `puppeteer.chromeExecutablePath` | `string` | (空) | 指定浏览器可执行文件路径。留空则自动检测。 |
| `puppeteer.persistentBrowser` | `boolean` | `false` | 插件启动时预加载并常驻浏览器实例，可加快响应。 |
| `puppeteer.browserCloseTimeout` | `number` | `30` | 【仅非常驻模式】任务结束后延迟关闭浏览器的时间（秒）。 |
| `cache.enableApiCache` | `boolean` | `true` | 启用 API 缓存以加快重复请求的响应速度。 |
| `cache.apiCacheTTL` | `number` | `600000` | API 缓存的有效时间（毫秒）。 |

### 调试设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `debug` | `boolean` | `false` | 在控制台输出详细的调试日志。 |
| `returnApiJson` | `boolean` | `false` | 【仅调试模式】在控制台以 JSON 格式输出完整的 API 响应。 |

## ⚠️ 注意事项

- **网络要求**：插件的所有功能都依赖于对 `nhentai.net` 及其图片源站的访问。如果您的服务器位于网络限制区域，请确保已配置**代理**或通过其他方式解决网络问题。
- **版权与使用**：本插件仅供学习与技术交流使用，请勿用于任何商业用途。所有内容的版权归原作者所有，请在法律允许的范围内合理使用下载的内容。

## 许可证

MIT License
