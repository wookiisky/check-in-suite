---
summary: HTTP 请求、认证边界、错误处理、幂等重试及版本冲突的公共协议。
owns:
- http.protocol
source:
- api/openapi.yaml
- internal/httpapi/application.go
- internal/httpapi/request_fields.go
- internal/httpapi/request_transport.go
- internal/httpapi/account_routes.go
- internal/idempotency/idempotency.go
- web/src/api/client.ts
tests:
- internal/httpapi/application_test.go
- internal/httpapi/checkins_required_fields_test.go
- internal/httpapi/same_origin_test.go
- internal/httpapi/same_origin_proxy_test.go
- internal/httpapi/timeouts_test.go
- internal/checkin/replay_limits_test.go
- internal/checkin/delete_replay_test.go
- web/src/api/client.test.ts
- web/e2e/config-conflict.spec.ts
---
# HTTP API

## 权威入口与调用方

浏览器通过 `/api/v1` 调用服务，完整路径、字段、必填项和值域由 OpenAPI 定义。前端类型从该文件生成，不手工维护另一份接口表。Spec 说明跨端语义；各业务专题维护对应行为，接口定义本身不证明功能已经验收。

JSON 使用 `snake_case`。普通请求必须是单个 JSON 对象并声明 `application/json`；未知字段、多段 JSON 和非法类型均拒绝。需要区分零值、缺省和清空的接口显式检查字段存在性，只接受该路由允许的 `null`。上传采用 `multipart/form-data`，其体积和内容校验见 [媒体](../FEATURES/MEDIA.md)。

整数必须在 JavaScript 可精确表示的范围内，奖励、价格等额外限制由服务配置和业务服务执行。文本作为纯文本处理。金额、时间和快照语义见 [数据与一致性](STORAGE.md)。

## 登录、来源与权限

登录建立不透明 Cookie 会话，浏览器不在 localStorage 保存密码或登录 token。Cookie 使用 `HttpOnly` 和 `SameSite=Lax`；TLS 请求或回环代理明确传入 HTTPS 时设置 `Secure`，普通远端客户端的转发协议头不能改变这一判断。

服务通过 Fetch Metadata 或 Origin 与 Host 判断同源，不要求固定配置站点地址。登录同样检查来源；已登录写请求另需会话绑定的 `X-CSRF-Token`。缺少浏览器来源头不会免除密码、会话和 CSRF 校验。

普通与管理路由在服务端确定权限，客户端不能传入管理标志切换权限。会话有效期、凭据版本和管理授权的事务内复核见 [账户](../FEATURES/ACCOUNT.md)。权限校验先于幂等结果读取；过期会话或已撤销授权不能靠旧请求键取回受保护结果。

## 幂等与结果恢复

可能重复创建事实的命令使用 `Idempotency-Key`。一次明确提交生成一个键并保存原始请求；网络失败或结果未知时，用原键与原请求核对，不用编辑后的草稿替代原请求。

服务按账户、操作和键识别请求，并以规范化业务输入、操作与 API 版本计算摘要。同键不同输入返回 `IDEMPOTENCY_CONFLICT`。成功收据与业务结果同事务提交；失败事务不留下可重放的成功。已成功请求在权限通过后先重放，再考虑今天、现价等可能变化的条件。

| 客户端观察 | 后续动作 |
| --- | --- |
| 收到明确的业务拒绝 | 保留草稿，修正输入或重新确认后以新键提交。 |
| 断网、超时或响应丢失 | 保留原键与原始请求，先恢复结果；关闭弹窗或取消前端请求不等于服务端撤销。 |
| 核对时登录或管理授权失效 | 恢复授权后继续核对原请求。 |
| 已成功，但后续读取失败 | 只重试读取，不再次创建业务事实。 |
| 已成功，用户又修改草稿 | 按原资源 ID 编辑；另建记录或另买一份需要新的明确操作。 |

幂等保证资源身份和经济事实不重复，不保证可变响应内容逐字相同。打卡重放保留原经济收据，同时读取当前记录；已删除记录返回删除状态，不能恢复记录或再发奖励。原收据里的余额只是当时的事务快照，客户端仍需刷新最新数据。打卡特有的草稿与反馈行为见 [打卡](../FEATURES/CHECKIN.md)。

## 并发与版本

需要防止覆盖的编辑携带 `expected_version`，例如资料、记录、任务配置和完整小岛布局。服务器在事务内比较当前版本，冲突返回 `VERSION_CONFLICT`，可附 `current_version`。

客户端保留草稿并读取最新状态，由用户选择加载新值或明确按草稿再次保存。仅悄悄替换版本号不算确认；读取失败或再次冲突时不能直接覆盖。

偏好只修改请求指定字段，部分装备操作按指定槽位或单件物品更新，采用后提交生效；它们不借用账户资料版本。各端点的并发单位以 OpenAPI 和 [商店](../FEATURES/SHOP.md)、[小岛](../FEATURES/ISLAND.md) 为准。

## 错误与请求身份

每个请求分配独立的 `X-Request-ID`。错误体包含机器可读的 `code`、`field_errors` 和 `request_id`，按需提供当前版本。界面从文案资源映射消息，不解析服务端错误文字；内部路径、SQL 和凭据不进入公开错误。

| 响应类别 | 处理原则 |
| --- | --- |
| `400` / `422` 输入或业务校验失败 | 定位字段或约束，保留可修改内容。 |
| `401 SESSION_REQUIRED` | 清除失效登录状态，重新登录后恢复允许保留的草稿。 |
| `403` 权限、历史只读、来源或 CSRF 拒绝 | 不执行修改；按错误原因恢复授权或修正请求。 |
| `404` 资源不存在或不可读 | 刷新相关列表，不假定旧对象仍存在。 |
| `409` 版本、日期、次数、库存、余额或幂等冲突 | 刷新相关事实并重新确认，不盲目重试冲突。 |
| `413` / `415` 媒体大小或类型不符 | 更换附件，保留其他内容。 |
| `429` 密码失败限速 | 遵循 `Retry-After`，稍后重试。 |
| `503 DATABASE_BUSY` / `STORAGE_UNAVAILABLE` | 保留原提交信息，待锁或存储故障解除后恢复请求。 |
| `500 INTERNAL_ERROR` | 保留请求 ID 供排查；写入结果未知时仍按原请求核对。 |

登录密码错误是 `401 INVALID_CREDENTIALS`；已登录后的解锁、修改密码或奖励兑现密码错误使用 `422 INVALID_CREDENTIALS`，不应因此清除正常登录与表单。

普通 JSON 与上传有各自的请求期限，服务同时限制处理上下文和套接字读写。API 响应使用 `Cache-Control: no-store`；私有媒体与素材仍通过各自受保护路由读取。

## 分页与日期

列表使用稳定游标，调用方持续读取后续页才能宣称结果完整。默认和最大数量、日期范围限制由具体接口约束；日周记录、月历与统计的归组口径见 [打卡与查询](../FEATURES/CHECKIN.md)。

会话与营地返回的服务端时间、业务日期和时区为页面日期依据。跨日提交由服务端再次判断；同一屏中的多个加载请求需丢弃过期响应，不能让迟到结果覆盖新的日期或状态。
