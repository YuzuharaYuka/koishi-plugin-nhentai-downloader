# koishi-plugin-nhentai-downloader

[Koishi](https://koishi.chat/) 的 [nhentai](https://nhentai.net/) 漫画搜索与下载插件。
作品数据来自 nhentai API v2，图片取自其 CDN。

**内容涉及成人向漫画，请在合适的范围内使用。**

```bash
npm i koishi-plugin-nhentai-downloader
```

需要能访问 `nhentai.net` 及其 CDN，网络受限时请配置 `proxy-agent` 插件。

## 指令

主指令 `nh`（别名 `nhentai`），`nh.指令` / `nh指令` / `nh command` 均可。

| 指令 | 别名 | 说明 |
| :--- | :--- | :--- |
| `nh.search <关键词/ID>` | `nh搜索` | 关键词搜索或按作品 ID 查询，`-s` 排序、`-l` 筛选语言 |
| `nh.download <ID/链接>` | `nh下载` | 下载作品，`-p` PDF、`-z` ZIP、`-i` 逐张图片、`-k` 密码 |
| `nh.popular` | `nh热门` | 今日热门，等价于 `nh.search -s popular-today` |
| `nh.random` | `nh随机` | 随机推荐，`Y` 下载、`F` 换一个、`N` 退出 |

`nh.search` 的 `-s` 取 `date` / `popular` / `popular-today` / `popular-week` / `popular-month`，
可简写 `today` / `week` / `month`；`-l` 取 `chinese` / `japanese` / `english` / `all`。

关键词支持官方过滤语法：`artist:name`、`language:chinese`、`tag:"big breasts"`、
`pages:>50`、`favorites:>=1000`、`uploaded:<7d`，也可用 `-` 取反（`-tag:netorare`）。

搜索结果回复序号即可下载，`F` 下一页、`B` 上一页、`N` 退出。
消息中的 nhentai 链接可在配置里开启自动识别后直接触发下载。

## 说明

- **输出**：PDF 会把内页转成 JPEG（PDF 无法嵌入 webp，这一步不可避免），默认质量 85；
  ZIP 原样存入图片（图片本身已是压缩格式，再压意义不大）；逐张发送时按平台能力决定是否合并转发。
  PDF 与 ZIP 都支持密码。菜单以 JPEG 发送。
- **取图**：配置了 `apiKey` 时默认优先走官方打包直链（服务端打好包，插件下载后解压再处理），
  签发受限或下载失败会自动改用 CDN 逐页下载，不会因此下载不了。
- **抗风控**：`antiGzip` 给逐张发送的图片和搜索缩略图加上低透明度水印，PDF / ZIP 内的图片不受影响。
- **缓存**：接口响应缓存在内存，图片与 PDF 缓存在 `downloadPath`；同一作品重复下载会直接命中缓存。
- **配额**：官方按接口限制请求频率，匿名配额较低。填入 `apiKey` 可提高配额，并让接口返回黑名单过滤结果。

## 配置

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `apiKey` | 空 | nhentai 官方 API Key，提高接口配额并启用黑名单过滤 |
| `defaultOutput` | `pdf` | 未指定格式时的输出，`pdf` / `zip` / `img` |
| `defaultSearchLanguage` | `all` | 搜索默认语言筛选 |
| `defaultPassword` | 空 | PDF / ZIP 的默认密码 |
| `enableLinkRecognition` | `false` | 识别消息中的 nhentai 链接并自动下载 |
| `searchMode` | `menu` | 结果展示方式，`menu` 图片菜单 / `text` 文本列表 |
| `menuMode.columns` `maxRows` | `3` `3` | 图片菜单的列数与行数 |
| `textMode.*` | 见配置页 | 文本列表的条数、标签、链接、缩略图与合并转发 |
| `downloadSource` | `auto` | `auto` / `official` 优先官方直链，`cdn` 只逐页下载 |
| `downloadConcurrency` | `10` | 逐页下载并发数，官方 CDN 会对异常高速请求临时封禁 |
| `downloadRetries` `downloadRetryDelay` | `3` `2` | 单张图片的尝试次数与重试间隔 |
| `imageCompression.enabled` | `true` | 对已是 JPEG 的内页也按质量重新编码；`quality` `threshold` `maxEdge` 见配置页 |
| `antiGzip.enabled` | `true` | 给逐张发送的图片与缩略图加水印 |
| `cache.enableImageCache` 等 | 见配置页 | 接口 / 图片 / PDF 缓存的开关、有效期与体积上限 |
| `debug` `returnApiJson` | `false` | 输出调试日志与接口原始响应 |

## 常见问题

**下载很慢或中途失败？**
先确认能直连 nhentai 及其 CDN，再看 `downloadConcurrency` 是否过高——官方 CDN 会临时封禁异常高速的请求。

**为什么有时走官方直链、有时走 CDN？**
官方打包接口的签发配额很紧，额度用尽时会自动改用 CDN。两种方式的最终输出没有区别。

**图片为什么带水印？**
`antiGzip` 的默认行为，用于降低被平台按图库指纹拦截的概率，不需要可以关掉。

**搜索结果里少了某些作品？**
接口会按当前账号的黑名单过滤，被标记为 `blacklisted` 的列表项不会展示。

## 相关文档

- nhentai API v2：<https://nhentai.net/api/v2/docs>
- 本项目的接口整理（端点 / 鉴权 / 限流 / 数据结构 / 对接说明）：[docs/nhentai-api-v2.md](./docs/nhentai-api-v2.md)

## License

[MIT](./LICENSE)
