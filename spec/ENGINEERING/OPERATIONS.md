---
summary: 构建发布、单机安装、账户维护、数据库升级和故障处置的操作步骤。
owns:
- operations.workflow
source:
- .codex/config.toml
- scripts/release.mjs
- scripts/deploy.mjs
- deploy/publish.sh
- deploy/app.production.example.yaml
- deploy/Caddyfile
- deploy/island.service
- cmd/island/maintenance.go
- cmd/island/database_status.go
- cmd/island/database_reset.go
- internal/demo/settings.json
- scripts/prepare-3d-resources.py
- scripts/prepare-camp-assets.py
- scripts/fetch-provider-assets.py
- scripts/import-provider-assets.py
- scripts/import-provider-characters.py
- scripts/import-provider-animations.py
- scripts/check-gltf-assets.mjs
- scripts/preview-gltf-assets.py
- scripts/render-gltf-previews.py
- pyproject.toml
- uv.lock
- internal/assets/assets.go
- internal/character/character-catalog.json
tests:
- scripts/release.test.mjs
- scripts/deploy.test.mjs
- scripts/publish.test.mjs
- cmd/island/deployment_test.go
- cmd/island/asset_upgrade_test.go
- cmd/island/database_reset_test.go
- internal/demo/seed_test.go
- internal/assets/graphics_assets_test.go
- internal/httpapi/assets_test.go
- scripts/check-gltf-assets.test.mjs
- scripts/preview-gltf-assets.test.py
- scripts/render-gltf-previews.test.py
- scripts/import-provider-assets.test.py
---
# 成长营地运行手册

正式运行由一个 Go 进程提供页面、API 和私有媒体，SQLite、照片、录音与历史素材放在本机持久磁盘。生产运行需要应用二进制、前端构建文件、`ffprobe` 和 HTTPS 入口，不需要 Node.js。

本手册提供部署步骤和本机检查方法，不代表已经配置生产服务器、证书或网络入口。当前产品不提供备份及从备份恢复能力，真机验收不在既定范围内。

构建与 npm 命令在源码根目录执行；发布目录中的命令和 `deploy/` 路径以发布包为基准。文件顶部元数据只供源码仓库导航，发布包运行不需要这些源码或测试文件。

## 构建发布目录

先准备 Go、Node.js、npm 和 uv，再在源码根目录安装锁定依赖并执行检查：

```sh
npm ci
uv sync --locked
go mod download
npm run verify
npm run release
```

`release` 单独进行类型检查、前端构建与 Go 构建。它生成新的 `.local/releases/<提交号>-<时间>-<系统>-<架构>/`，已有目录不会被覆盖。工作区包含未提交变更时，版本带 `-dirty`，不能把它当作对应 Git 提交的原样构建。

可以指定目标平台与发布目录根路径：

```sh
npm run release -- --goos linux --goarch amd64 --output-root /tmp/island-releases
```

跨平台构建不等于已经在该平台运行验证。`release.json` 保存完整提交号、是否含未提交变更、构建时间、平台、文件校验值和迁移文件校验值；二进制的 `version` 子命令无需读取配置或数据库。

发布目录包含：

```text
island                  # Windows 目标为 island.exe
web/                    # 本次独立构建的静态页面
deploy/                 # 部署配置示例
operations.md           # 本手册
release.json            # 版本与文件校验值
SHA256SUMS              # 包含 release.json 的文件校验清单
```

