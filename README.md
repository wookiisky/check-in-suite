# 小小成长岛

小朋友日常任务打卡网站。正式工程采用 Go、React / TypeScript 和 SQLite；`design/` 保留卡通森林冒险风格的可点击静态原型。

## 正式工程开发环境

正式实现按 [开发计划](tasks.md) 分阶段交付，实际验收证据记录在计划末尾。账户使用真实服务端会话，原型数据不会导入正式数据库。设计依据见 [技术方案](docs/tech.md)。本轮按确认范围不开发备份、不做真机验证。

开发工具基线：

| 工具 | 版本或要求 |
| --- | --- |
| Go | 1.27.0，依赖锁定在 `go.mod` / `go.sum` |
| Node.js | 24.20.0，版本文件为 `.node-version`；允许同一主版本的后续补丁 |
| npm | 11.x，本次使用 11.19.0；根目录维护唯一 `package-lock.json` |
| ffprobe | 来自 FFmpeg，须可从 PATH 调用，或在配置中填写可执行文件路径 |
| Python | 仅预览 `design/` 原型需要 Python 3 |

在项目根目录执行：

```sh
npm ci
go mod download
npm run db:migrate
go run ./cmd/island init -config config/app.example.yaml
npm run dev
```

打开 <http://127.0.0.1:5173>，使用初始化时设置的账户登录。Go 服务监听 `127.0.0.1:8080`，Vite 将 `/api/v1` 与 `/health` 代理到它。按 Ctrl+C 停止开发服务。

`init` 交互读取用户名、姓名和两种密码（分别确认），终端输入密码时不回显；已有账户时拒绝再次初始化。正式安装只有一个账户、零余额和默认角色，没有示例任务、成绩或订单。密码为 10–128 个 Unicode 码点。忘记密码时在服务器本机执行：

```sh
go run ./cmd/island reset-password -kind login -config config/app.example.yaml
go run ./cmd/island reset-password -kind management -config config/app.example.yaml
```

命令读取新密码和确认值，不通过参数传递密码。重置任一密码都会撤销全部会话。网页管理页仍可用对应旧密码修改密码；离开管理页即锁定，再次进入必须重新输入管理密码。

默认使用 `config/app.example.yaml`，数据库和私有目录位于项目根目录的 `.local/`，不进入 Git。配置中的相对路径以**启动命令的工作目录**为基准，因此这些命令均须从项目根目录执行。SQLite 必须位于本机磁盘，不能放入同步盘或共享网络盘。

迁移通过维护命令显式执行，服务启动时只检查版本，不自动修改结构。迁移建立账户、会话与业务表；再次执行不会重复应用，已应用迁移的内容改变会报错。后续结构变更只能增加新的编号 SQL 文件。

需要调整端口或路径时，复制示例为已忽略的本地配置：

```sh
cp config/app.example.yaml config/app.local.yaml
# 编辑本地配置后，在两个终端分别运行：
go run ./cmd/island migrate -config config/app.local.yaml
go run ./cmd/island serve -config config/app.local.yaml
ISLAND_API_TARGET=http://127.0.0.1:8080 npm run dev:web
```

最后一条命令中的地址应与本地配置的 Go 监听地址一致。`public_origin` 必须与浏览器访问的来源一致，默认 `http://127.0.0.1:5173`；更换访问地址或端口时同时修改，否则写请求会被拒绝。业务时区固定为 `Asia/Taipei`，不受开发机器时区影响。

## 正式工程检查与构建

首次运行浏览器测试前安装项目锁定版本对应的浏览器：

```sh
npx playwright install chromium webkit
npm run verify
```

`verify` 包括原型检查、Go 静态检查与竞态测试、前端组件测试、独立类型检查、前后端构建和浏览器联通检查。也可按修改范围分别运行：

| 命令 | 用途 |
| --- | --- |
| `npm run test:go` | Go 测试，包括真实文件 SQLite |
| `npm run test:race` | Go 竞态检测 |
| `npm run check:go` | `go vet` 静态检查 |
| `npm run test:web` | Vitest / React Testing Library 组件测试 |
| `npm run typecheck` | OpenAPI 生成类型一致性和 TypeScript 严格检查 |
| `npm run test:e2e` | 桌面 Chromium 与 iPhone 14 尺寸的 WebKit 联通检查 |
| `npm run build` | 类型检查后构建 `web/dist/` 与 `.local/bin/island` |
| `npm run api:generate` | 从 `api/openapi.yaml` 生成前端类型 |

Playwright 自动启动独立测试服务，使用 18080 / 15173 端口、临时数据库和专用测试账户，正常退出时清理临时文件；不会复用日常开发服务。本轮验证桌面 Chromium 与 390 px WebKit 模拟环境，不声明 iPhone 真机兼容性。

