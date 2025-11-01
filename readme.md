# koishi-plugin-nhentai-downloader

[![npm](https://img.shields.io/npm/v/koishi-plugin-nhentai-downloader?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-nhentai-downloader)

一个 [nhentai.net](https://nhentai.net/) 漫画插件，提供搜索、下载、查看热门或随机漫画功能。

**注意：本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。**

## 功能特性

- **高级搜索**：支持关键词搜索、ID 查询，可按热门度（总热门、今日、本周）排序，并可按语言（中文/日文/英文）筛选。
- **交互草错**：搜索结果支持多页浏览，可通过 `F` (下一页)、`B` (上一页) 翻页，回复序号即可快速发起下载任务。
- **多格式下载**：可将漫画打包为 `PDF` 文件、`ZIP` 压缩包，或以 `逐张图片` 的形式发送，满足不同阅读和存储需求。
- **文件加密**：支持为 `PDF` 和 `ZIP` 文件设置密码，保护隐私。
- **链接识别**：可配置为自动识别聊天中出现的 nhentai 画廊链接，并直接响应下载。

## 安装

从 Koishi 插件市场搜索 `nhentai-downloader` 安装。

## 依赖项说明

本插件需要能够访问[nhentai](https://nhentai.net/)的网络环境，如果您的服务器网络受限，请务必配置代理。

## 指令说明

### `nh.search <关键词/ID> [选项]`

根据关键词或漫画 ID 进行搜索。

- **别名**: `nh搜索`, `nh search`
- **选项**:
  - `-s, --sort <type>`: 按热门度排序。可选值: `popular`, `popular-today`, `popular-week`。
  - `-l, --lang <lang>`: 筛选特定语言。可选值: `chinese`, `japanese`, `english`, `all`。

```shell
# 关键词搜索
nh.search touhou

# 使用选项进行搜索
nh.search touhou -s popular-week -l chinese

# ID 查询
nh.search 177013
```

---

### `nh.download <ID/链接> [选项]`

根据漫画 ID 或 nhentai 官网链接直接下载作品。

- **别名**: `nh下载`, `nh download`
- **选项**:
  - `-p, --pdf`: 输出为 PDF 文件。
  - `-z, --zip`: 输出为 ZIP 压缩包。
  - `-i, --image`: 输出为逐张图片。
  - `-k, --key <密码>`: 为 PDF 或 ZIP 文件设置密码。

```shell
# 下载并打包为 ZIP
nh.download 123456 -z

# 下载链接对应的漫画，输出为加密 PDF
nh.download https://nhentai.net/g/123456/ -p -k mypassword
```

---

### `nh.popular`

获取 nhentai 当前的热门漫画列表。

- **别名**: `nh热门`, `nh popular`
- **说明**: 此指令为 `nh.search "" -s popular` 的快捷方式。

---

### `nh.random`

随机获取一本漫画的详细信息，并提示是否下载。

- **别名**: `nh随机`, `nh random`, `天降好运`

---

## 配置项

### 基础设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `proxy` | `string` | - | 插件进行所有网络请求时使用的代理。格式: `http://127.0.0.1:7890`。 |
| `defaultOutput` | `string` | `pdf` | 下载时的默认输出格式。可选值: `pdf`, `zip`, `img`。 |
| `defaultSearchLanguage` | `string` | `all` | 搜索时的默认语言筛选。可选值: `all`, `chinese`, `japanese`, `english`。 |
| `enableLinkRecognition`| `boolean`| `true` | 自动识别并处理消息中的 nhentai 链接。 |
| `defaultPassword` | `string` | - | 为 PDF 或 ZIP 文件设置默认密码 (留空则不加密)。 |

---

### 消息与交互

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `useForwardForSearch` | `boolean` | `true` | 以合并转发形式发送搜索结果。 |
| `useForwardForDownload` | `boolean` | `true` | 以图片形式发送漫画时，使用合并转发。 |
| `showTagsInSearch` | `boolean` | `true` | 在搜索结果中显示作品的标签。 |
| `showLinkInSearch` | `boolean` | `true` | 在搜索结果中附加 nhentai 链接。 |
| `searchResultLimit` | `number` | `10` | 搜索结果每页显示的数量 (1-25)。 |
| `promptTimeout` | `number` | `60000` | 交互式操作（如翻页、下载确认）的等待超时时间 (毫秒)。 |
| `imageSendDelay` | `number` | `1000` | 以图片形式发送时，每张图片的发送间隔 (毫秒)。 |

---

### 文件与输出

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `downloadPath` | `string` | `./data/temp/nhentai-downloader` | 临时文件的本地存储路径。 |
| `prependIdToFile`| `boolean`| `true` | 在文件名前添加漫画 ID。 |
| `pdfSendMethod` | `string` | `buffer` | 发送 PDF 的方式: `buffer` (内存) 或 `file` (文件路径)。 |
| `pdfEnableCompression` | `boolean` | `true` | 启用图片压缩以减小 PDF 文件体积。 |
| `pdfCompressionQuality` | `number` | `85` | JPEG 压缩质量 (1-100)。 |
| `pdfJpegRecompressionSize` | `number` | `500` | 体积小于此值 (KB) 的 JPEG 原图将跳过压缩。设为 0 则始终压缩。 |
| `zipCompressionLevel` | `number` | `1` | ZIP 文件的压缩等级 (0为不压缩, 9为最高)。 |
| `antiGzip.enabled` | `boolean` | `true` | 对输出图片进行抗审查处理，可在一定程度上规避平台风控。 |

---

### 网络与性能

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `downloadConcurrency` | `number` | `10` | 下载图片时的最大并发请求数 (1-25)。 |
| `downloadTimeout` | `number` | `15` | 单张图片下载的超时时间 (秒)。 |
| `downloadRetries` | `number` | `3` | 下载失败后的重试次数 (0-5)。 |
| `downloadRetryDelay` | `number` | `1` | 每次重试前的等待时间 (秒)。 |
| `cache.enableApiCache`| `boolean`| `true` | 启用 API 响应缓存，加快重复请求的响应。 |
| `cache.apiCacheTTL` | `number` | `10` | API 缓存的有效时间 (分钟)。 |

---

### 调试设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `debug` | `boolean` | `false` | 在控制台输出详细的执行日志。 |
| `returnApiJson` | `boolean` | `false` | 在控制台输出完整的 API 原始响应。 |

## ⚠️ 注意事项

- **网络要求**：插件的所有功能都依赖于对 `nhentai.net` 及其图片源站的访问。如果您的服务器位于网络限制区域，请务必在**配置项**中设置代理。
- **版权与使用**：本插件仅供学习与技术交流使用，请勿用于任何商业用途。所有内容的版权归原作者所有，请在法律允许的范围内合理使用下载的内容。

## 许可证

[MIT](./LICENSE) License © 2024