基础建表脚本和受控图标、形象、饰品嵌入在二进制中。首次启动将受控素材安装到 `assets_directory`；已有素材标识的图片字节或元数据不同会拒绝启动，具体版本规则见[素材与兼容边界](../FEATURES/SHOP.md#素材与兼容边界)。

## 三维资源制作与安装

正式人物、服装缩略图、建筑和离线动作同样嵌入二进制，并在启动时通过原有受控素材安装流程进入 `assets_directory`。GLB 使用单文件同源读取，模型和动画不会作为管理页图片选项返回。资源的身份、元数据或内容变化必须采用新的版本标识，不能覆盖持久目录中的同名资源。

首批资源以已经验收的样片文件为输入。只整理 GLB 时使用 Python；需要重绘八张透明服装缩略图时显式指定全局安装的 Blender。以下示例使用本机 macOS 的安装路径，其他电脑按实际位置调整：

```sh
python3 scripts/prepare-3d-resources.py
python3 scripts/prepare-3d-resources.py --blender /Applications/Blender.app/Contents/MacOS/Blender
go test ./internal/character ./internal/assets
go test ./internal/httpapi -run 'TestGraphicsAssetsHTTP'
```

该脚本复制已经整理的人物及动作，将 Kenney 建筑的纹理写入 GLB，并从交付人物模型渲染缩略图；它不生成新服装，也不自动适配新骨架。模型与服装定义由 `internal/character/character-catalog.json` 管理，文件格式、显示名称、来源及许可由受控素材目录管理。模型与动作的来源和权利分别登记，原始 FBX 与加工工程仍留在 `.local/3d-sources/`。

家具与户外模型使用 `scripts/prepare-camp-assets.py` 整理，来源包分别放在 `.local/3d-sources/kenney-furniture/`、`kenney-nature/`、`kenney-survival/`。生活动作与书本工程保存在 `.local/3d-sources/living-actions/`，Mixamo 原始动作位于 `.local/3d-sources/mixamo/`。正式模型的实际边界、地面锚点、来源与加工参数分别登记在 `internal/assets/camp-source-manifest.json`、`camp-asset-metadata.json` 和 `camp-living-source.json`；座姿的靠近点与根位置由共享场景目录使用，不在浏览器按模型名称猜测。

扩充官方免费资源时，`scripts/fetch-provider-assets.py` 负责保存包级快照；原包及解压内容位于 `.local/3d-sources/provider-packs/`，来源、免费版本、原包校验值和许可依据记录在 `internal/assets/provider-pack-manifest.json`。免费与付费下载内容分别处理，不因为同属 CC0 就把付费文件记为免费取得。重新发现官方目录可能引入新版本，应核对清单差异，不能把重新抓取当作复现旧快照。

`scripts/import-provider-assets.py` 根据按来源维护的审核配置整理完整物件。完整物件库与本次选入清单分开：未选入物件和制作工程保留在本地，发行包只包含本次使用的 GLB、PNG 与元数据。源条目及范围排除、准备失败、本次选择均保留在 `internal/assets/provider-asset-manifest.json`，不能只检查商品总数就认定清单无遗漏。

人物由 `scripts/import-provider-characters.py` 在 Blender 中整理，标准身体、骨架、切面和逐源选择由专用配置提供。没有原始下肢或骨架的源人物须明确记录补充身体与离线绑定，不能声称其源包已有这些部件。`internal/assets/provider-character-manifest.json` 记录已加工人物和恢复检查点；尚未适配或未通过画面检查的人物不进入正式可选目录。原始动作单独由 `scripts/import-provider-animations.py` 处理，并在 `provider-animation-manifest.json` 中记录已完成范围与剩余范围；预览按需加载，不能让正式人物页面下载全部原始动作。

恢复已有批次的画面检查时，可在全局 Blender 后台运行人物脚本并传入 `--evidence`，通过 `--only` 选择人物、`--evidence-output` 指定独立输出目录。此入口只读取已整理人物并生成来源对照与共用服装画面，不改写正式人物目录、清单或模型；省略 `--only` 时检查已加工的完整批次。

除了 Go 素材检查，`npm run test:assets` 会逐个读取正式人物与服装的实际 GLB，核对身体分区范围、骨骼层级、逆绑定矩阵和蒙皮权重。这证明当前交付数据满足结构约束，仍需结合真实换装画面检查头饰、接缝和遮挡。资源获取、静态整理、人物整理与动作整理的 Python 检查各位于相应脚本旁，可单独执行；制作需要 Blender，正式运行不依赖制作工具。

发行包运行不需要 Python 或 Blender。构建验证需检查实际 GLB 内嵌数据、目录引用与缩略图解码，正式包还需验证新进程能从持久素材目录读取相同字节。素材制作检查不代表已完成真实手机性能验收。

动作来源按 `scripts/provider-animation-sources.json` 中的审核批次处理，不按骨名扫描结果自动纳入非人形资源。导入脚本的 `--list` 查看批次，`--batch` 或 `--only` 选择范围，`--all` 处理全部审核来源；`--first-medium` 保留首批复现入口。增量执行核对来源与产物哈希，保留已完成记录；失败保留原因并返回非零。不同来源的相同曲线合并为一份交付资源，来源记录仍分别保留。原始水平根位移留在本地源文件，正式动作移除导航方向的根位移，垂直动作与身体摇摆继续保留。

Tiny Treats 房屋与景物由 `scripts/prepare-tiny-treats.py` 整理，来源与产物清单为 `internal/assets/tiny-treats-manifest.json`。普通 Python 使用 `--fetch-only` 获取审核过的免费源包；制作时在后台 Blender 中执行该脚本并传 `--only all`。`scripts/tiny-treats-blender-test.py` 在实际 GLB 上核对门洞、墙体和地板，`scripts/render-tiny-treats-previews.py` 生成四向外观与剖墙。原包、工程及中间产物保留在 `.local/3d-sources/tiny-treats/`，正式包只安装选入 GLB、PNG 和元数据。

### 素材工具环境、检查与预览

开发期的 glTF Transform、Khronos Validator 由根目录 npm 依赖锁定。普通 Python 素材脚本使用 uv、`.python-version`、`pyproject.toml` 和 `uv.lock` 管理；在源码根目录执行 `uv sync --locked` 后，使用 `uv run --locked python scripts/脚本名.py`。Pillow 供图片处理和总览图使用；`bpy`、`bmesh`、`mathutils` 由 Blender 自带 Python 提供，不安装进普通 Python 环境。完整测试需要先准备 npm 和 uv 两套依赖，生产发行包不依赖这些工具。

以下命令只读取模型，报告和预览写入本地输出目录：

```sh
npm ci
uv sync --locked
npm run assets:check -- --output .local/asset-tools/gltf-validation.json
npm run assets:inspect -- internal/assets/builtin/character-medium-v1.glb
npm run assets:preview -- --kind characters --limit 4 --output .local/asset-tools/characters
npm run assets:preview -- --kind selected --limit 12 --output .local/asset-tools/selected
npm run assets:preview -- --input /absolute/path/house.glb --output .local/asset-tools/houses
```

`assets:check` 默认逐文件检查正式 builtin 目录，也接受一个或多个 GLB 文件、递归目录。报告保留 Khronos 的错误、警告和问题位置，存在错误时返回非零；警告不会自动判为安全，也不能替代画面检查。`assets:inspect` 用于分析单个模型的网格、材质、纹理和体积。两者均不优化或改写输入；压缩扩展需另行适配运行时解码器，不能仅凭安装分析工具就批量压缩正式资源。

`assets:preview` 默认使用本次选入摆设，`--kind characters` 使用当前人物与默认衣服的显隐规则；`--input` 可重复传入自包含 GLB 或目录，供新房屋和其他未上架模型预览。`--only` 精确选择资源身份，`--limit` 限制本次数量，`--size` 调整单视图尺寸，`--page-size` 调整每张总览图的模型行数。可用 `--blender` 或 `BLENDER_PATH` 指定 Blender，中文字体可通过 `--font` 指定。

预览在独立后台 Blender 进程中生成正、右、背、左四张 PNG，各角度共用取景比例和固定灯光。人物使用静态绑定姿势；总览图中的尺寸为 glTF 的 XYZ、+Y 向上坐标。它适合比较外观、比例与接缝，尚不能证明动作姿态、混搭服装或浏览器最终渲染正确。背景加工不保存或覆盖当前图形界面的工程。

输出目录中的 `preview-manifest.json` 记录本次逐项结果、失败原因及总览图路径；`renderer.log` 保留最近一次实际批处理日志。`preview-cache.json` 保留曾处理条目，切换筛选后仍可复用。模型字节、显隐、比例、渲染设置、Blender 版本或渲染代码变化时重新生成；图片丢失、字节变化或缓存损坏也会重建。`--force` 只强制重画本次选择。单项失败保留已完成项并返回非零，下次只重试未成功项。使用不同输出目录可隔离不同批次，同一输出目录顺序使用。

静态物件导入还在原有 `.local/3d-sources/provider-prepared/` 暂存目录使用 `.cache.json`。它核对源模型、实际缓冲和外链图片、加工参数及代码，并检查暂存产物和元数据；不一致或丢失时重新加工。缓存省去重复边界计算和封装，不跳过发布筛选、所有权规则或正式资源的不可变版本检查，也不自动推进人物与动画批次。

### Codex 连接 Blender

Blender 程序及 MCP 服务端统一在项目外安装和维护，项目内不保存 Blender 应用或安装包。`.local/3d-sources/` 中的素材源包、原始 FBX、`.blend` 工程和加工记录继续保留，供资源追溯与后续制作使用。

本项目使用 [Blender Lab 官方 MCP](https://www.blender.org/lab/mcp-server/)，项目配置位于 `.codex/config.toml`。服务端全局安装在 `/Users/air/toolkit/blender_mcp`，固定源码提交为 `dbbf836ad4b1025f14a2b3b504c43903f39e0b04`；依赖由该安装目录下生成的 `mcp/uv.lock` 锁定。配置使用 `/opt/homebrew/bin/uv` 启动服务端，并通过 `BLENDER_PATH` 指定 `/Applications/Blender.app/Contents/MacOS/Blender`。其他电脑需按本机安装位置调整这些路径；此配置只在 Codex 信任本项目时加载。

本次清理时，全局 Blender 版本为 5.2.3 LTS，已检查命令行版本与 MCP 只读连接。既有样片保留 Blender 4.5 的制作记录；人物和动作恢复时须使用清单中实际记录的批次；已完成的 5.2 制作检查不证明与 4.5 导出字节相同。恢复制作时应重新检查生成文件及实际画面，不能用连接成功代替资源加工验证。

使用时先启动 Blender，确认已启用官方 Lab MCP 插件及 Online Access，并在插件设置中确认 MCP Bridge Server 正在运行。服务端默认连接 `localhost:9876`。在项目根目录执行 `codex mcp get blender` 可检查配置是否被识别；实际连通性需要调用只读工具 `get_objects_summary` 验证。安装或调整配置后，重新加载 Codex 的 MCP 连接；当前聊天未出现工具时，在本项目新建聊天后检查。

安装与依赖准备遵循[官方安装说明](https://projects.blender.org/lab/blender_mcp/wiki/Setup)，在全局服务端的 `mcp/` 目录执行 `uv sync`。日常启动使用 `uv run --locked blender-mcp`，依赖与锁文件不一致时先检查安装状态。该服务仅用于开发期间制作和检查资源，发行包运行不依赖 MCP。

## 自动部署与远程发布

本地需要项目规定的 Go、Node.js、npm，以及 SSH、SCP、tar；先安装锁定依赖。服务器支持 Linux amd64 / arm64，需要 systemd、Bash、`ffprobe`、curl、sha256sum 和 flock。SSH 用户须为 root 或可使用 sudo；远程运行无需 Node.js、Go 或 Python。脚本不安装系统包，也不修改 Caddy、证书或防火墙。

```sh
npm run deploy
npm run deploy -- --host 192.0.2.10 --port 2222 --user deploy --root /srv/island
npm run deploy -- --host 192.0.2.10 --port 2222 --user deploy --upload-only
```

无参数且终端可交互时，依次输入 IP、SSH 端口、用户名和安装目录。脚本只读探测服务器系统及架构，再调用 `release` 交叉构建，打包到远程 `/tmp/island-upload.*/<发布名>`，校验 SHA256SUMS 后运行发布脚本。`--upload-only` 保留产物并输出可直接执行的 SSH 发布命令。远程暂存目录和历史 release 由维护者按需清理，不能把 `/tmp` 当作持久发布目录。

首次运行会创建 `island` 服务用户、安装目录、配置与 systemd 服务。选择监听地址，默认 `0.0.0.0:38100`，之后无需填写网站来源或服务器 IP。有本机反向代理时可监听 `127.0.0.1:38100`。已有 `/srv/island/config/app.yaml` 会沿用，所有相对路径以安装根目录为基准。维护命令与服务均以 `island` 用户运行。

部署时无需配置固定网站来源。Caddy 应保留浏览器的 Host，并覆盖外部协议头；仅回环地址的直接代理可通过单值 `X-Forwarded-Proto: https` 影响 Secure Cookie。非本机代理需要重新评估信任边界。

也可以在服务器上对完整发布目录执行：

```sh
bash /实际发布目录/deploy/publish.sh --root /srv/island
# 明确指定普通发布选项，仍保留首次配置和正式账户初始化所需的输入：
bash /实际发布目录/deploy/publish.sh --root /srv/island --database auto --seed no
```

发布前会显示数据库状态，并分别询问数据库处理方式和是否导入测试数据：

| 选项或状态 | 行为 |
| --- | --- |
| `auto`（默认） | 新库建库；历史匹配时执行待迁移；当前版本跳过迁移。 |
| `migrate` | 显式执行兼容迁移，历史不匹配时拒绝。 |
| `reset` | 显示绝对数据库路径，输入 `RESET` 确认后停服、删除数据库及同路径 WAL/SHM，再建新库。 |
| 历史校验冲突、数据库版本较新 | `auto` 或 `migrate` 退出；只有明确指定 `reset` 才能重建。 |
| 权限、锁、I/O 或数据库损坏 | 报错退出，不将故障转换成重置操作。 |
| `--seed yes` | 空库导入测试数据；有完整测试初始化标记时跳过；已有正式账户则须先明确选择重置。 |
| `--seed no`（默认） | 不导入测试数据；没有账户时进入现有正式账户初始化。 |

重置只删除配置指向的数据库、WAL 和 SHM，保留素材及媒体文件，但旧媒体的数据库引用会丢失。媒体之后仍按现有清理规则处理。脚本不备份数据库，也不能恢复重置前数据。`--confirm-reset` 可代替交互输入 `RESET`，只能在已核实目标路径、确实需要清空时使用。

依赖、状态和选择检查完成后才停止服务。执行迁移或测试初始化失败会保留当前阶段并报错；数据库可能已升级，此时不能直接启动旧二进制。脚本不会自动回退旧版本。成功时原子替换 `current` 链接、启动服务并验证 `/health/live` 与 `/health/ready`；健康检查失败会保留新版本链接并返回失败，请排查日志后重试同一发布命令。多个发布通过 flock 串行保护，迁移和种子初始化可安全重试。

## 测试数据初始化

```sh
npm run db:seed
npm run db:status
# 自定义配置或服务器维护：
./island migrate -config /绝对路径/app.yaml
./island seed-demo -config /绝对路径/app.yaml
./island db-status -config /绝对路径/app.yaml
```

测试用户名 `user`，登录和管理密码均为 `pass`，仅测试初始化命令局部允许短密码。正式账户初始化和修改密码仍遵循配置。种子提供任务、商品、成就、近期打卡、购买、钱包流水、装扮、营地布置与留言；不伪造照片或录音。具体内容由源码 `internal/demo/settings.json` 和素材目录共同生成，不将数量作为初始化契约。

账户、业务数据和 `demo_seeds` 完成标记同事务提交。重复执行只跳过，不补写或覆盖后续修改；不能凭用户名判断数据库能否导入。未标记的已有账户或业务数据会拒绝初始化。测试内容在源码 `internal/demo/settings.json`，变更后需重新打包。

`db-status` 默认输出 JSON，包含 `state`、迁移数量、账户与测试数据标记、绝对持久路径和探活地址；`-format tsv` 是发布脚本的固定九字段协议。状态包括 `missing`、`empty`、`pending`、`current`、`incompatible`、`newer`。检查不存在的数据库不会创建文件；损坏或读取故障返回非零退出码。此检查只说明结构与迁移兼容性，不替代业务或实际入口验收。

## 安装到一台 Linux 主机

以下以具有 systemd 的 Linux 为例。先安装能够正常执行的 `ffprobe` 与 Caddy，确认目标 CPU 架构与构建产物一致。示例使用 `/srv/island`，不把数据库放在同步盘、共享网络盘或前端公开目录。

```text
/srv/island/
  releases/<release-name>/
  current -> releases/<release-name>
  config/app.yaml
  data/island.db
  data/media/
  data/assets/
  data/tmp/
```

由服务器维护者创建专用非特权用户及目录，将完整发布目录复制到 `releases/`，再将 `current` 指向该发布目录。`releases/` 与 `config/` 由维护者管理，应用只需读取；`data/` 归 `island` 用户所有，并授予 `0700` 权限。配置文件可设为维护者所有、`island` 组可读、权限 `0640`。

首次安装的命令示例，`release_name` 与来源路径需替换为本次真实产物；已有用户或目录时检查现状后跳过相应创建步骤：

```sh
release_name='替换为实际发布目录名'
sudo useradd --system --home-dir /srv/island --shell /usr/sbin/nologin island
sudo install -d -m 0755 /srv/island /srv/island/releases
sudo install -d -o root -g island -m 0750 /srv/island/config
sudo install -d -o island -g island -m 0700 /srv/island/data
sudo cp -R "/实际产物所在目录/$release_name" /srv/island/releases/
sudo ln -s "releases/$release_name" /srv/island/current
sudo install -o root -g island -m 0640 /srv/island/current/deploy/app.production.example.yaml /srv/island/config/app.yaml
```

将 `deploy/app.production.example.yaml` 复制为 `/srv/island/config/app.yaml`，修改：

- `ffprobe_path`：主机上实际的 `ffprobe` 绝对路径。
- 所有目录路径：若采用不同安装位置，一并调整。

应用自动判断同源；HTTP 或 HTTPS 的 Cookie 属性按实际连接或受信任的本机代理协议设置，不需要固定访问地址。

## 空安装与账户初始化

先在新数据库执行基础建表，再交互初始化唯一账户：

```sh
sudo -u island /srv/island/current/island version
sudo -u island /srv/island/current/island migrate -config /srv/island/config/app.yaml
sudo -u island /srv/island/current/island init -config /srv/island/config/app.yaml
```

初始化依次读取用户名、姓名、登录密码及确认、管理密码及确认。终端隐藏密码；密码不能放进命令参数。重复初始化会拒绝，初始余额为零，不导入演示任务、成绩、订单或浏览器数据。

两种密码默认 10–128 个 Unicode 码点。用户名初始化后不可修改；姓名与密码也可通过已解锁的网页管理界面维护。网页退出管理会撤销管理授权，再次进入需要重新输入管理密码；修改任一密码后所有登录会话失效。

## HTTPS 与常驻进程

将 `deploy/island.service` 安装为 `/etc/systemd/system/island.service`，确保其中的路径和用户与实际安装一致。示例只允许应用向 `/srv/island/data` 写入，停服等待时间为 120 秒，覆盖默认 90 秒上传期限；若调整上传期限，同时调整停服等待时间。

将 `deploy/Caddyfile` 中的主机名替换为实际访问的域名，再把该站点块合并到 `/etc/caddy/Caddyfile`，保留其他已有站点。Caddy 将所有请求代理给 `127.0.0.1:38100`，不直接公开媒体或数据库目录。

```sh
sudo systemd-analyze verify /etc/systemd/system/island.service
sudo systemctl daemon-reload
sudo systemctl enable --now island
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy 的域名站点会启用自动 HTTPS；实际签发仍取决于域名解析、入口端口与证书条件，家庭内网入口应使用设备信任的证书方案。配置方式见 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https) 和 [反向代理指令](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。服务进程配置依据 [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 与 [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。

启动后检查 `/health/live` 与 `/health/ready`，再从真实入口完成登录、进入管理、创建任务、打卡和读取页面。健康接口成功只说明依赖可用，不能代替业务验证。

## 忘记密码

拥有服务器维护权限的人可以重置指定密码：

```sh
sudo -u island /srv/island/current/island reset-password -kind login -config /srv/island/config/app.yaml
sudo -u island /srv/island/current/island reset-password -kind management -config /srv/island/config/app.yaml
```

命令交互读取新密码及确认，并撤销全部会话。它不改变用户名、姓名、余额或业务记录。不提供邮件、短信或网页“忘记密码”入口。

## 数据库迁移与不兼容处理

项目未上线阶段的处理约定见 [迁移与兼容](../SYSTEM/STORAGE.md#迁移与兼容)。破坏性结构更新后，先按 Ctrl+C 停止开发服务，再从仓库根目录执行：

```sh
npm run db:reset
npm run db:status
npm start
```

`db:reset` 调用 `reset-demo`，使用 `config/app.example.yaml`。它直接删除配置指向的数据库及同路径的 `-wal`、`-shm`，再按当前 SQL 建库并导入测试数据，不询问确认。原有账户、记录、购买、余额和会话都会清空；媒体、素材及临时目录保留。测试账户仍为上文的 `user` / `pass`。不要在服务仍持有数据库连接时运行该命令。

使用自定义配置时执行：

```sh
go run ./cmd/island reset-demo -config config/app.local.yaml
go run ./cmd/island db-status -config config/app.local.yaml
```

删除、建库或测试初始化任一步失败，命令立即返回错误，不报告重置完成；不会恢复旧数据。排查输出后可重新执行重置，成功后确认状态为 `current` 再启动服务。

`migrate` 仍是显式建库和兼容升级命令；建表 SQL 与版本记录在同一事务提交，失败时不记录成功。历史较早且一致的数据库可以追加迁移，历史脚本发生过变化时不能靠再次运行 `migrate` 解决。应用启动只检查 schema，不自动改库；不能通过删除版本记录绕过检查。`db:seed` 仍只初始化空库或跳过已经完成的测试初始化，不代替重置。

## 媒体清理与日常检查

服务启动后按配置周期清理媒体。排障时核对 `media_cleanup_interval` 和 `media_orphan_ttl`，并区分已关联、未关联和等待删除的文件；素材目录不参与媒体清理。清理失败时检查目录权限、容量和日志，修复原因后由后续轮次或重启继续处理。

孤儿清理仅处理服务生成的上传临时文件和 UUID `.media` 文件。`media_directory`、`temp_directory` 不得设置为数据库所在目录，包括指向该目录的符号链接；配置检查会拒绝这种设置。可以按示例将数据库放在 `data/island.db`，将上传分别放在 `data/media/` 和 `data/tmp/`，无需事先创建这些新目录。

不要手工删除 `.db-wal`、`.db-shm`、尚未核对的媒体文件或历史素材。可检查持久化磁盘剩余空间与应用日志；业务余额需要通过流水核对，不能直接修改钱包数字掩盖问题。

```sh
sudo systemctl status island
sudo journalctl -u island --since '30 minutes ago'
df -h /srv/island/data
```

已安装 SQLite 命令行工具时，可用只读连接检查数据库结构和账务求和：

```sh
sudo -u island sqlite3 -readonly /srv/island/data/island.db '
PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT coins - COALESCE((SELECT SUM(coin_delta) FROM wallet_entries), 0) AS coin_difference,
       diamonds - COALESCE((SELECT SUM(diamond_delta) FROM wallet_entries), 0) AS diamond_difference
FROM wallets WHERE account_id = 1;
'
```

正常结果依次为 `ok`、没有外键违规行、余额差值 `0|0`。非零差值或外键违规需要调查实际交易与日志；检查命令不会修复或覆写数据。`df` 只报告容量事实，不能证明数据库与媒体文件一致。

日志记录请求 ID、中文事件名和操作结果，不记录密码、Cookie 或完整家庭文字。排障时保留错误码、请求 ID 与发生时间，避免复制凭据或媒体内容。

| 现象 | 检查与处理 |
|---|---|
| `ORIGIN_INVALID` | 检查请求是否跨站，以及代理是否保留了浏览器的 Host 和 Fetch Metadata。 |
| `SESSION_REQUIRED` | 重新登录；密码修改、重置、退出或会话到期都会使旧登录失效。 |
| `MANAGEMENT_REQUIRED` | 重新输入管理密码；退出管理或授权到期后原页面不再有写权限。 |
| `DATABASE_BUSY` | 检查是否有另一应用或维护命令持有写事务；保留原请求重试，不新建第二笔交易。 |
| `STORAGE_UNAVAILABLE` | 检查磁盘空间、目录权限与文件系统状态；故障未解决前不要反复新建提交。 |
| 启动报结构版本不匹配 | 核对配置和程序版本；历史匹配时执行迁移；历史不匹配时明确选择重置或另行处理数据。 |
| `ffprobe` 就绪检查失败 | 核对路径、执行权限与该账户能否运行 `ffprobe -version`。 |
| 素材标识内容冲突 | 按[素材版本规则](../FEATURES/SHOP.md#素材与兼容边界)修正发布包；不要删除持久化旧素材。若失败发生在测试数据初始化阶段，修正包发布时检查数据库状态：`current` 且无账户时，可选 `auto` 和 `--seed yes` 继续初始化，无需再次 `reset`。 |
| 写入结果未知 | 页面使用原幂等键核对；确认成功后的加载失败只重试读取。 |

当前提供的 Caddy、systemd 文件是部署示例。生产 HTTPS、服务器权限和真实网络入口须在实际安装时检查；本次自动化与本机验证不替代这些运行环境事实。
