# nhentai API v2 使用手册与插件对接说明

> 依据：`https://nhentai.net/api/v2/openapi.json`（OpenAPI 3.1，版本 `2.0.0+55dd2ba`）、
> `https://nhentai.net/api/v2/changelog`，并于 2026-10-03 对线上接口做了实测校验。
> 本文同时说明 `koishi-plugin-nhentai-downloader` 是如何使用这些接口的。

---

## 1. 总览

### 1.1 基础信息

| 项目 | 值 |
| --- | --- |
| 站点源 | `https://nhentai.net` |
| API 根 | `https://nhentai.net/api/v2` |
| 文档 | `https://nhentai.net/api/v2/docs`（Swagger UI） |
| 规范 | `https://nhentai.net/api/v2/openapi.json` |
| 变更记录 | `https://nhentai.net/api/v2/changelog` |
| 数据格式 | `application/json`（错误也是 JSON） |
| 接口自述 | `GET /api/v2` → `{ "version": "2.0.0+55dd2ba", "message": "Abandon all hope, ye who develop here. See /docs" }` |

### 1.2 鉴权

官方定义了两个 security scheme，都通过 `Authorization` 请求头传递，前缀不同：

| 类型 | 请求头 | 说明 |
| --- | --- | --- |
| API Key | `Authorization: Key <api_key>` | 在账号设置页生成：`https://nhentai.net/user/settings#apikeys` |
| User Token | `Authorization: User <token>` | 通过 `POST /api/v2/auth/login` 取得 |
| Staff Token | `Authorization: User <token>`（需员工角色） | 仅用于审核类接口 |

绝大多数读取接口属于 **Public（可选鉴权）**：不带凭据也能调用，但配额更低，且无法获得个性化结果（收藏状态、黑名单过滤）。

> 变更记录 2026-05-04：官方把限流按鉴权状态分档，**匿名档更严且可能继续收紧**，明确建议接入方使用 API Key。

### 1.3 User-Agent 规范

官方明确要求：`AppName/version (contact or project URL)`。

插件实际发送（`src/constants.ts` 的 `USER_AGENT`）：

```
User-Agent: koishi-plugin-nhentai-downloader/2.0.0 (+https://github.com/YuzuharaYuka/koishi-plugin-nhentai-downloader)
```

> 官方要求的是可识别的自定义 UA，而不是伪装浏览器，因此插件不做任何浏览器指纹模拟，直接发送上面这行 UA。

### 1.4 响应与错误格式

成功响应为各端点 schema 定义的对象。错误统一为：

```json
{ "error": "Gallery not found" }
```

参数校验失败（HTTP 422）返回 FastAPI 风格：

```json
{ "detail": [ { "loc": ["query", "page"], "msg": "Input should be greater than or equal to 1", "type": "greater_than_equal" } ] }
```

常见状态码：

| 状态码 | 含义 | 插件处理 |
| --- | --- | --- |
| 200 | 成功 | — |
| 401 / 403 | 未授权 / 需要更高权限 | 警告日志，提示检查 API Key |
| 404 | 画廊不存在或已删除 | 警告日志，不重试 |
| 422 | 参数不合法 | 输出 `detail` 便于定位 |
| 429 | 触发限流 | 读取 `Retry-After`（若存在）后重试一次，并冻结该端点的客户端配额 |
| 5xx / 521 / 522 / 524 | 服务端或 Cloudflare 故障 | got 层指数退避重试 |

---

## 2. 限流

### 2.1 官方公布的配额

配额写在每个端点的文档描述里，**按 IP（部分按用户/密钥所有者）**统计。

| 端点 | 匿名 | 携带 API Key |
| --- | --- | --- |
| `GET /search` | 10 / 1min | 20 / 1min |
| `GET /galleries/{id}` | 20 / 1min | 45 / 1min |
| `GET /galleries` | 15 / 1min | 30 / 1min |
| `GET /galleries/tagged` | 15 / 1min | 30 / 1min |
| `GET /galleries/random` | 20 / 1min | 30 / 1min |
| `GET /galleries/{id}/related` | 12 / 1min | 30 / 1min |
| `GET /galleries/popular` | 8 / 1min | 8 / 1min |
| `POST /galleries/{id}/download`（zip/cbz） | 10 / 5min per IP | 10 / 5min（每密钥所有者） |
| `POST /galleries/{id}/download`（torrent） | 5 / 1min | 5 / 1min（每密钥所有者） |
| `GET /tags/ids` | 15 / 1min | 15 / 1min |
| `POST /tags/search` | 30 / 1min | 30 / 1min |
| `GET /tags/{type}`、`GET /tags/{type}/{slug}` | 15 / 1min | 30 / 1min |
| `GET /favorites`、`GET /blacklist`、`GET /user` | 需鉴权，15~30 / 1min | 同 |

### 2.2 为什么必须在客户端节流

