# 成长营地

面向一个小朋友和家庭的日常打卡应用，使用 Go、React / TypeScript、SQLite 和本机私有媒体目录。小朋友完成任务获得金币与钻石，购买装扮和家庭奖励，也可以建设营地、获得成就；家长使用同一账户的管理密码维护配置和纠正记录。

行为规则、设计原因和源码入口统一维护在 [Spec 索引](spec/00_INDEX.md)。部署和故障处置见 [运行手册](spec/ENGINEERING/OPERATIONS.md)，测试选择及环境限制见 [测试指南](spec/ENGINEERING/TESTING.md)。

## 本地启动

工具版本以 [go.mod](go.mod)、[package.json](package.json) 和 [.node-version](.node-version) 为准。先准备 Go、Node.js、npm，以及可执行的 `ffprobe`，再从仓库根目录运行：

```sh
npm ci
go mod download
npm run db:migrate
go run ./cmd/island init -config config/app.example.yaml
npm start
```

打开 <http://127.0.0.1:5173>。`npm start` 与 `npm run dev` 都启动正式应用的 API 和前端开发服务；按 Ctrl+C 停止。默认 API 监听 `127.0.0.1:8080`，Vite 代理 API 和健康检查请求。

`init` 交互读取用户名、姓名、登录密码和管理密码，密码不回显，已有账户时拒绝重复初始化。正常初始化没有示例成绩和订单；基础素材与营地由应用提供。网页可修改姓名和两种密码，忘记密码时在本机使用：

```sh
go run ./cmd/island reset-password -kind login -config config/app.example.yaml
go run ./cmd/island reset-password -kind management -config config/app.example.yaml
```

修改或重置任一密码会撤销全部会话。账户及授权边界见 [账户专题](spec/FEATURES/ACCOUNT.md)。

默认配置为 [config/app.example.yaml](config/app.example.yaml)，数据写入被 Git 忽略的 `.local/`。相对路径以启动时的工作目录为基准；SQLite 应放在本机磁盘。服务启动只校验结构。项目尚未上线，破坏性结构更新后重置开发数据库并重新导入测试数据，见下方命令；阶段约定见 [迁移与兼容](spec/SYSTEM/STORAGE.md#迁移与兼容)。

需要自定义端口或目录时：

```sh
cp config/app.example.yaml config/app.local.yaml
# 编辑配置后执行迁移，再在两个终端分别启动 API 与前端。
go run ./cmd/island migrate -config config/app.local.yaml
go run ./cmd/island serve -config config/app.local.yaml
ISLAND_API_TARGET=http://127.0.0.1:8080 npm run dev:web
```

最后一条命令的地址应与实际 API 监听地址一致。站点日期固定使用 `Asia/Taipei`，来源校验随请求判断，无需配置固定域名。

## 本地示例数据

在尚未建立账户的测试数据库中，可用以下命令替代正式账户初始化：

```sh
npm run db:seed
npm start
```

测试用户名为 `user`，登录密码和管理密码均为 `pass`，短密码只在该初始化入口允许。种子提供任务、商品、成就、近期打卡、交易、装扮、营地和留言；内容由 `internal/demo/settings.json` 及当前素材目录生成。

重复执行会保留后续编辑，已有正式账户或业务数据时拒绝导入，不会自动清空数据库。`npm run db:status` 可只读检查数据库状态。更多操作见 [测试数据初始化](spec/ENGINEERING/OPERATIONS.md#测试数据初始化)。

破坏性结构更新后，先按 Ctrl+C 停止开发服务，再重建数据库：

```sh
npm run db:reset
npm start
```

`db:reset` 直接清空配置指定的数据库及其 WAL、SHM 文件，按当前结构建库并写入测试数据，不再询问确认。原有账户和业务记录会丢失；媒体、素材及临时目录保留。自定义配置及失败处理见 [数据库迁移与不兼容处理](spec/ENGINEERING/OPERATIONS.md#数据库迁移与不兼容处理)。

## 检查与构建

```sh
npm run check:spec  # 文档结构及本地引用
npm run check       # 文档、Go 静态检查、接口类型及 TypeScript
npm test            # 正式工程常规测试
npm run build       # 类型检查与前后端构建
```

完整验证按需执行，首次运行浏览器测试前先安装对应浏览器：

```sh
npx playwright install chromium webkit
npm run verify
```

具体命令和证明边界见 [测试指南](spec/ENGINEERING/TESTING.md)。纯文档修改不需要跑全量业务测试。接口变更后运行 `npm run api:generate`，生成文件不手工维护。

## 发布与维护

```sh
npm run release
npm run deploy
# 仅上传，按输出命令稍后发布：
npm run deploy -- --host 192.0.2.10 --port 22 --user deploy --upload-only
```

`release` 生成独立发布包，含二进制、前端、部署模板、运行手册和校验清单。`deploy` 通过 SSH 构建、上传并调用发布脚本；数据库处理和测试数据选择会明确询问。运行时需要 `ffprobe` 及实际 HTTPS 入口，不需要 Node.js。

安装、迁移、不兼容数据库处理、密码维护及排障步骤统一见 [运行手册](spec/ENGINEERING/OPERATIONS.md)。生产部署和真机状态不能由本地构建推断；当前范围不提供备份及从备份恢复能力。
