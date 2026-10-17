# Web API 契约

更新时间：2026-10-17

本文是当前正式链路 `frontend -> scripts/local-server.mjs -> site/worker -> SQLite` 的迁移期契约。接口仍由模块化单体提供，本文不引入第三步的服务端领域拆分。

## 1. 通用约定

### 成功响应

所有 JSON 成功响应统一为：

```json
{
  "data": {},
  "request_id": "uuid"
}
```

`data` 保留接口原有业务字段。迁移期客户端仍接受未包装的旧成功响应。

### 失败响应

```json
{
  "error": {
    "code": "stale_version",
    "message": "数据已变化，请刷新后重试",
    "details": {
      "legacy_code": "calendar_changed"
    }
  },
  "request_id": "uuid"
}
```

响应头 `X-Request-ID` 与 body 中的 `request_id` 必须一致。服务端意外异常只记录请求 ID 和异常类型，不把内部错误或敏感字段返回给客户端。旧 `{ detail: { code, message } }` 只作为迁移输入兼容格式。

### 错误分类

| HTTP | 稳定 code | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| 400 | `request_failed` 或 `validation_error` | 请求格式、路径或参数不合法 | 修正请求，不自动重试 |
| 401 | `unauthorized` | 未登录、令牌失效或邮箱会话失效 | 清理对应会话并回到登录流程 |
| 403 | `forbidden` | 身份有效但无权限 | 展示权限结果，不重试 |
| 404 | `not_found` | 资源或路径不存在 | 刷新资源或提示不可用 |
| 409 | `conflict` / `stale_version` | 状态冲突或版本过期 | 重新读取后由用户确认 |
| 422 | `validation_error` | 字段校验失败 | 展示字段错误，不重试 |
| 429 | `rate_limited` | 频率限制 | 按响应提示等待后再试 |
| 503 | `dependency_unavailable` | 邮件、推送等依赖不可用 | 可延迟重试，避免立即循环 |
| 500 | `server_error` | 未预期服务端异常 | 使用 `request_id` 定位后有限重试 |

### 请求、缓存和敏感数据

- JSON 请求使用 `Content-Type: application/json`；认证使用 `Authorization: Bearer <token>`，邮箱运行时另外使用受保护的 HttpOnly Cookie。
- API JSON 默认 `Cache-Control: no-store`；`.ics` 使用其原有 `text/calendar` 响应；静态资源继续按构建产物规则缓存。
- 除日历订阅 token 外，URL 不放访问令牌、密码、验证码或邮箱会话。日志不得输出 token、密码、验证码、Cookie、SMTP 配置或完整邮箱地址。
- GET 只读；修改接口使用 POST、PATCH 或 DELETE。客户端不得因为超时就无条件重放非幂等请求。
- 带 `expected_version`、`version` 或 `If-Match` 语义的修改必须在冲突后重新读取；服务端使用 CAS/事务保证并发安全。

## 2. 领域接口

下表记录正式 Worker 路由；请求字段以当前实现为准，未列出的可选字段不得由客户端依赖。

### health

| 方法 | 路径 | 权限 | 成功 data | 错误/重试 |
| --- | --- | --- | --- | --- |
| GET | `/health` | 公开 | `runtime`、`storage`、版本/能力标记 | 503 可延迟重试；不缓存 |

### auth

