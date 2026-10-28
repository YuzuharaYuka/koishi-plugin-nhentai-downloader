# koishi-plugin-nhentai-downloader

[Koishi](https://koishi.chat/) 的 [nhentai](https://nhentai.net/) 搜索与下载插件，输出 PDF / ZIP / 逐张图片。

内容涉及成人向漫画，请在合适的范围内使用。

```bash
npm i koishi-plugin-nhentai-downloader
```

需要 Koishi 4.18 及以上，并能访问 `nhentai.net` 与其 CDN；网络受限时配置 [proxy-agent](https://koishi.chat/plugins/accessibility/proxy-agent.html)。

## 指令

主指令 `nh`（别名 `nhentai`），`nh.指令`、`nh指令`、`nh command` 三种写法都可以。

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| `nh.search <关键词/ID>` | `nh搜索` | 搜索作品 |
| `nh.download <ID/链接>` | `nh下载` | 下载作品 |
| `nh.popular` | `nh热门` | 今日热门 |
| `nh.random` | `nh随机` | 随机推荐 |
| `nh.cancel` | `nh取消` | 取消进行中的下载 |
| `nh.retry` | `nh重试` | 补下上次失败的页 |

- `nh.search`：`-s` 排序取 `date` / `popular` / `popular-today` / `popular-week` / `popular-month`（可简写 `today` / `week` / `month`），`-l` 取 `chinese` / `japanese` / `english` / `all`。
- `nh.download`：`-p` PDF、`-z` ZIP、`-i` 逐张图片、`-k <密码>` 加密、`--no-password` 跳过默认密码；不指定时用 `defaultOutput`。
- 关键词支持官方过滤语法，如 `artist:name`、`language:chinese`、`pages:>50`、`favorites:>=1000`，`-tag:netorare` 表示排除。
- 搜索结果回复序号下载，`F` 下一页、`B` 上一页、`N` 退出；`nh.random` 用 `Y` / `F` / `N`。

## 配置

配置页右侧有分组导航，可直接跳到对应分组。

| 分组 | 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| 基础 | `defaultOutput` | `pdf` | 未指定格式时的输出：`pdf` / `zip` / `img` |
| 基础 | `apiKey` | 空 | 官方直链需要，留空只用 CDN |
| 基础 | `defaultPassword` | 空 | PDF / ZIP 的默认密码 |
| 搜索 | `searchMode` | `menu` | `menu` 图片菜单 / `text` 文本列表 |
| 下载 | `downloadSource` | `auto` | `auto` / `official` 优先官方直链，`cdn` 只逐页下载 |
| 下载 | `downloadConcurrency` | `10` | 逐页下载并发数 |
| 图片 | `imageCompression.enabled` | `true` | 重新编码 PDF 内页 |
| 图片 | `antiGzip.enabled` | `true` | 给逐张图片与缩略图加水印 |
| 发送 | `fileSendMethod` | `file` | `file` 传本地路径，`buffer` 传文件内容 |
| 存储 | `downloadPath` | `./data/temp/nhentai-downloader` | 临时文件与缓存目录 |
| 存储 | `cache.*` | 见配置页 | 图片 / PDF / 接口缓存 |
| 调试 | `debug` | `false` | 输出调试日志 |

`apiKey` 在 [账号设置](https://nhentai.net/user/settings#apikeys) 生成。填了才能用官方直链取图，接口配额也更高。

`fileSendMethod` 为 `file` 时，适配器要能读到 Koishi 的文件路径；适配器在 Docker 或另一台机器上时改为 `buffer`。`buffer` 走文件内容传输，占用更多内存，且协议端的 WebSocket 有单帧上限（NapCat约64MiB、SnowLuma 约100MiB），文件过大时会导致断连。

## 说明

- PDF 会把内页转成 JPEG（PDF 不支持 webp），ZIP 原样存入；两者都支持密码。
- 官方直链签发受限或下载失败时会自动改用 CDN 逐页下载。
- 接口响应缓存在内存，图片与 PDF 缓存在 `downloadPath`，重复下载直接命中。
- CDN 会临时封禁异常高速的请求，失败较多时调低 `downloadConcurrency`。

## 相关文档

- nhentai API v2 文档：https://nhentai.net/api/v2/docs
- 接口整理（端点 / 鉴权 / 限流 / 数据结构）：https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader/blob/master/docs/nhentai-api-v2.md

## License

[MIT](https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader/blob/master/LICENSE)