实测结论（2026-10-03）：

- **HTTP 200 响应不包含任何 `X-RateLimit-*` 头**，无法得知当前剩余额度；只有 `429` 响应才会带上配额信息（变更记录 2026-03-30）。
- 被 429 的请求不再计入窗口，但连续触发会被 Cloudflare 记录。

因此插件的策略是 `src/services/rate-limiter.ts` 中的**逐端点滑动窗口限流器**：

1. 依据上表为每个端点建立独立配额；
2. 实际生效额度 = `floor(文档配额 × 0.9)`，为共享出口 IP 留出安全余量；
3. 配额耗尽时挂起请求直到窗口内最早的请求滑出，而不是盲目重试；
4. 收到 429 时按 `Retry-After`（缺失则默认 5s）冻结该端点，并重试一次。

按端点计数而非全局计数，是因为官方是对单端点统计的——例如搜索用完 10/min 并不影响画廊详情。

### 2.3 CDN 侧的风控

图片 CDN 不属于 `/api/v2`，**不计入 API 配额**，但有独立风控（变更记录 2026-04-26）：

- 持续远超正常浏览速度、或反复请求非法路径的客户端会被**临时封禁**（自动解封）；
- 官方要求把 CDN 返回的 `429` 当作退避信号；
- **不要猜测 CDN 路径**，必须使用接口返回的 `path`。

插件对应做法：并发上限沿用用户配置 `downloadConcurrency`（默认 10，配置上限 25）；任一主机请求失败即计入冷却，冷却期内该主机排到最后。

---

## 3. 端点详解

### 3.1 元信息

#### `GET /api/v2` — API 根

无需鉴权。返回 `{ version, message }`，可用于连通性与版本探测。

#### `GET /api/v2/pow` — 获取工作量证明挑战

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | query | 否 | 按动作指定难度 |

返回 `{ challenge, difficulty }`。**写入类**接口（登录、注册、重置密码、创建 API Key、提交/投票标签建议）需要 PoW。

插件只读取公开数据，不需要 PoW。

#### `GET /api/v2/config` — 站点配置（推荐）

无需鉴权。返回 CDN 列表与公告，是 `GET /cdn` 的**超集**：

```json
{
  "image_servers": ["https://i1.nhentai.net", "https://i2.nhentai.net", "https://i3.nhentai.net", "https://i4.nhentai.net"],
  "thumb_servers": ["https://t1.nhentai.net", "https://t2.nhentai.net", "https://t3.nhentai.net", "https://t4.nhentai.net"],
  "announcement": null
}
```

`announcement` 为 `null` 或 `{ message, links: [{ label, url }] }`。

> **插件选择**：只调用 `/config`，一次请求同时取得 CDN 列表与公告，避免再多打一次 `/cdn`；结果缓存 6 小时，失败时保留上一次成功的结果，1 分钟后才允许再次尝试。

#### `GET /api/v2/cdn` — 仅 CDN 列表

返回 `{ image_servers, thumb_servers }`。功能被 `/config` 覆盖，插件不使用。

#### `GET /api/v2/captcha` — 验证码提供方信息

供前端组件使用；配合 PoW 用于写入类接口。

### 3.2 画廊（galleries）

#### `GET /api/v2/galleries/{gallery_id}` — 画廊详情

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `gallery_id` | path | 是 | 整数 ID |
| `include` | query | 否 | 逗号分隔：`comments`、`related`、`favorite`、`suggestions`，默认空 |

配额：匿名 20/1min，带 Key 45/1min。

返回 `GalleryDetailResponse`，**页面数据（`pages`）已内联**，无需再请求分页接口（`/galleries/{id}/pages` 已于 2026-04-04 移除）。

`include` 的省流价值：

- `include=related` 可用**一次请求**同时拿到详情与相关作品，替代额外的 `/related` 调用（该端点匿名仅 12/1min）；
- `include=comments` 只返回最新 50 条评论，并额外给出顶层 `comment_count`（2026-05-21）；更多评论需分页调用 `/comments`；
- `include=favorite` 需要鉴权，返回 `is_favorited`。

> **插件用法**：正常查询只用 `GET /galleries/{id}`（不带 `include`）。`ApiService.getGallery(id, { include: ['related'] })` 保留能力，供需要“详情 + 相似作品”的场景一次取回。

#### `GET /api/v2/galleries` — 最新画廊

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `page` | 否 | 1 | 页码，≥1 |
| `per_page` | 否 | 25 | 每页条数，1~100 |

按最新排序返回 `PaginatedResponse[GalleryListItem]`。