接口类型由 [openapi-typescript](https://openapi-ts.dev/cli) 生成，不直接编辑 `web/src/api/schema.d.ts`。新增或修改接口后运行 `npm run api:generate`，并补充实际 HTTP 响应测试。OpenAPI 描述完整业务契约，接口定义不代表对应功能已经验收。

Go 服务可从 `static_directory` 提供前端构建产物，私有素材安装到 `assets_directory` 后经登录访问。生产 HTTPS 与部署模板在交付阶段验证，具体生产入口另行指定。

## 静态原型预览

在项目根目录运行：

```sh
npm start
```

打开 <http://127.0.0.1:4173>。根目录命令会启动 `design/` 中的静态原型。需要 Python 3；页面没有构建步骤或第三方运行依赖。请通过 HTTP 访问，直接双击 HTML 无法正常加载 JavaScript 模块。

首次默认进入示例营地，右上角姓名按钮可退出并查看登录页：

| 项目 | 演示值 |
| --- | --- |
| 用户名 | `island` |
| 登录密码 | `1234` |
| 管理密码 | `8888` |

这是本地交互演示。数据使用当前浏览器的 localStorage，页脚“重置演示”恢复初始示例。示例日期按 `Asia/Taipei` 生成，重置会以当天生成记录。浏览器中的密码验证不构成正式身份认证。

## 文档与设计图

- [产品描述与交互规则](docs/product.md)
- [技术方案](docs/tech.md)
- [桌面首页](design/previews/home-desktop.jpg)
- [手机首页](design/previews/home-mobile.jpg)
- [桌面周视图](design/previews/week-desktop.jpg)
- [手机周视图](design/previews/week-mobile.jpg)
- [月历](design/previews/calendar-desktop.jpg)
- [统计](design/previews/stats-desktop.jpg)
- [商店](design/previews/shop-desktop.jpg)
- [登录](design/previews/login-desktop.jpg)

图片支持本地选择与预览，每张上限 2 MB。录音使用最长 60 秒的模拟计时，支持停止、重录、移除与示例音试听，不采集真实麦克风声音。打卡弹窗中的“设计预览”可演示设备不可用、录音失败、提交失败和重试。背景音乐为用户主动开启的合成旋律。

原型不包含服务端、真实附件上传、跨设备同步或公开部署。

## 本轮界面调整

- 全应用改为便于稍远距离阅读的大字布局：主要文字 22–24 像素，标题 32–40 像素，辅助文字至少 18 像素，按钮目标至少 56 × 56 像素。手机保持字体大小，月历、统计、商店、管理页面及弹窗同步调整。
- 今日可打卡卡片仅保留大图标、名称、金币和钻石奖励，整卡点击；达到每日次数上限后移除，删除记录释放次数后重新出现，多次任务未达到上限时继续保留。完成记录仍在上方展示。
- 普通日、周、月历中的已完成记录，以及普通记录详情和编辑弹窗不显示金币、钻石分值；待打卡任务仍显示奖励，管理记录和删除确认保留奖励信息。
- 日视图只展示单日记录，通过前一天、后一天和今天切换，不放周日期条。周视图在桌面以周一至周日七列直接展示记录，在手机以七天纵向分组展示，空日期也保留，无需逐日点击。
- 桌面周记录区可跨页面宽度，下方今日任务与角色区保持左右布局。图标、金币和钻石使用彩色实心卡通 SVG，并精简欢迎语、宣传内容及重复说明。

## 检查

需要支持 `node:test` 的 Node.js，当前环境使用 Node.js 24：

```sh
npm test
npm run check
```

领域测试覆盖日期边界、每日次数、历史奖励快照、编辑不重复发奖、删除回收与负余额、统计归并、双币购买、库存及装扮去重。

浏览器已验证打卡失败重试、日历历史只读、姓名修改、任务新增、管理密码错误与解锁、商店双币兑换与换装、登录以及桌面与手机布局。真实录音兼容性、服务端权限、并发库存与持久存储尚未实现，也未作为本阶段验证结论。

## 文件组织

正式工程与设计原型分别组织，根目录的 `npm start`、`npm test` 和 `npm run check` 继续操作原型。

- `cmd/island/`：Go 服务与迁移命令入口。
- `internal/config/`、`internal/storage/`、`internal/httpapi/`：配置、SQLite 和健康检查。
- `migrations/`：随 Go 程序嵌入的编号 SQL 迁移。
- `config/app.example.yaml`：可直接运行的本地开发配置。
- `api/openapi.yaml`：已实现的接口契约。
- `web/`：React / TypeScript 工程、组件测试及浏览器测试。
- `scripts/e2e-api.mjs`、`playwright.config.ts`：独立测试服务与浏览器测试配置。

- `docs/product.md`：产品描述与交互规则。
- `design/index.html`：静态原型入口。
- `design/config/content.mjs`：界面文案、示例任务、商品与账户配置。
- `design/src/app.mjs`：页面渲染与交互。
- `design/src/domain.mjs`：日期、打卡、统计与兑换规则。
- `design/src/seed.mjs`：示例数据生成。
- `design/src/icons.mjs`、`design/assets/`：本地图标与卡通 SVG 插画。
- `design/styles.css`：统一视觉、响应式布局及减少动效支持。
- `design/tests/`：原型测试，包含领域规则测试。
- `design/previews/`：桌面与手机界面预览图。
