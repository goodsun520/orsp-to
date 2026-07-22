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
- 将搜索、发现、详情、目录和正文映射为 ORSP 1.4 API
- 相同 `bookSourceUrl` 自动去重并复用已有地址
- 只有完整通过 `search → detail → catalog → content` 验证的源才公开
- 统计成功正文读取、近期匿名读者、转换次数和点赞
- 将同源封面代理为当前 ORSP 服务地址，限制响应类型、大小和跳转目标，并使用有界连接池及持久缓存削峰
- 定时重新审计已挂载书源，健康检查不计入真实阅读量

## 支持范围

当前覆盖常见 Default/CSS 选择器、基础 JSONPath、URL 模板、POST 表单、
字符集转换、静态 Cookie 和普通 HTTP `Set-Cookie` 会话。

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
| `ADMIN_PASSWORD` | 空 | 管理页密码；为空时管理登录禁用 |
| `STATS_HASH_KEY` | 开发默认值 | 生产环境必须设置，用于匿名指标 HMAC |
| `COVER_FETCH_TIMEOUT_MS` | `10000` | 单次封面上游请求（含排队）的超时毫秒数 |
| `COVER_UPSTREAM_CONNECTIONS` | `6` | 每个上游来源允许的最大并发连接数，最高限制为 32 |
| `COVER_CACHE_DIR` | `$DATA_DIR/.cover-cache` | 持久封面缓存目录；部署时应与 `DATA_DIR` 一起保留 |
| `COVER_CACHE_FRESH_HOURS` | `24` | 缓存无需刷新即可直接返回的小时数 |
| `COVER_CACHE_STALE_HOURS` | `168` | 上游暂时失败时可返回已验证旧缓存的最长小时数 |
| `COVER_CACHE_MAX_MB` | `256` | 封面缓存总大小上限；清理时优先删除最早写入的条目 |

`.env.example` 仅作为变量清单。项目不会自动加载 `.env`；请通过运行环境、
systemd 或 Node.js `--env-file` 传入配置。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/sources?sort=usage\|votes\|converts\|newest` | 公开书源列表和聚合统计 |
| `GET` | `/api/sources/:id` | 单个书源详情 |
| `POST` | `/api/convert` | 转换书源；必须同时提交当前条款版本、同意声明和合法访问确认 |
| `POST` | `/api/sources/:id/vote` | 匿名点赞 |
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

## 数据与隐私

- 导入的书源规则保存在 `DATA_DIR`，该目录默认被 Git 忽略。
- 原始 IP、城市和地理位置不会持久化或公开。
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
