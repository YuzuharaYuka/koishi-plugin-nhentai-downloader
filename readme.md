# koishi-plugin-nhentai-downloader

[![npm](https://img.shields.io/npm/v/koishi-plugin-nhentai-downloader?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-nhentai-downloader)

适用于 [Koishi](https://koishi.chat/) 的 nhentai 漫画搜索与下载插件。

## 功能

- 支持通过关键词或漫画 ID 进行搜索。
- 支持浏览热门漫画和随机推荐漫画。
- 搜索结果支持分页，并可通过回复序号进行交互式下载。
- 支持通过漫画 ID 或 nhentai 官网链接下载。
- 可将漫画打包为 `PDF` 文件、`ZIP` 压缩包，或以 `逐张图片` 的形式发送。
- 支持为 `PDF` 和 `ZIP` 文件设置密码。
- 可自动识别聊天中的 nhentai 链接并触发下载。

## 安装

前往 Koishi 插件市场搜索 `nhentai-downloader` 并安装。

## 使用方法

### 指令列表

#### `nh search <关键词/ID>`

- **别名:** `nh 搜索`, `nh搜索`, `search`
- **功能:** 根据关键词或漫画 ID 搜索。
  - **关键词:** 返回分页的搜索结果。可通过回复 `F` 翻页，回复序号下载，或回复 `N` 退出交互。
  - **漫画 ID:** 获取该漫画的详细信息，并提示是否下载。
- **示例:**
  - `nh search touhou`
  - `nh search 177013`

#### `nh download <ID/链接>`

- **别名:** `nh 下载`, `nh下载`, `download`
- **功能:** 根据漫画 ID 或 nhentai 官网链接下载漫画。
- **选项:**
  - `-p`, `--pdf`: 输出为 PDF 文件。
  - `-z`, `--zip`: 输出为 ZIP 压缩包。
  - `-i`, `--image`: 输出为逐张图片。
  - `-k <密码>`, `--key <密码>`: 为 PDF 或 ZIP 文件设置密码。
- **示例:**
  - `nh download 123456 -z`
  - `nh download https://nhentai.net/g/123456/ -p -k mypassword`

#### `nh popular`

- **别名:** `nh 热门`, `nh热门`, `popular`
- **功能:** 获取 nhentai 当前的热门漫画列表，结果以分页形式展示，并支持交互式下载。
- **示例:**
  - `nh popular`

#### `nh random`

- **别名:** `nh 随机`, `nh随机`, `random`, `天降好运`
- **功能:** 随机获取一本漫画的详细信息，并提示是否下载。
- **示例:**
  - `nh random`

### 链接识别

在配置中启用该功能后，直接发送 nhentai 链接即可自动触发下载。

## 配置项

插件提供多种配置项，可在 Koishi 控制台内调整，主要包括：

- **通用设置:** 搜索结果数量、链接识别、交互超时等。
- **消息与外观:** 搜索结果的发送形式、是否显示标签和链接等。
- **下载与输出:** 默认下载格式、默认密码、文件存储路径、PDF/ZIP 压缩选项等。
- **网络与性能:** 图片下载的并发数、超时时间、重试次数等。
- **浏览器设置:** 浏览器路径、是否启用常驻浏览器实例等。
- **缓存设置:** 是否启用 API 缓存、缓存有效期等。
- **调试设置:** 是否在控制台输出详细日志。

## 许可证

MIT License