| 方法 | 路径 | 权限 | 请求字段 | 成功 data | 幂等/并发 |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/register` | 公开或迁移期邮箱门禁 | `username`、`password`、`nickname` | `access_token`、`member`、宿舍信息或脱敏结果 | 重复注册返回等价结果；不重放密码 |
| POST | `/auth/login` | 公开 | `username`、`password` | `access_token`、`member`、宿舍信息 | 受 429 限流；失败不暴露账号存在性 |
| POST | `/auth/logout` | Bearer，可接受过期令牌 | 无 | `ok` | 幂等；撤销服务端会话 |
| GET | `/auth/me` | Bearer | 无 | 当前用户、成员和权限 | 只读，可重试 |
| PATCH | `/auth/me` | Bearer | 当前实现允许的资料字段 | 更新后的用户 | 非幂等字段更新需避免重复提交 |

### guest

| 方法 | 路径 | 权限 | 请求/查询字段 | 成功 data | 幂等/并发 |
| --- | --- | --- | --- | --- | --- |
| POST | `/guest/create` | 游客；邮箱门禁开启时需邮箱会话 | `name`、`nickname`、可选 `members` | `access_token`、`invite_code`、`member_id`、`dorm` | 创建操作不保证幂等；超时不要盲重试 |
| POST | `/guest/recover` | 恢复凭证 | `invite_code`、`recovery_code` | 新会话及宿舍信息 | 恢复凭证一次性/受状态约束 |
| GET | `/guest/dorm` | 游客 token 或邀请码 | `invite_code` | 脱敏宿舍概要 | 只读；不得暴露成员名单 |
| GET | `/guest/tasks` | 游客 token/成员参数 | `invite_code`、`member_id` | 今日任务与只读权限标记 | 只读，可重试 |

### dorms

| 方法 | 路径 | 权限 | 请求字段 | 成功 data | 并发 |
| --- | --- | --- | --- | --- | --- |
| POST | `/dorms` | Bearer | 宿舍名称及成员配置 | 宿舍、成员、版本 | 创建不保证幂等 |
| POST | `/dorms/join` | Bearer | `invite_code`、成员信息 | 当前宿舍和成员 | 成员加入受事务保护 |
| GET | `/dorms/current` | Bearer | 无 | 宿舍、成员、`version` | 只读 |
| PATCH | `/dorms/current` | 创建者 Bearer | 宿舍配置字段、版本字段 | 更新后的宿舍 | CAS；冲突返回 409 |
| GET/POST | `/dorms/recovery` | Bearer | POST 可带 `expected_version` | GET 恢复信息；POST 恢复凭证 | 版本冲突返回 `stale_version` |
| POST | `/dorms/current/leave` | Bearer | 版本字段（如适用） | 更新后的成员/宿舍 | 事务保护；重复离开按当前状态处理 |
| DELETE | `/dorms/current/members/:id` | 创建者 Bearer | 路径成员 ID、版本字段 | 更新后的成员列表 | CAS；不允许越权 |
| POST | `/dorms/current/transfer-admin` | 创建者 Bearer | 目标成员 ID、版本字段 | 更新后的权限 | CAS；不可盲重试 |
| POST | `/dorms/current/invite-code/rotate` | 创建者 Bearer | 版本字段（如适用） | 新邀请码 | 成功后旧邀请码失效 |

### duties

| 方法 | 路径 | 权限 | 请求字段 | 成功 data | 并发/重试 |
| --- | --- | --- | --- | --- | --- |
| GET | `/duties`、`/duties/today` | Bearer | 查询/日期参数 | 任务、轮次、完成状态 | 只读 |
| POST | `/duties/generate`、`/duties/regenerate` | 创建者 Bearer | 模式、日期和配置 | 计划/任务及版本 | 事务；版本冲突不重试 |
| POST | `/duties/preview` | 创建者 Bearer | 计划配置 | 预览任务 | 只读计算，可重试 |
| POST | `/duties/custom` | 创建者 Bearer | 自定义任务字段 | 新任务 | 成功后不要自动重放 |
| PATCH | `/duties/:id` | 创建者 Bearer | 任务字段、版本 | 更新任务 | CAS |
| DELETE | `/duties/:id` | 创建者 Bearer | 版本字段 | 删除结果 | CAS |
| PATCH | `/duties/:id/complete` | 成员/创建者 Bearer | 完成字段、版本 | 完成记录和下一状态 | 事务幂等；重复提交安全 |

### chores / calendar

| 方法 | 路径 | 权限 | 请求字段 | 成功 data | 缓存/重试 |
| --- | --- | --- | --- | --- | --- |
| POST | `/chores/claim` | 游客或邮箱会话 | `invite_code`、`nickname` | 成员会话、成员信息 | 绑定身份有状态；不盲重试 |
| GET | `/chores/activity`、`/chores/board`、`/chores/history` | 成员 Bearer/受限查询 | 日期、邀请码等查询字段 | 活动、看板、历史 | 只读；不缓存敏感数据 |
| GET | `/chores/calendar/:token.ics` | 订阅 token | 无 | 原始 `text/calendar` | 不做 JSON envelope；客户端按日历缓存策略处理 |
| POST | `/chores/calendar-subscription` | 成员 Bearer | `version`、`include_alarms` | 订阅路径、版本、设置 | CAS；生成新订阅 token |
| GET/PATCH | `/chores/reminder-plan` | 成员/创建者 | 计划字段、版本 | 提醒计划 | CAS；依赖不可用时返回 503 |
| GET/POST | `/chores/native/*`、`/chores/push/*` | 对应成员/设备凭证 | 设备或订阅字段 | 配置、注册或发送结果 | 注册需幂等；发送不盲重试 |
| PATCH | `/chores/order`、`/chores/settings`、`/chores/marker` | 成员/创建者 | 设置、排序、标记及版本 | 更新后的配置/标记 | CAS |
| PATCH | `/chores/tasks/:id/complete`、`/chores/tasks/:id/undo` | 成员 Bearer | 版本字段 | 任务状态 | 完成/撤销可重复调用，状态反向恢复 |
| POST | `/chores/remind` | 有权限成员 | 目标、任务及版本字段 | 提醒记录/排队结果 | 幂等键防重复通知 |
| PATCH | `/chores/reminders/:id/read` | 目标成员 | 无 | 已读状态 | 幂等 |

### notifications / push

| 方法 | 路径 | 权限 | 请求字段 | 成功 data | 重试 |
| --- | --- | --- | --- | --- | --- |
| GET | `/notifications` | Bearer | 分页/状态参数 | 通知列表及游标 | 只读 |
| PATCH | `/notifications/:id/read` | Bearer | 无 | 通知状态 | 幂等 |
| GET | `/push/public-key` | 公开 | 无 | 公钥 | 可缓存短时间，不含敏感数据 |
| POST | `/push/subscribe` | Bearer | Web Push 订阅 | 设备记录 | 幂等注册；不记录私钥 |
| POST | `/push/unsubscribe` | Bearer | 订阅标识 | 删除结果 | 幂等 |
| POST | `/push/test` | Bearer | 设备/测试字段 | 排队结果 | 依赖失败可 503，避免循环重试 |

### email

邮箱接口由本地 Node 邮箱 runtime 包装 Worker API；成功 JSON 同样遵循 envelope，邮箱会话使用 HttpOnly Cookie。

| 方法 | 路径 | 权限 | 请求字段 | 成功 data | 错误 |
| --- | --- | --- | --- | --- | --- |
| GET | `/email/config` | 公开 | 无 | 邮箱能力与注册策略 | 只读 |
| GET | `/email/me` | 邮箱 Cookie | 无 | 邮箱账户、房间和偏好 | 会话失效 401 |
| GET | `/email/operations` | 邮箱 Cookie | 无 | 可用操作及能力 | 只读 |
| POST | `/email/code` | 公开/来源校验 | `email` | `challenge_id`、过期时间 | 422、429、503；验证码不写日志 |
| POST | `/email/verify` | 公开 | `email`、`challenge_id`、`code`、可选偏好 | 邮箱会话与账户 | 失败 401/422/429 |
| POST | `/email/logout` | 邮箱 Cookie | 无 | `ok` | 幂等 |
| POST | `/email/bind` | 邮箱 Cookie | `member_token` | 绑定身份 | 冲突 409；不盲重试 |
| POST | `/email/enter` | 邮箱 Cookie | `dorm_id`、可选成员凭证 | 成员会话 | 无权限 403 |
| POST | `/email/unbind` | 邮箱 Cookie/创建者权限 | `dorm_id`、`member_id` | 解绑结果 | 冲突 409；CAS |
| POST | `/email/preferences` | 邮箱 Cookie | `mail_enabled` | 更新后的偏好 | 幂等 |
| POST | `/email/test` | 邮箱 Cookie | 无 | 排队/发送结果 | 429/503 可延迟重试 |

### docs/openapi

| 方法 | 路径 | 权限 | 成功 data | 缓存 |
| --- | --- | --- | --- | --- |
| GET | `/openapi.json` | 公开 | OpenAPI 文档或 JSON 描述 | 可短时间缓存；不得包含密钥 |
| GET | `/docs/openapi` | 公开 | 文档入口/静态说明（若启用） | 按静态资源策略缓存；不得包含密钥 |

## 3. 前端 Client 约定

`frontend/src/api/client.ts` 是唯一底层 HTTP Client：

- 默认超时 15 秒；合并外部 `AbortSignal`，主动取消保持 `AbortError`。
- 只解析 JSON Content-Type；非 JSON 响应不强行 envelope 化。
- `ApiError` 固定保留 `status`、`code`、`details`、`requestId`、`message`。
- 优先使用 `X-Request-ID`，缺失时读取 body `request_id`。
- 401 在受保护请求和认证流程中清理会话并派发 `auth-expired`；登录本身不误清理。
- 网络异常更新统一 `networkState`，区分离线和服务不可达。
- 领域 API 保留原导出路径，由薄封装调用 Client；页面不直接调用 `fetch`。

## 4. 版本与迁移

本契约第二步只统一传输层，不拆分服务端领域。新增字段必须向后兼容；删除字段或改变语义需要先更新客户端和契约测试。旧直接成功响应及 `{ detail: { code, message } }` 错误在迁移期继续可读，稳定 `code` 和 HTTP 状态是业务分支依据，中文 `message` 只用于展示。