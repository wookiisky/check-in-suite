# 成长岛

小朋友日常任务打卡网站。正式工程采用 Go、React / TypeScript 和 SQLite；`design/` 保留卡通森林冒险风格的可点击静态原型。

## 正式工程开发环境

正式实现按 [开发计划](tasks.md) 分阶段交付，实际验收证据记录在计划末尾。账户使用真实服务端会话，原型数据不会导入正式数据库。设计依据见 [技术方案](docs/tech.md)。本轮按确认范围不开发备份、不做真机验证。

正式功能包括今日打卡、历史补录、双币钱包、商店与装扮、奖励兑现、照片与录音、日周月记录、统计及家庭留言。用户文案来自配置资源；业务日期固定为台北时间。普通页面只能编辑今天，历史纠正在管理页面执行；删除回收原奖励，允许负余额且保留已经购买的物品。

成就支持次数、打卡天数、按任务排期连续完成、累计金币和钻石，可限定类别、任务及任意连续自然日窗口。主界面在形象下展示所选徽章，独立成就页负责查看和佩戴，管理页配置规则。删除打卡记录会重算资格并卸下失效成就；删除任务配置保留历史贡献。具体规则见 [成就与徽章](docs/product.md#14-成就与徽章)。

装扮区支持单选背景和整体形象、最多 10 件可编辑饰品，以及可同时佩戴的下雪、闪光特效。饰品可以移动、等比缩放、逐层上移或下移，并放到角色后方；特效固定覆盖画布，只能佩戴或移除。布局保存后在主页与衣柜一致展示，减少动效时改用静态特效。素材仅从内置目录选择。具体规则见 [角色、商店与奖励](docs/product.md#7-角色商店与奖励)。

小岛页面采用独立全屏的固定斜俯视二维卡通场景，提供返回来源页的按钮，支持平移、缩放、布置保存与角色自主活动。活动和布置工具直接放在画面内，桌面使用侧边面板、手机使用底部抽屉，界面字号不随场景缩放。房屋在角色进入时原地展示内部。商店的小岛建设物品支持按定义购买多件，同一物品可以同时用于画像和小岛；展示、动画和互动能力可逐步追加。任务管理可关联阅读、运动和玩球；当天完成任一关联任务一次即可解锁对应活动，台北次日重置。未关联任务的活动保持开放，散步和休息不受限制。参见 [小岛建设与角色活动](docs/product.md#15-小岛建设与角色活动)。

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

`init` 交互读取用户名、姓名和两种密码（分别确认），终端输入密码时不回显；已有账户时拒绝再次初始化。正式安装建立一个账户、零余额、默认角色与免费基础小岛，并提供可购买的小岛建设商品；没有示例任务、成绩或订单。密码为 10–128 个 Unicode 码点。忘记密码时在服务器本机执行：

```sh
go run ./cmd/island reset-password -kind login -config config/app.example.yaml
go run ./cmd/island reset-password -kind management -config config/app.example.yaml
```

命令读取新密码和确认值，不通过参数传递密码。重置任一密码都会撤销全部会话。网页管理页仍可用对应旧密码修改密码；离开管理页即锁定，再次进入必须重新输入管理密码。

默认使用 `config/app.example.yaml`，数据库和私有目录位于项目根目录的 `.local/`，不进入 Git。配置中的相对路径以**启动命令的工作目录**为基准，因此这些命令均须从项目根目录执行。SQLite 必须位于本机磁盘，不能放入同步盘或共享网络盘。

迁移支持在历史文件名称和校验值一致时追加新版本；旧建表脚本已被修改的数据库不提供兼容转换。`npm run db:migrate` 执行基础建表脚本，直接建立账户、会话与完整业务表；再次执行不会重复建表。服务启动时只检查结构版本，不自动修改结构；已有数据库的脚本校验不一致时仍会报错。

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
| `npm run release` | 生成带提交号、版本和文件校验值的独立发布目录 |

Playwright 自动启动独立测试服务，使用 18080 / 15173 端口、临时数据库和专用测试账户，正常退出时清理临时文件；不会复用日常开发服务。本轮验证桌面 Chromium 与 390 px WebKit 模拟环境，不声明 iPhone 真机兼容性。

接口类型由 [openapi-typescript](https://openapi-ts.dev/cli) 生成，不直接编辑 `web/src/api/schema.d.ts`。新增或修改接口后运行 `npm run api:generate`，并补充实际 HTTP 响应测试。OpenAPI 描述完整业务契约，接口定义不代表对应功能已经验收。

Go 服务可从 `static_directory` 提供前端构建产物，私有素材安装到 `assets_directory` 后经登录访问。生产 HTTPS 与部署模板在交付阶段验证，具体生产入口另行指定。

## 测试账户与完整示例数据

在尚未建立账户的本地数据库执行：

```sh
npm run db:seed
npm run dev
```

用户名为 `user`，登录密码和管理密码均为 `pass`。测试初始化入口单独允许此短密码，正式配置和修改密码仍遵循原有长度限制。当前目录生成 28 个任务、56 件商品和 12 个成就，覆盖全部 96 项内置素材，并提供最近 30 天的 90 笔打卡、12 笔购买、双币流水、已佩戴装扮、小岛布置及留言。示例内容维护在 `internal/demo/settings.json`，素材新增时按目录用途生成对应定义。

初始化在同一事务提交账户、业务数据和完成标记；重复执行会跳过，保留后续编辑。已有正式账户或业务数据时拒绝写入。此命令不会清空日常数据库，发布时可明确选择重置后再导入。

自定义配置时先运行 `island migrate -config <配置>`，再运行 `island seed-demo -config <配置>`。`npm run db:status` 可只读检查默认数据库；直接使用 `island db-status -config <配置>` 得到 JSON 状态，不会创建不存在的数据库。

## 部署与维护

[运行手册](docs/operations.md) 包含构建、单实例部署、初始化、密码找回、结构版本检查、媒体清理、容量及数据库一致性检查。发布产物只需要 Go 二进制、前端静态文件和 `ffprobe`，运行时不需要 Node.js。

```sh
npm run release
# 在输出的发布目录内查看构建版本：
./island version
```

也可使用 SSH 部署入口，在提示中输入服务器 IP、SSH 端口、用户和安装目录：

```sh
npm run deploy
# 或显式填写连接信息；远程发布仍会交互询问数据库和测试数据选项。
npm run deploy -- --host 192.0.2.10 --port 22 --user deploy
# 仅构建上传，稍后按输出命令在服务器发布：
npm run deploy -- --host 192.0.2.10 --port 22 --user deploy --upload-only
```

支持 Linux amd64 / arm64，远程需要 systemd、Bash、ffprobe、curl、sha256sum、flock，以及 root 或 sudo 权限。脚本自动构建、上传和校验，并运行发布包内的 `deploy/publish.sh`。首次发布默认监听 `0.0.0.0:38100`，访问来源询问默认使用 `http://SSH地址:38100`，回车采用，也可改填域名或 HTTPS 来源；已有服务器配置继续沿用。HTTPS 入口和系统依赖由维护者准备。数据库处理、测试数据选择和故障恢复说明见 [自动部署与远程发布](docs/operations.md#自动部署与远程发布)。

`deploy/` 提供 Caddy、systemd 和生产配置示例；主机地址、域名、证书与服务用户须按实际环境填写。数据库、媒体和历史素材使用独立持久化目录，不能放在前端公开目录中。已有素材标识不可覆写；历史不兼容时必须明确选择重置或另行处理数据；发布脚本不提供备份或数据库恢复。

媒体默认接收 JPEG/PNG 照片，单张 10 MiB、2000 万像素；处理后最长边 2560 px。录音最大 10 MiB、60 秒，服务端验证真实解码时长。桌面 Chromium 自动化录音与真实媒体文件测试不能代表 iPhone 真机兼容性。

需要复现较慢的专项验证时，可分别运行：

```sh
node web/src/features/media/verify-media-auto-stop.mjs
# macOS：仅在脚本自行创建的 64 MiB 临时卷上验证空间不足与提交失败。
python3 scripts/verify-storage-faults.py
```

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

- [新增 36 件素材总览](docs/previews/materials-overview.png) · [分类预览页面](docs/previews/materials.html)
- [人物发型总览](docs/previews/human-avatars.png) · [人物发型预览页面](docs/previews/human-avatars.html)
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

正式工程内置素材新增 4 个角色、4 款角色背景、8 件透明饰品、10 件小岛物件、6 枚成就徽章和 4 个日常任务图标，均为本地 SVG。管理页可按用途选用这些素材；新增商品的名称、价格、库存与上架状态，以及成就规则，仍由管理页配置，不自动创建。

另提供一位男孩和一位女孩的 6 款人物素材：男孩包含短发、卷发和侧分发，女孩包含长发、双辫和短发。同一人物的脸型、五官、肤色、服装和姿势保持一致，只改变发型。每款作为独立的整体形象选用，沿用现有购买、装备与展示方式。

小岛新增物件均为可重复购买、独立摆放的装饰。其中风车扇叶转动、喷泉流水与涟漪、秋千轻摆、路灯明暗变化、花丛随风摆动；这些视觉动作不增加进入或角色活动能力，已购物品自动使用当前动画定义。暂停或页面隐藏时冻结动画，恢复后继续；布置和减少动效时显示静态画面。商店缩略图保留原静态素材。小岛会展示已装备的新角色静态形象，原有狐狸和兔子继续使用肢体动画。新素材随服务启动安装到私有素材目录，已有版本不会被覆盖；更新后需重新构建前端并启动新版 Go 服务。

图片支持本地选择与预览，每张上限 2 MB。录音使用最长 60 秒的模拟计时，支持停止、重录、移除与示例音试听，不采集真实麦克风声音。打卡弹窗中的“设计预览”可演示设备不可用、录音失败、提交失败和重试。背景音乐为用户主动开启的合成旋律。

原型不包含服务端、真实附件上传、跨设备同步或公开部署。

## 静态原型界面基线

- 全应用改为便于稍远距离阅读的大字布局：主要文字 22–24 像素，标题 32–40 像素，辅助文字至少 18 像素，按钮目标至少 56 × 56 像素。手机保持字体大小，月历、统计、商店、管理页面及弹窗同步调整。
- 今日可打卡卡片仅保留大图标、名称、金币和钻石奖励，整卡点击；达到每日次数上限后移除，删除记录释放次数后重新出现，多次任务未达到上限时继续保留。完成记录仍在上方展示。
- 普通日、周、月历中的已完成记录，以及普通记录详情和编辑弹窗不显示金币、钻石分值；待打卡任务仍显示奖励，管理记录和删除确认保留奖励信息。
- 日视图只展示单日记录，通过前一天、后一天和今天切换，不放周日期条。周视图在桌面以周一至周日七列直接展示记录，在手机以七天纵向分组展示，空日期也保留，无需逐日点击。
- 桌面周记录区可跨页面宽度，下方今日任务与角色区保持左右布局。图标、金币和钻石使用彩色实心卡通 SVG，并精简欢迎语、宣传内容及重复说明。

## 静态原型检查

需要支持 `node:test` 的 Node.js，当前环境使用 Node.js 24：

```sh
npm test
npm run check
```

领域测试覆盖日期边界、每日次数、历史奖励快照、编辑不重复发奖、删除回收与负余额、统计归并、双币购买、库存及装扮去重。

原型浏览器检查涵盖打卡失败重试、日历历史只读、姓名修改、任务新增、管理密码错误与解锁、商店双币兑换与换装、登录以及桌面与手机布局。原型自身没有真实服务端；正式实现的权限、并发、持久存储和媒体验证见开发计划中的证据，不能用原型检查替代。

## 文件组织

正式工程与设计原型分别组织，根目录的 `npm start`、`npm test` 和 `npm run check` 继续操作原型。

- `cmd/island/`：Go 服务、迁移、初始化、密码找回与版本命令。
- `internal/config/`、`internal/core/`、`internal/storage/`：配置、业务值规则和 SQLite。
- `internal/account/`、`internal/checkin/`、`internal/shop/`：账户、打卡查询和商店业务。
- `internal/wallet/`、`internal/idempotency/`：同事务账务和成功命令收据。
- `internal/media/`、`internal/assets/`、`internal/message/`：私有附件、持久版本素材和家庭留言。
- `internal/httpapi/`：HTTP 协议、鉴权、请求保护及路由适配。
- `migrations/`：随 Go 程序嵌入的编号 SQL 迁移。
- `config/app.example.yaml`：可直接运行的本地开发配置。
- `api/openapi.yaml`：已实现的接口契约。
- `web/`：按功能划分的 React / TypeScript 页面、组件测试及浏览器测试。
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
