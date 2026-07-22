# ORSP Converter

把阅读类书源规则 JSON 转换为可直接使用的
[Open Reading Source Protocol](https://github.com/miloquinn/open-reading-source-protocol)
端点。

- 在线使用：[book.openany.shop](https://book.openany.shop)
- ORSP 阅读器：[miloquinn/open-reading](https://github.com/miloquinn/open-reading)
- 源码仓库：[miloquinn/orsp-converter](https://github.com/miloquinn/orsp-converter)

转换后的发现文档地址：

```text
{PUBLIC_ORIGIN}/s/<id>/.well-known/open-reading-source.json
```

## 功能

- 通过 JSON 文件、粘贴内容或 URL 导入书源
- 合集数组在浏览器端分块上传，通过异步任务显示逐项进度、失败原因并支持仅重试失败项
- 将搜索、发现、详情、目录和正文映射为 ORSP 1.4 API
- 相同 `bookSourceUrl` 自动去重并复用已有地址
- 只有完整通过 `search → detail → catalog → content` 验证的源才公开
- 统计成功正文读取、近期匿名读者、转换次数和点赞
- 将同源封面代理为当前 ORSP 服务地址，限制响应类型、大小和跳转目标，并使用有界连接池及持久缓存削峰
- 定时重新审计已挂载书源，健康检查不计入真实阅读量

## 支持范围

当前覆盖常见 Default/CSS 选择器、基础及递归 JSONPath、常见 JSON 字段模板、URL 模板、POST 表单、
字符集转换、静态 Cookie，以及包含重定向 Cookie 的普通 HTTP `Set-Cookie` 会话。

对于经过代码审计、名称/域名/规则指纹完全匹配的来源，可以提供固定协议 codec；
当前包括连尚读书的 XXTEA/RSA API。该例外不会执行导入 JSON 中的 JavaScript。

以下能力不会执行：

- 内嵌 JavaScript、Java/Rhino 规则
- WebView 或交互式登录
- CAPTCHA、人机验证和浏览器挑战绕过
- 完整 XPath 方言

包含这些能力的书源只有在普通 HTTP 链路仍能完整工作时才会发布。

## 本地运行

要求 Node.js 20 或更新版本。

```bash
npm ci
npm run build
npm start
```

默认地址为 `http://127.0.0.1:8790`。开发模式：

```bash
npm run dev
```

完整检查：

```bash
npm run check
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8790` | HTTP 监听端口 |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:$PORT` | 写入 ORSP 地址的公开来源 |
| `DATA_DIR` | `./data/sources` | 已转换书源的持久化目录 |
| `GITHUB_OAUTH_CLIENT_ID` | 空 | GitHub OAuth App Client ID；回调地址为 `$PUBLIC_ORIGIN/api/admin/github/callback` |
| `GITHUB_OAUTH_CLIENT_SECRET` | 空 | GitHub OAuth App Client Secret，仅放入部署 secrets 环境 |
| `GITHUB_ADMIN_LOGINS` | 空 | 额外管理员 GitHub 用户名，逗号分隔；`miloquinn` 始终为管理员 |
| `ADMIN_PASSWORD` | 空 | 可选的本地恢复密码；管理页面默认只展示 GitHub 登录 |
| `STATS_HASH_KEY` | 开发默认值 | 生产环境必须设置，用于匿名指标 HMAC |
| `COVER_FETCH_TIMEOUT_MS` | `10000` | 单次封面上游请求（含排队）的超时毫秒数 |
| `COVER_UPSTREAM_CONNECTIONS` | `6` | 每个上游来源允许的最大并发连接数，最高限制为 32 |
| `COVER_CACHE_DIR` | `$DATA_DIR/.cover-cache` | 持久封面缓存目录；部署时应与 `DATA_DIR` 一起保留 |
| `COVER_CACHE_FRESH_HOURS` | `24` | 缓存无需刷新即可直接返回的小时数 |
| `COVER_CACHE_STALE_HOURS` | `168` | 上游暂时失败时可返回已验证旧缓存的最长小时数 |
| `COVER_CACHE_MAX_MB` | `256` | 封面缓存总大小上限；清理时优先删除最早写入的条目 |

`.env.example` 仅作为变量清单。项目不会自动加载 `.env`；请通过运行环境、
systemd 或 Node.js `--env-file` 传入配置。

站点暗号不通过环境变量保存。管理员登录 `/admin.html` 后可随时设置或替换；
服务端只在 `$DATA_DIR/.admin/site-access.json` 保存加盐哈希，暗号变更会立即使旧访问会话失效。
举报记录保存在 `$DATA_DIR/.admin/source-reports.json`，安全事件与 IP 封禁保存在
`$DATA_DIR/.admin/ip-security.json`。为支持滥用调查和封禁，举报、暗号失败和管理员恢复密码失败
会记录原始 IP；正常阅读统计仍只保存 HMAC 标识，不保存原始 IP。

GitHub 登录需要先在 GitHub 创建 OAuth App：Homepage URL 填 `PUBLIC_ORIGIN`，
Authorization callback URL 填 `$PUBLIC_ORIGIN/api/admin/github/callback`。随后把 Client ID 和
Client Secret 分别写入 `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`；生产环境的
Client Secret 应放在 systemd 已加载且不会同步进仓库的 `secrets.env` 中。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/sources?sort=usage\|votes\|converts\|newest` | 公开书源列表和聚合统计 |
| `GET` | `/api/sources/:id` | 单个书源详情 |
| `POST` | `/api/convert` | 转换书源；必须同时提交当前条款版本、同意声明和合法访问确认 |
| `POST` | `/api/conversion-jobs` | 创建异步合集任务；提交预计条目数和与单条转换相同的确认字段 |
| `POST` | `/api/conversion-jobs/:id/chunks` | 向任务追加最多 50 条书源，总计最多 5000 条 |
| `POST` | `/api/conversion-jobs/:id/seal` | 封口并以最多 4 个并发开始审计 |
| `GET` | `/api/conversion-jobs/:id` | 查询逐项进度和转换结果 |
| `POST` | `/api/conversion-jobs/:id/retry` | 仅重新审计已完成任务中的失败项 |
| `POST` | `/api/conversion-jobs/:id/cancel` | 取消未封口或仍在执行的合集任务 |
| `POST` | `/api/sources/:id/vote` | 匿名点赞 |
| `POST` | `/api/sources/:id/reports` | 举报排行榜书源；保存原因、说明和提交 IP |
| `GET` | `/api/access/status` | 查询网站暗号门禁状态 |
| `POST` | `/api/access/unlock` | 使用当前暗号解锁排行榜与转换 API |
| `GET` | `/api/admin/github/start` | 发起 GitHub 管理员登录 |
| `GET` | `/api/admin/github/callback` | GitHub OAuth 回调 |
| `GET` | `/api/admin/sources` | 管理员查看全部书源（含隐藏和审计失败项） |
| `GET` | `/api/admin/access` | 管理员查看暗号配置状态（不返回暗号） |
| `POST` | `/api/admin/access` | 管理员设置、替换或清空网站暗号 |
| `POST` | `/api/admin/sources/:id/visibility` | 管理员隐藏或恢复排行榜项目 |
| `DELETE` | `/api/admin/sources/:id` | 管理员永久删除书源 |
| `GET` | `/api/admin/reports` | 管理员查看举报记录和提交 IP |
| `POST` | `/api/admin/reports/:id/resolve` | 管理员下架排行榜或忽略举报 |
| `GET` | `/api/admin/security` | 管理员查看失败认证、举报 IP 和封禁列表 |
| `POST` | `/api/admin/security/bans` | 管理员封禁 IP |
| `POST` | `/api/admin/security/unban` | 管理员解除 IP 封禁 |
| `GET` | `/s/:id/.well-known/open-reading-source.json` | ORSP 发现文档 |
| `GET` | `/s/:id/api/v1/...` | ORSP 读取接口 |

`/admin.html` 只用于登录后删除垃圾源。

转换请求示例：

```json
{
  "source": { "bookSourceName": "…", "bookSourceUrl": "https://…" },
  "acceptedTerms": true,
  "rightsConfirmed": true,
  "termsVersion": "2026-07-22"
}
```

缺少任一确认或条款版本过期时，接口返回 `403 TERMS_NOT_ACCEPTED`。
同步接口保留 `converted` 和 `errors` 字段，并额外返回逐项
`items: [{ index, sourceName, status, result?, error? }]`，因此合集中的成功项与失败项可以明确对应。

合集文件由网页先解析为数组，再以小批次提交，因此不需要提高公开 HTTP
入口的请求体上限。任务 ID 会保存在当前浏览器，刷新页面后可继续查看；任务只允许
创建它的客户端网络地址读取或追加，过期任务会由服务端清理。单条规则限制为
512KB、单批限制为 1MB、单任务保留的规则数据限制为 32MB；任务保存在进程内，
服务重启后不会恢复。

## 数据与隐私

- 导入的书源规则保存在 `DATA_DIR`，该目录默认被 Git 忽略。
- 正常阅读与点赞不会持久化原始 IP；举报、失败认证和管理员 IP 封禁会为安全处置保存原始 IP，但不会通过公开 API 暴露。城市和地理位置不采集、不持久化。
- 点赞去重和近期读者统计只保存由 `STATS_HASH_KEY` 生成的 HMAC 标识，并限制数量。
- 运行时获得的 Cookie 只存在于进程内存，不写入公开 API、日志、审计报告或 Git。
- 已验证的封面响应临时保存在 `COVER_CACHE_DIR`，受大小和最长保留时间限制；只在同一已登记封面 URL 上游暂时失败时返回旧缓存。
- 排行榜只公开聚合计数。

## 部署

仓库附带 systemd、nginx 和 rsync 部署示例。先创建本地配置：

```bash
cp .deploy.env.example .deploy.env
```

填写部署主机、用户和 SSH 私钥路径后运行：

```bash
bash deploy/deploy.sh
```

`.deploy.env`、环境变量、密钥、运行数据和日志均被 Git 忽略，并在 rsync 时排除。
示例 systemd 单元默认使用 `ubuntu` 用户和 `/opt/orsp-legado-adapter`；修改这些
默认值时需要同步调整单元文件。

## 负责任使用

本项目只是规则格式转换工具，不提供任何书籍内容，也不提供、出售或推荐任何书源。
第三方规则被转换、验证、公开展示或可以访问，不代表本项目已经完成权利审查、获得授权
或为其内容背书。

使用者只能提交和访问自己拥有合法权利、已获明确授权或依法可以访问的书源配置、目标
网站和内容。请勿绕过登录、访问控制、人机验证、地域限制、反爬措施或付费限制。通过本
工具临时获取、缓存或导出的第三方内容，应在完成个人测试后尽快删除，不得长期保存、
复制、公开传播、出售或再许可。

疑似侵权应优先联系相关书源根地址所指向的原站运营者或权利人，也可通过
[open-reading 权利反馈表](https://github.com/miloquinn/open-reading/issues/new?template=rights_report.yml)
提交可核验信息，由维护者人工封禁或下架相关书源。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT](LICENSE)
