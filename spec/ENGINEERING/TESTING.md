---
summary: 按变更选择验证边界，区分可重复检查、历史证据与未验证环境。
owns:
- testing.evidence
source:
- package.json
- playwright.config.ts
- scripts/e2e-api.mjs
- scripts/verify-storage-faults.py
- web/src/features/media/verify-media-auto-stop.mjs
- scripts/check-spec.mjs
tests:
- scripts/check-spec.test.mjs
---
# 测试与验证

测试证明一次具体行为，而不是为整个专题盖章。先从 [Spec 索引](../00_INDEX.md) 找到改动涉及的规则，结合专题 `tests` 选择能证明正常、错误和边界行为的最小范围；这些路径只是候选，不代表测试已运行或覆盖完备。

## 按改动选择

| 改动 | 最低有效验证边界 |
| --- | --- |
| 纯文档、措辞或普通配置文本 | 结构、引用和事实来源核对；不测试具体文字或可变配置值 |
| 文档校验器 | 临时目录中的有效文档、无效元数据、重复归属、缺失路径与链接，检查错误汇总 |
| 日期、奖励、数量和范围计算 | 注入时钟或直接值测试；台北跨日、跨月年、包含端点及非法输入 |
| 打卡、购买和权限 | 服务及真实 HTTP；次数、双币、奖励快照、授权撤销和业务拒绝条件 |
| 幂等、版本和结果未知 | 实际提交后原键重放、不同请求体冲突、版本变化与迟到响应；检查最终记录和账务 |
| 事务、锁、并发和恢复 | 同一临时数据库文件的独立连接主动竞争；检查记录、库存、钱包、流水和收据一起提交或回滚 |
| HTTP 和 OpenAPI | 实际 JSON、错误、空数组、整数、日期与 multipart 字节；生成类型一致性不能替代运行时协议验证 |
| 媒体 | 实际图片解码、EXIF、音频探测、文件目录及引用/清理竞争；不只检查 MIME 或客户端元数据 |
| 页面和交互 | 组件覆盖草稿、焦点、请求竞争与状态；受影响业务流程再做浏览器验证 |
| 发布及持久化 | 临时发布包、校验清单与重启；数据库、媒体和历史素材脱离旧发布目录后仍可使用 |

需要证明 WAL、文件锁、磁盘满或提交失败时，内存数据库与同一连接池的排队不足以证明结论。使用真实故障边界；只有受影响或尚有具体疑点时才运行这些较慢专项。

## 工程命令

命令在仓库根目录执行，完整定义以 `package.json` 为准：

| 命令 | 用途 |
| --- | --- |
| `npm run check:spec` | 检查当前 Spec、README 和 AGENTS 的结构与本地引用 |
| `npm run test:spec` | 文档校验器自身的测试 |
| `npm test` | Go、前端组件、部署脚本和文档工具的常规测试 |
| `npm run check` | 文档、Go 静态检查、OpenAPI 类型一致性及 TypeScript 检查 |
| `npm run test:go` / `npm run test:race` | Go 测试及竞态检查 |
| `npm run test:web` | 前端组件与状态逻辑测试 |
| `npm run test:deploy` | 构建校验清单、部署编排及发布脚本测试 |
| `npm run test:e2e` | 桌面 Chromium 和 iPhone 14 尺寸 WebKit 的浏览器流程 |
| `npm run build` | 类型检查和前后端构建 |
| `npm run verify` | 全面验证入口，含竞态检查、构建和浏览器流程 |

业务修改先写能失败的目标测试，再实现并运行所需检查。纯文档迁移通常只运行 `check:spec`，无需完整 `verify`。Vite 构建只证明可打包，TypeScript 与 OpenAPI 检查有各自职责。

Playwright 用独立 API、前端端口和临时数据库，不复用日常开发服务；配置入口是 `playwright.config.ts`。首次运行前执行 `npx playwright install chromium webkit`。端口冲突时使用隔离配置，不停止未知服务或复用其数据。

较慢专项按需运行：

```sh
node web/src/features/media/verify-media-auto-stop.mjs
python3 scripts/verify-storage-faults.py
```

录音专项使用 Chromium 实际编码和测试麦克风输入。磁盘专项在 macOS 自建的受限临时卷中制造空间不足和提交失败；结果只证明实际运行的平台与场景。

## 原型测试的承接

旧原型退出工程后，正式实现继续负责以下规则。迁移核对以现有测试源码为依据，不代表本次重新运行这些测试。

| 原型中有价值的规则 | 正式测试入口 |
| --- | --- |
| 台北日期、周月边界 | `internal/core/values_test.go`、`web/src/api/dates.test.ts` |
| 排期、次数、快照、编辑不发奖、删除回收及负余额 | `internal/checkin/service_test.go`、`internal/checkin/consistency_test.go` |
| 日周分组、空日、历史名称、任务满额与空状态 | `web/src/features/checkin/camp-week.test.tsx`、`web/src/features/checkin/task-status.test.tsx`、`web/src/features/checkin/checkin-components.test.tsx` |
| 统计按稳定身份与日期范围累计 | `internal/checkin/calendar_stats_test.go`、`web/src/features/reports/reports.test.tsx` |
| 双币购买、库存、永久物品去重及独立奖励订单 | `internal/shop/shop_test.go`、`internal/shop/shop_concurrency_test.go` |
| 货币图标、读屏名称和金额展示 | `web/e2e/currency-display.spec.ts`、`web/e2e/checkin-reward-quantity.spec.ts` |

原型只能证明本地演示状态。正式测试还需要证明权限、真实存储、并发和文件生命周期，不能用已删除原型的历史通过结果替代。

## 历史证据和验证限制

迁移前的阶段记录位于 Git 历史中的根任务清单。2026-10-29 的记录包含 Go 真实 SQLite、HTTP、竞态检查、前端组件、桌面 Chromium、390 CSS 像素 WebKit、真实媒体样本以及本机发布包冒烟。部分批次是全量失败后定向回归通过，不能汇总成当前全量通过；旧测试数量和本机日志也不是当前版本的验收凭据。

这些记录中的独立限制继续适用，直到有新的实际证据：

- 生产 HTTPS、Linux systemd、服务器权限和真实网络入口需要在实际部署环境检查；本机脚本测试不等于生产部署完成。
- 早期带 `dirty` 标记的包只证明当时工作区；发布身份以实际 `release.json` 和对应冒烟记录为准。
- WebKit 设备尺寸模拟与假麦克风录音不能证明 iPhone 硬件、软键盘、来电中断或真机多指手势。
- 小岛隐藏动画的可见性事件模拟不能证明操作系统真实后台行为。

备份与从备份恢复是已取消的产品范围，真机验收不在既定范围；它们不作为待完成任务。重启持久化、事务回滚、上传和清理中断恢复仍属于现有行为，不能由“未提供备份”推导为无需验证。

人物与固定穿戴改造的旧数据处理范围见 [商店专题](../FEATURES/SHOP.md#素材与兼容边界)，其中明确不提供的兼容与转换能力不列为待验证项。现有数据库历史校验和不兼容时拒绝启动仍按 [存储专题](../SYSTEM/STORAGE.md#迁移与兼容)验证。

完成说明记录本次实际命令、环境、结果及未验证项即可。不要重新建立逐阶段任务账本；规则归专题，具体执行证据归变更说明。
