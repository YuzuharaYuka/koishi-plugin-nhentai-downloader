# koishi-plugin-nhentai-downloader

[Koishi](https://koishi.chat/) 的 [nhentai](https://nhentai.net/) 漫画搜索与下载插件，支持搜索作品、按 ID 下载，输出 PDF / ZIP / 逐张图片。

**内容涉及成人向漫画，请在合适的范围内使用。**

```bash
npm i koishi-plugin-nhentai-downloader
```

需要 Koishi 4.18 及以上，且能访问 `nhentai.net` 与其 CDN；网络受限时请配置 [proxy-agent](https://koishi.chat/plugins/accessibility/proxy-agent.html)。

## 指令

主指令 `nh`（别名 `nhentai`），`nh.指令`、`nh指令`、`nh command` 三种写法都可以。

| 指令 | 说明 |
| :--- | :--- |
| `nh.search <关键词/ID>` | 搜索作品，支持排序与语言筛选 |
| `nh.download <ID/链接>` | 下载作品，可输出 PDF / ZIP / 逐张图片 |
| `nh.popular` | 今日热门 |
| `nh.random` | 随机推荐 |

- `nh.search`：`-s` 排序取 `date` / `popular` / `popular-today` / `popular-week` / `popular-month`，可简写 `today` / `week` / `month`；`-l` 语言取 `chinese` / `japanese` / `english` / `all`。
- `nh.download`：`-p` PDF、`-z` ZIP、`-i` 逐张图片、`-k <密码>` 加密；不指定格式时使用配置里的 `defaultOutput`。
- 关键词支持官方过滤语法：`artist:name`、`language:chinese`、`pages:>50`、`favorites:>=1000`、`uploaded:<7d`，用 `-` 取反（`-tag:netorare`）。
- 搜索结果回复序号即可下载，`F` 下一页、`B` 上一页、`N` 退出；`nh.random` 用 `Y` / `F` / `N` 交互。

## 说明

- **输出**：PDF 会把内页转成 JPEG（PDF 无法嵌入 webp），ZIP 原样存入图片，逐张发送按平台能力决定是否合并转发；PDF 与 ZIP 都支持密码。
- **取图**：配置 `apiKey` 后默认优先走官方打包直链，签发受限或下载失败会自动改用 CDN 逐页下载，不会因此下载不了。
- **抗风控**：`antiGzip` 给逐张发送的图片与搜索缩略图加上低透明度水印，PDF / ZIP 内的图片不受影响。
- **缓存**：接口响应缓存在内存，图片与 PDF 缓存在 `downloadPath`，同一作品重复下载直接命中缓存。
- **配额**：接口按官方配额限流，匿名配额较低；填入 `apiKey` 可提高配额并启用黑名单过滤。
- **并发**：官方 CDN 会临时封禁异常高速的请求，`downloadConcurrency` 默认 10，下载失败较多时可调低。

## 配置

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `apiKey` | 空 | 提高接口配额并启用黑名单过滤 |
| `defaultOutput` | `pdf` | 未指定格式时的输出：`pdf` / `zip` / `img` |
| `defaultPassword` | 空 | PDF / ZIP 的默认密码 |
| `downloadSource` | `auto` | `auto` / `official` 优先官方直链，`cdn` 只逐页下载 |
| `downloadConcurrency` | `10` | 逐页下载并发数 |
| `downloadRetries` | `3` | 单张图片的尝试次数（含首次） |
| `searchMode` | `menu` | 结果展示方式：`menu` 图片菜单 / `text` 文本列表 |
| `imageCompression.enabled` | `true` | 重新编码 PDF 内页，`quality` / `maxEdge` 见配置页 |
| `antiGzip.enabled` | `true` | 给逐张发送的图片与缩略图加水印 |
| `enableLinkRecognition` | `false` | 识别消息中的 nhentai 链接并自动下载 |
| `cache.*`、`textMode.*`、`debug` | 见配置页 | 缓存开关与有效期、文本列表样式、调试日志 |

## 相关文档

- nhentai API v2 文档：https://nhentai.net/api/v2/docs
- 本项目的接口整理（端点 / 鉴权 / 限流 / 数据结构）：https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader/blob/master/docs/nhentai-api-v2.md

## License

[MIT](https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader/blob/master/LICENSE)
