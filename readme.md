# koishi-plugin-nhentai-downloader

[![npm](https://img.shields.io/npm/v/koishi-plugin-nhentai-downloader?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-nhentai-downloader)

一个 [nhentai.net](https://nhentai.net/) 漫画插件，提供搜索、下载、查看热门或随机漫画功能。

**注意：本插件内容涉及成人向（NSFW）漫画，请确保在合适的范围内使用。**

## 功能特性

- 搜索功能 - 支持关键词搜索、ID 查询，可按热门度排序，可按语言筛选（支持中文、日语、英语）
- 图片菜单 - 搜索结果以图片网格形式展示，直观查看封面
- 交互操作 - 搜索结果支持多页浏览和翻页，回复序号发起下载任务
- 多格式输出 - 支持 PDF、ZIP 压缩包、逐张图片三种输出方式
- 文件加密 - 支持为 PDF 和 ZIP 文件设置密码保护
- 链接识别 - 可自动识别并处理消息中的 nhentai 链接

## 安装

从 Koishi 插件市场搜索 `nhentai-downloader` 安装。

## 依赖项说明

本插件需要能够访问 [nhentai](https://nhentai.net/) 的网络环境，如果您的服务器网络受限，请务必配置代理。

## 指令说明

统一前缀：`nh`（推荐用法：`nh.指令`；也支持 `nh指令` / `nh command`）

### 搜索：`nh.search`（别名：`nh搜索`、`nh search`）

语法：`nh.search <关键词/ID> [选项]`

选项：
- `-s, --sort <type>`：`popular` / `popular-today` / `popular-week`
- `-l, --lang <lang>`：`chinese` / `japanese` / `english` / `all`

示例：
```shell
nh.search touhou
nh.search 608023
nh.search touhou -s popular-week -l chinese
```

### 下载：`nh.download`（别名：`nh下载`、`nh download`）

语法：`nh.download <ID/链接> [选项]`

选项：
- `-p, --pdf`：输出 PDF
- `-z, --zip`：输出 ZIP
- `-i, --image`：逐张发送图片
- `-k, --key <密码>`：为 PDF 或 ZIP 设置密码

示例：
```shell
nh.download 608023 -z
nh.download https://nhentai.net/g/608023/ -p -k password
```

### 热门：`nh.popular`（别名：`nh热门`、`nh popular`）

说明：等价于 `nh.search "" -s popular`

### 随机：`nh.random`（别名：`nh随机`、`nh random`、`天降好运`）

---

## 配置项

### 基础设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `proxy` | `string` | - | 插件访问 nhentai 时使用的网络代理 |
| `defaultOutput` | `string` | `pdf` | 下载画廊时的默认文件输出格式，可选值: `pdf`, `zip`, `img` |
| `defaultSearchLanguage` | `string` | `all` | 搜索画廊时的默认语言，可选值: `all`, `chinese`, `japanese`, `english` |
| `enableLinkRecognition` | `boolean` | `false` | 自动识别消息中的 nhentai 链接并发送画廊信息 |
| `defaultPassword` | `string` | - | 为 PDF 和 ZIP 文件设置默认密码 (留空则不加密) |

---

### 搜索设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `searchMode` | `string` | `menu` | 搜索结果的显示模式，可选值: `text` (文本模式), `menu` (图片菜单模式) |
| `textMode.searchResultLimit` | `number` | `10` | 文本模式每页显示的最大数量 (1-25) |
| `textMode.showTags` | `boolean` | `true` | 文本模式显示画廊标签 |
| `textMode.showLink` | `boolean` | `true` | 文本模式显示 nhentai 链接 |
| `textMode.showThumbnails` | `boolean` | `true` | 文本模式显示缩略图 |
| `textMode.useForward` | `boolean` | `true` | 文本模式使用合并转发发送搜索结果 |
| `menuMode.columns` | `number` | `3` | 图片菜单每行显示的画廊数量 (1-5) |
| `menuMode.maxRows` | `number` | `3` | 图片菜单最大行数 (1-5) |

---

### 消息设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `useForwardForDownload` | `boolean` | `true` | 以图片形式发送画廊时使用合并转发 |
| `imageSendDelay` | `number` | `1` | 以图片形式发送时每张图片的发送间隔 (秒) |
| `promptTimeout` | `number` | `60` | 交互式操作的超时时间 (秒) |

---

### 文件设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `downloadPath` | `string` | `./data/temp/nhentai-downloader` | 临时文件和缓存的存储路径（相对于 Koishi 根目录） |
| `fileSendMethod` | `string` | `buffer` | 发送 PDF 和 ZIP 文件的方式，可选值: `buffer` (内存), `file` (文件路径) |
| `prependIdToFile` | `boolean` | `true` | 在文件名前添加画廊 ID |

---

### PDF 设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `pdfEnableCompression` | `boolean` | `true` | 启用图片压缩以减小 PDF 文件体积 |
| `pdfCompressionQuality` | `number` | `90` | JPEG 图片的压缩质量 (1-100) |
| `pdfJpegRecompressionSize` | `number` | `500` | 小于此体积 (KB) 的 JPEG 原图将不被压缩，设为 0 则全部压缩 |

---

### ZIP 设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `zipCompressionLevel` | `number` | `1` | ZIP 文件的压缩级别 (0 不压缩, 9 最高) |

---

### 图片设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `antiGzip.enabled` | `boolean` | `true` | 对输出图片进行抗风控处理，规避图片审查 |

---

### 下载设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `downloadConcurrency` | `number` | `10` | 下载图片时的最大并发数 (1-25) |
| `downloadTimeout` | `number` | `30` | 单张图片下载的超时时间 (秒) |
| `downloadRetries` | `number` | `3` | 图片下载失败后的重试次数 (0-5) |
| `downloadRetryDelay` | `number` | `2` | 每次重试前的等待时间 (秒) |
| `enableSmartRetry` | `boolean` | `true` | 启用重试自动切换备用图片服务器域名 |

---

### 缓存管理

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `cache.enableApiCache` | `boolean` | `true` | 启用 API 响应缓存 (内存) |
| `cache.apiCacheTTL` | `number` | `10` | API 缓存的有效时间 (分钟) |
| `cache.enableImageCache` | `boolean` | `true` | 启用图片文件缓存 (磁盘) |
| `cache.imageCacheTTL` | `number` | `24` | 图片缓存的有效时间 (小时，0 表示永久保存) |
| `cache.imageCacheMaxSize` | `number` | `1024` | 图片缓存的最大体积 (MB) |
| `cache.enablePdfCache` | `boolean` | `false` | 启用 PDF 文件缓存 (磁盘) |
| `cache.pdfCacheTTL` | `number` | `72` | PDF 缓存的有效时间 (小时，0 表示永久保存) |
| `cache.pdfCacheMaxSize` | `number` | `2048` | PDF 缓存的最大体积 (MB) |

---

### 调试设置

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `debug` | `boolean` | `false` | 在控制台输出详细的调试日志 |
| `returnApiJson` | `boolean` | `false` | 在控制台输出 API 的原始响应 |

---

## 注意事项

- 网络要求: 需要能够访问 `nhentai.net` 及其图片源站，网络受限时请配置代理
- 版权声明: 本插件仅供学习交流使用，请勿用于商业用途，请尊重原作者版权

## 许可证

[MIT](./LICENSE) License © 2024