#### `GET /api/v2/galleries/tagged` — 按标签浏览

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tag_id` | **是** | — | 标签 ID |
| `sort` | 否 | `date` | `date` / `popular` / `popular-today` / `popular-week` / `popular-month` |
| `page` | 否 | 1 | 页码 |
| `per_page` | 否 | 25 | 1~100 |

比 `sort=name` 的标签列表配合使用即可实现“按标签浏览”。

#### `GET /api/v2/galleries/popular` — 今日热门

- **无任何参数**（不接受 `page`）；
- 返回 **`GalleryListItem[]` 数组本身**，不是分页对象；
- 配额仅 8/1min。

```json
[ { "id": 685699, "media_id": "4222903", "english_title": "...", "thumbnail": "galleries/4222903/thumb.webp", "num_pages": 54, "num_favorites": 10859, "tag_ids": [ ... ], "blacklisted": false } ]
```

#### `GET /api/v2/galleries/random` — 随机画廊

只需返回 ID：`{ "id": 74352 }`。要展示完整信息需再请求一次 `/galleries/{id}`。

> **插件用法**：`nh.random` 因此固定消耗 2 次请求（random + gallery），且随机结果**不写入缓存**，否则会反复返回同一本。

#### `GET /api/v2/galleries/{gallery_id}/related` — 相关作品

返回 `{ "result": GalleryListItem[] }`，**没有 `num_pages` / `per_page` / `total`**。配额匿名 12/1min。

#### `POST /api/v2/galleries/{gallery_id}/download` — 官方打包直链

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `format` | 否 | `zip` | `zip`（页面 + `meta.json`）/ `cbz`（额外 `ComicInfo.xml`）/ `torrent` |

- **必须鉴权**（User Token 或 API Key），且官方需开启 `allow_downloads`；
- 返回 `{ url, expires_at }`，`expires_at` 是 **Unix 秒**，`url` 是短时效签名直链；
- 配额：zip/cbz 10/5min per IP，torrent 5/1min per IP（实测更紧，见 6.16）；
- 限速为每流若干 MB/s（实测约 3.4 MB/s）。

> 官方在 2026-05-01 的变更记录中明确：**“自行按页抓取 CDN 拼装压缩包的客户端应迁移到该端点”**，并建议带 API Key 与可识别 UA。

##### 实测：压缩包内容与图片命名（2026-10-03，gallery 685699）

**直链形态**（签名 URL，落在 CDN 主机上）：

```
https://i4.nhentai.net/download/4222903?gid=685699&u=7106102&exp=1791038386&r=5120&at=key&fmt=zip&meta=<base64 元数据>
```

- 路径里的 `4222903` 就是 `media_id`；`fmt=` 与请求的 format 一致；`at=key` 表示使用 API Key 认证；
- `exp` 即 `expires_at`：**实测有效期只有约 2 分钟**，拿到直链必须立刻下载；
- 响应为 `Content-Type: application/zip`、`Transfer-Encoding: chunked`（**没有 `content-length`**，因此进度只能按已下载字节估算）。

**`format=zip` 的条目（共 55 项 = 54 页 + 1 个元数据）**：

| 条目 | 说明 |
| --- | --- |
| `meta.json` | 位于**第一个**条目，内容见下 |
| `1.webp`、`2.webp`、`3.png`、…、`54.webp` | 逐页图片，**文件名为「页码 + 原扩展名」** |

- **命名规则就是 `<页码>.<扩展名>`**：`1.webp`、`2.webp`、`3.png`……与 `GET /galleries/{id}` 里 `pages[].path` 的扩展名**完全一致**（该作品 54 页中 53 页是 webp、第 3 页是 png，压缩包内也是 `3.png`）。
- 中央目录的顺序即页码升序（1,2,…,54），所以可以边解压边产出，不必整包载入内存。
- 压缩包内**只有页面图片与 meta.json**，不含封面、缩略图，也不含任何目录层级。
- `format=cbz` 额外包含 `ComicInfo.xml`（供漫画阅读器识别），页面命名相同。

**`meta.json` 结构**（1362 字节）：

```json
{
  "id": 685699,
  "title": { "english": "[Nyaa no Esa] ...", "japanese": "[にゃあのえさ] ..." },
  "upload_date": 1790962514,
  "num_pages": 54,
  "num_favorites": 11307,
  "scanlator": "",
  "tags": [ { "id": 33172, "type": "category", "name": "doujinshi" }, ... ]
}
```

注意它**没有** `media_id`、也没有 `title.pretty`；`tags` 只有 `id/type/name`，没有 `slug/count/description`。

**性能实测**：11.79 MB 的压缩包下载耗时 3.44s（≈3.43 MB/s），与官方“每流限速若干 MB/s”的描述一致。

**插件如何利用**（`src/services/archive.ts` + `src/services/download.ts`）：

1. `format=zip` 签发直链 → 流式下载到 `downloadPath/official-archive/*.zip`（`socket` 停滞超时，不用整体请求超时，避免大包被误杀）；
2. 读取中央目录，按 `<页码>` 排序，**忽略 `meta.json` / `ComicInfo.xml` / 非图片条目**，并用 `meta.json` 的 `num_pages` 交叉校验；
3. 逐页解压（内存中始终只有一页）→ 产出与 CDN 路径完全相同的 `DownloadedImage` 流；
4. 该流直接喂给既有的 PDF / ZIP / 图片流程，因此**图片压缩、密码加密、反审查水印、文件名规则全部照旧生效**；
5. 顺手把解压出的页面写入图片缓存，下次同一作品会直接命中缓存、连签发都不需要；
6. 任何环节失败（未配置 API Key、配额不足、429、直链过期、下载失败、解压失败、页数为 0）都会**自动回退到 CDN 逐页下载**，不影响可用性。

#### `GET/POST/DELETE /api/v2/galleries/{gallery_id}/favorite` — 收藏

需要鉴权（User Token 或 API Key），15/1min。`GET` 查询状态，`POST` 收藏，`DELETE` 取消。写操作需开启 `allow_favorites`。

#### 其他画廊相关端点

| 端点 | 说明 |
| --- | --- |
| `POST /galleries/{id}/edit` | **已废弃**（标签变更改走建议流程），需员工令牌 |
| `GET /galleries/{id}/suggestions` | 列出该画廊的标签变更建议（需 `allow_gts`） |
| `POST /galleries/{id}/suggestions` | 提交标签增删建议，需 User Token + PoW + 验证码 |
| `POST /galleries/{id}/suggestions/{sid}/vote` | 对建议投票，需 User Token + PoW |
| `DELETE /galleries/{id}/suggestions/{sid}` | 撤回自己待审的建议 |
| `GET /galleries/{id}/comments` | 评论分页（默认 `per_page=50`），30/1min |
| `GET /galleries/{id}/comments/count` | 评论数，12/1min |

### 3.3 搜索（search）

#### `GET /api/v2/search`

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | **是** | — | 非空字符串（`minLength: 1`） |
| `sort` | 否 | `date` | `date` / `popular` / `popular-today` / `popular-week` / `popular-month` |
| `page` | 否 | 1 | ≥1 |

返回 `PaginatedResponse[GalleryListItem]`。**没有 `per_page` 参数**，每页固定 25 条。配额匿名 10/1min，带 Key 20/1min。

查询语法（官方文档原文要点）：

| 语法 | 示例 |
| --- | --- |
| 关键词 | `big breasts` |
| 精确短语 | `"exact phrase"` |
| 取反 | `-word`、`-"exact phrase"`、`-artist:name` |
| 标签过滤 | `artist:name`、`language:english`、`tag:"big breasts"` |
| 数值过滤 | `pages:>10`、`favorites:>=100` |
| 日期过滤 | `uploaded:<7d`、`uploaded:>1m` |

> **插件用法**：`nh.search` 会把 `-l chinese|japanese|english` 转成 `language:<lang>` 追加到关键词后（`src/handlers.ts` 的 `buildSearchQuery`）；关键词为空时回退到 `pages:>0`，以便 `.popular` 这类只有排序没有关键词的用法也能工作。
>
> 关键词为空串会被官方 422 拒绝，所以插件在发请求前就直接返回，不浪费配额。

### 3.4 标签（tags）

| 端点 | 参数 | 说明 | 配额 |
| --- | --- | --- | --- |
| `GET /tags/ids` | `ids`（逗号分隔，**最多 100 个**） | 批量按 ID 查标签 | 15/1min |
| `POST /tags/search` | body `{ type?, query?, limit? }`（limit 1~50，默认 10） | 按名称前缀搜索标签，大小写不敏感 | 30/1min |
| `GET /tags/{tag_type}` | `sort`（`name`/`popular`，默认 `popular`）、`page`、`per_page` | 按类型分页列出标签，`sort=name` 时额外返回 `alphabet` 索引 | 15~30/1min |
| `GET /tags/{tag_type}/{slug}` | — | 按类型 + slug 查单个标签 | 15~30/1min |

> 插件当前不解析列表项里的 `tag_ids`（那需要额外的 `/tags/ids` 请求），因此列表视图只展示 API 直接给出的标题、页数与收藏数。

### 3.5 账户与个性化

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/user` | GET / PUT / DELETE | 资料读取、更新、注销 |
| `/user/keys` | GET / POST | 列出 / 创建 API Key（创建需 PoW + 验证码） |
| `/user/keys/{key_id}` | DELETE | 吊销 API Key |
| `/user/avatar` | POST | 上传头像（≤10MB，转 PNG 并缩放到 200×200） |
| `/favorites` | GET | 收藏列表，支持 `q` 过滤与 `page` |
| `/favorites/random` | GET | 收藏中的随机一项（只返回 ID） |
| `/blacklist` | GET / POST | 黑名单读取与更新 |
| `/blacklist/ids` | GET | 仅返回黑名单标签 ID |
| `/users/{user_id}/{slug}` | GET | 公开用户资料（需同时给出 ID 与正确 slug） |
| `/users/{user_id}/flag` | POST | 举报用户资料 |
| `/auth/*` | POST/GET/DELETE | 登录、注册、刷新、登出、会话管理、密码重置 |

> **插件用法**：配置了 API Key 后，官方会按请求头自动做黑名单过滤，列表项的 `blacklisted` 字段即为过滤依据；插件据此在展示前剔除被屏蔽的画廊（`isGalleryBlacklisted`），不会额外请求 `/blacklist`。

### 3.6 社区与后台接口（仅登记）

以下接口与插件的阅读/下载场景无关，仅供完整性参考：

- 标签建议（GTS）：`/galleries/{id}/suggestions*`、`/gts/backlog`、`/gts/new-tags`、`/moderation/gts*`、`/moderation/tags`
- 标签体系提案（taxonomy）：`/taxonomy*`、`/moderation/taxonomy*`
- 评论：`/comments/{id}`、`/comments/{id}/flag`、`/comments/flags/{id}/review`
- 审核：`/moderation/*`（用户、画廊、编辑、垃圾信息、批量操作、IP 查询）
- 广告位：`/zones*`

这些接口大多需要 User Token（部分需 Staff Token）并叠加 PoW、验证码与更严的按小时配额。

### 3.7 完整端点索引（按标签）

| 分组 | 端点数 | 代表端点 |
| --- | --- | --- |
| （无标签） | 4 | `/`、`/pow`、`/config`、`/captcha` |
| `cdn` | 1 | `/cdn` |
| `galleries` | 11 | `/galleries*`、`/galleries/{id}/download`、`/favorite` |
| `search` | 1 | `/search` |
| `tags` | 4 | `/tags/ids`、`/tags/search`、`/tags/{type}`、`/tags/{type}/{slug}` |
| `favorites` | 2 | `/favorites`、`/favorites/random` |
| `blacklist` | 3 | `/blacklist`、`/blacklist/ids` |
| `user` | 7 | `/user*`、`/user/keys*`、`/user/avatar` |
| `users` | 2 | `/users/{id}/{slug}`、`/users/{id}/flag` |
| `auth` | 9 | `/auth/login`、`/auth/refresh`、`/auth/sessions*` 等 |
| `comments` | 5 | `/galleries/{id}/comments*`、`/comments/{id}*` |
| `GTS` | 10 | `/galleries/{id}/suggestions*`、`/gts/*`、`/moderation/gts*` |
| `taxonomy` | 17 | `/taxonomy*`、`/moderation/taxonomy*` |
| `moderation` | 30+ | `/moderation/*` |
| `zones` | 4 | `/zones*` |

（合计 70+ 个路径，完整定义以 `openapi.json` 为准。）

---

## 4. 数据结构

### 4.1 `GalleryDetailResponse`

`GET /galleries/{id}` 的返回体。实测样例（`id=685699`）字段如下：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 画廊 ID |
| `media_id` | string | 是 | 媒体目录名，出现在 CDN 路径中 |
| `title` | `GalleryTitle` | 是 | `{ english, japanese, pretty }`，**`japanese` 可能为 `null`** |
| `cover` | `CoverInfo` | 是 | `{ path, width, height }` |
| `thumbnail` | `CoverInfo` | 是 | 同上 |
| `scanlator` | string | 否 | 默认 `""` |
| `upload_date` | integer | 是 | **Unix 秒**（`new Date(v * 1000)`） |
| `tags` | `TagResponse[]` | 是 | 见 4.5 |
| `num_pages` | integer | 是 | 总页数 |
| `num_favorites` | integer | 是 | 收藏数 |
| `pages` | `PageInfo[]` | 否 | 默认 `[]`，每页一项 |
| `comments` | array \| null | 否 | 仅 `include=comments` |
| `comment_count` | integer \| null | 否 | 仅 `include=comments` |
| `related` | `GalleryListItem[]` \| null | 否 | 仅 `include=related` |
| `is_favorited` | boolean \| null | 否 | 仅 `include=favorite`（需鉴权） |
| `suggestions` | object \| null | 否 | 仅 `include=suggestions` |

`PageInfo`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `number` | integer | 页码（从 1 开始） |
| `path` | string | 原图相对路径，如 `galleries/4222903/1.webp` |
| `width` / `height` | integer | 原图尺寸 |
| `thumbnail` | **string** | 缩略图相对路径，如 `galleries/4222903/1t.webp` |
| `thumbnail_width` / `thumbnail_height` | integer | 缩略图尺寸 |

> ⚠️ v2 的 `PageInfo.thumbnail` 是**字符串路径**，不是对象。旧代码若按 `page.thumbnail.path` 取值会得到 `undefined`。

### 4.2 `GalleryListItem`

列表类接口（`/search`、`/galleries`、`/galleries/tagged`、`/galleries/popular`、`/related`、`include=related`）统一使用该结构——**是轻量对象，没有 `title` 对象和 `tags` 数组**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 是 | 注意是数字；画廊详情里的 `id` 是数字、插件内部统一转字符串 |
| `media_id` | string | 是 | — |
| `english_title` | string | 是 | 平铺字段，不是 `title.english` |
| `japanese_title` | string \| null | 否 | 可能为 `null` |
| `thumbnail` | string | 是 | 相对路径 |
| `thumbnail_width` / `thumbnail_height` | integer | 是 | — |
| `num_pages` | integer | 否 | 默认 0（2026-03-31 起提供） |
| `num_favorites` | integer | 否 | 默认 0 |
| `tag_ids` | integer[] | 否 | 默认 `[]`，需要 `/tags/ids` 才能换成名称 |
| `blacklisted` | boolean | 否 | 默认 `false`，按当前鉴权用户的黑名单计算 |

### 4.3 分页与包装结构

| 结构 | 用途 | 字段 |
| --- | --- | --- |
| `PaginatedResponse[T]` | `/search`、`/galleries`、`/galleries/tagged` | `result: T[]`、`num_pages`、`per_page`（默认 25）、`total?` |
| `RelatedGalleriesResponse` | `/galleries/{id}/related` | 仅 `result`，**没有分页字段** |
| 裸数组 | `/galleries/popular` | 直接是 `GalleryListItem[]` |
| `{ id }` | `/galleries/random`、`/favorites/random` | 仅 ID |

### 4.4 CDN 与公告

| 结构 | 字段 |
| --- | --- |
| `CdnConfigResponse`（`/cdn`） | `image_servers: string[]`、`thumb_servers: string[]`（完整 URL，需提取主机名） |
| `ConfigResponse`（`/config`） | 上述两项 + `announcement: Announcement \| null` |
| `Announcement` | `message: string`、`links?: [{ label?, url? }]` |

### 4.5 其他常用结构

| 结构 | 字段 |
| --- | --- |
| `TagResponse` | `id`、`type`、`name`、`slug`、`url`、`count`、`description?`、`is_community?`、`pending_describe_id?` |
| `DownloadResponse` | `url`、`expires_at`（Unix 秒） |
| `FavoriteResponse` | `favorited`、`num_favorites?` |
| `ErrorResponse` | `error` |
| `PoWChallengeResponse` | `challenge`、`difficulty` |

`TagResponse.type` 的常见取值：`tag`、`category`、`artist`、`parody`、`character`、`group`、`language`。

---

## 5. 插件的对接方式

### 5.1 功能 → 端点映射

| 插件能力 | 使用的端点 | 限流键 | 缓存 |
| --- | --- | --- | --- |
| `nh.search` / `nh.popular` | `GET /search`（`query` + `page` + `sort`） | `search` | 内存，`apiCacheTTL` 分钟 |
| `nh.search <ID>`、`nh.download` | `GET /galleries/{id}` | `gallery` | 内存，`apiCacheTTL` 分钟 |
| `nh.random` | `GET /galleries/random` → `GET /galleries/{id}` | `random` + `gallery` | 随机结果不缓存 |
| 相似作品（可选用） | `GET /galleries/{id}/related` 或 `include=related` | `related` | 内存，`apiCacheTTL` 分钟 |
| 今日热门（可选用） | `GET /galleries/popular` | `popular` | 内存，`apiCacheTTL` 分钟 |
| CDN 列表 + 公告 | `GET /config` | `config` | 内存 6 小时 |
| **官方打包直链（`downloadSource`）** | `POST /galleries/{id}/download?format=zip` | `download`（15s 最小间隔 + 3/5min） | 直链不缓存；解压后的页面写入图片缓存 |
| 页面图片 / 缩略图（回退路径） | `https://i*.nhentai.net/{path}`、`https://t*.nhentai.net/{path}` | 不计入 API 配额 | 磁盘缓存（图片/PDF） |

### 5.1.1 取图方式（`downloadSource`）

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 配置了 API Key 时优先官方打包直链，否则用 CDN |
| `official` | 强制优先官方直链（未配置 API Key 时给出警告后仍走 CDN） |
| `cdn` | 只从 CDN 逐页下载（等价于旧版本行为） |

无论取哪个值，**官方直链失败都会自动回退 CDN**，因此不存在“配置了 official 反而下不动”的情况。此外，当作品的页面已全部命中本地图片缓存时，插件会**跳过签发**直接读缓存。

两者的取舍：

| | 官方打包直链 | CDN 逐页下载 |
| --- | --- | --- |
| 需要 API Key | 是 | 否 |
| 请求数量 | 2（签发 + 下载整包） | 1（元数据）+ N（每页） |
| 速度 | 受官方每流限速（实测 ≈3.4 MB/s） | 受并发数与 CDN 延迟影响（实测 12~13 页/秒） |
| 签发配额 | 很紧（见 6.16） | 不占用 API 配额，但受 CDN 风控 |
| 后续处理 | 完全一致（解压后走同一套流程） | — |

### 5.1.2 官方直链 → PDF/ZIP 的数据流

```
POST /galleries/{id}/download?format=zip
        │  { url, expires_at }        ← 有效期约 2 分钟
        ▼
流式下载整包 → downloadPath/official-archive/<id>-<ts>.zip
        ▼
读取中央目录 → 按 <页码> 排序 → 过滤 meta.json / ComicInfo.xml
        ▼
逐页解压（内存中仅一页）→ DownloadedImage 流（index / buffer / extension）
        ▼
├── createPdf()   → 可选密码加密、JPEG 重编码压缩、反审查水印
├── createZip()   → 可选密码加密
└── 逐张发送       → 与 CDN 路径完全相同
        ▼
删除临时压缩包（finally）
```

### 5.2 HTTP 传输层

所有请求都走 Koishi 的 `ctx.http`（undici/fetch 实现），由 `src/services/http.ts` 统一封装：

| 项 | 取值 | 说明 |
| --- | --- | --- |
| 传输层 | `ctx.http` | 插件不引入自带 HTTP 库；`inject.required` 声明 `http` |
| 代理 | 交给 `proxy-agent` 插件或 `HTTPS_PROXY` 等环境变量 | `proxy-agent` 在 `http/fetch-init` 里注入 `dispatcher`，插件无需自行解析代理 |
| 连接复用 | undici 全局 Agent | 默认 keep-alive，无需自建 Agent |
| User-Agent | 官方要求的自定义 UA | 不做浏览器指纹模拟 |
| 鉴权 | `Authorization: Key <api_key>` | 配置了 `apiKey` 才发送 |
| 元数据超时 | 20s | 与图片下载超时解耦 |
| 元数据并发 | 4 | 配合逐端点限流即可 |
| 元数据重试 | 显式指数退避，最多 3 次，状态码 408/413/5xx/521/522/524 与网络错误 | **429 单独处理**：按 `Retry-After` 冻结该端点后重试一次，不与退避叠加 |

图片与压缩包走的都是同一个传输层，区别只在 `responseType`：

| 用途 | responseType | 超时 | 重试策略 |
| --- | --- | --- | --- |
| 元数据 | `json` | `API_REQUEST_TIMEOUT_MS` | 上面的指数退避 |
| 页面图片 / 缩略图 | `arraybuffer` | `downloadTimeout` | 由调用方控制：换 CDN 主机 + 指数退避，4xx 立即放弃 |
| 官方压缩包 | `stream` | `officialArchiveTimeout` | 不重试（失败即回退 CDN），另有 60s 传输停滞超时 |

> 为什么不用带浏览器指纹的 HTTP 库：官方文档要求的是**可识别**的 UA 与 API Key，而不是伪装浏览器；指纹生成只会给每个请求增加开销，且自建 Agent 会绕过运行时注入的代理能力，反而更容易连不上。

### 5.3 图片下载与 CDN 选路

1. `GET /config` 下发的主机列表全部保留（当前为 `i1`~`i4` 与 `t1`~`t4`）；
2. 首选用**健康度排序后**的第一台：冷却中的主机排到最后，其余按实测延迟（EWMA）升序，未采样的保持官方顺序（通常仍是 `i1`）；
3. 每次请求结果回报 `ApiService.reportCdnResult(host, ok, latencyMs)`；失败累计会按 `30s × 失败次数`（上限 5 分钟）冷却该主机；
4. 重试时若开启 `enableSmartRetry`，会把 URL 的主机替换为下一台候选，实现**单台 CDN 故障自动转移**；
5. 重试次数即总请求次数（默认 3），配合指数退避（`downloadRetryDelay × 2^n`，上限 15s）；遇到 4xx（429/408 除外）立即放弃，不再浪费配额。

### 5.4 缓存

| 缓存 | 位置 | 键 | 失效 |
| --- | --- | --- | --- |
| API 响应 | 内存（LRU + TTL，上限 500 条） | 端点 + 参数（如 `nhentai:search:<关键词>:<页>:<排序>`） | `apiCacheTTL` 分钟（默认 10） |
| CDN / 公告 | 内存 | 单例 | 6 小时，失败 1 分钟后重试 |
| 图片 | 磁盘 | `galleryId-mediaId-pageIndex[-thumb][-processed]` | `imageCacheTTL` 小时，按体积 LRU 清理 |
| PDF | 磁盘 | `galleryId[-密码哈希]` | `pdfCacheTTL` 小时 |

`InMemoryCache` 的实现要点：命中后把条目移到 Map 末尾以获得真正的 LRU 语义；O(1) 淘汰最旧条目；不为每个条目创建定时器，改为读取时惰性判过期 + 单个 `unref` 定时器定期清扫。

---

## 6. 实测注意事项（易踩的坑）

1. **`/galleries/popular` 返回数组、且不接受 `page`。** 若按分页对象解析（读 `.result`），将永远得到空列表。
2. **`sort` 只有 5 个合法值**（`date`、`popular`、`popular-today`、`popular-week`、`popular-month`）。传入其他值会得到 422；插件会在发请求前归一化，并把 `today`/`week`/`month` 映射为对应的 `popular-*`。
3. **`/search` 没有 `per_page`**，固定 25 条/页。
4. **`/related` 没有分页字段**，别按 `PaginatedResponse` 处理。
5. **`/galleries/random` 只返回 `{ id }`**，展示详情必须再请求一次。
6. **封面路径会重复扩展名**：`galleries/<media_id>/cover.webp.webp`，插件在转换阶段归一化。
7. **`PageInfo.thumbnail` 是字符串**，不是 `{ path, width, height }`。
8. **`/galleries/{id}/pages` 已移除**（2026-04-04），页数据在画廊详情里。
9. **只有 429 响应才带配额头**，200 响应没有任何 `X-RateLimit-*`；必须按文档配额在客户端主动节流。
10. **匿名档配额明显更低**（如搜索 10/min vs 20/min）；官方建议接入方使用 API Key。
11. **CDN 有独立风控**，会临时封禁；不要猜测 CDN 路径，也不要以远超正常阅读的速度抓取。
12. **`include=related` 比单独请求 `/related` 更省配额**，但匿名档的相关作品配额只有 12/min。
13. **`upload_date` 是 Unix 秒**；`title.japanese` 与 `listItem.japanese_title` 都可能为 `null`。
14. **`blacklisted` 只在鉴权（且有黑名单）时才有意义**；列表接口会据其过滤。
15. **官方 API 不需要浏览器指纹模拟**：只要带上可识别的 `User-Agent`（必要时再加 API Key），普通 HTTP 客户端即可正常访问；插件因此只依赖 Koishi 的 `ctx.http`。
16. **官方压缩包直链的签发限制比文档更紧**：文档写 zip/cbz 为 10/5min per IP，但实测**每成功签发一次后，紧接着的第二次必然 429**（`x-ratelimit-limit: 10`、`x-ratelimit-remaining: 0`、`retry-after: 300`）；间隔约 15s 后可以再次成功。`retry-after: 300` 并不代表真的要等满 300s，但必须当作退避信号处理。
    - 插件对应策略：对签发端点单独设置 **15s 最小间隔 + 3 次/5min 的本地预算**；配额不足时**直接跳过**（不排队等待）并回退到 CDN，绝不会让用户为了等配额卡住几分钟。
17. **`POST /download` 的压缩包直接从 CDN 主机下发**（`i1`~`i4.nhentai.net/download/...`），因此会占用 CDN 侧的风控额度；官方要求把 `429` 当退避信号。
18. **直链有效期实测约 2 分钟**（`expires_at - now ≈ 120s`），且响应为 chunked、无 `content-length`。

---

## 7. 与接入相关的官方变更记录摘要

| 日期 | 变更 | 对插件的影响 |
| --- | --- | --- |
| 2026-05-04 | 限流按鉴权状态分档，匿名档更严 | 引入按端点配额表；文档标注匿名/带 Key 两档 |
| 2026-05-01 | 新增 `POST /galleries/{id}/download`，并建议按页抓取的客户端迁移到该端点 | 保留官方直链能力；默认仍本地打包以支持 PDF/密码/压缩/反审查 |
| 2026-04-26 | CDN 会对超额与非法路径的客户端临时封禁；`429` 作为退避信号 | 引入 CDN 主机健康度与冷却机制 |
| 2026-04-04 | 移除 `/galleries/{id}/pages`；收紧多数端点配额 | 页数据从画廊详情读取 |
| 2026-04-03 | `tags/autocomplete` 更名 `tags/search`；新增 `tags/ids`；列表接口补齐 `tag_ids` | 未使用旧路径，无影响 |
| 2026-04-02 | 列表响应新增 `blacklisted`；鼓励设置描述性 UA | 列表项类型补充 `blacklisted`；统一 UA |
| 2026-03-31 | 列表接口新增 `num_pages` | 列表视图可直接展示页数 |
| 2026-03-30 | 429 响应开始带配额头；被 429 的请求不计入窗口 | 429 时优先读取 `Retry-After` |
| 2026-05-21 | `include=comments` 只返回最新 50 条并新增 `comment_count` | 未使用 |

---

## 8. 参考

- API 文档（Swagger UI）：<https://nhentai.net/api/v2/docs>
- OpenAPI 规范：<https://nhentai.net/api/v2/openapi.json>
- 变更记录：<https://nhentai.net/api/v2/changelog>
- API Key 申请：<https://nhentai.net/user/settings#apikeys>
- 官方支持邮箱：<support@nhentai.net>
