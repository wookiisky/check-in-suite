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
- scripts/inspect-glb.mjs
- scripts/prepare-p0-character.py
- scripts/retarget-p0-mixamo.py
- scripts/prepare-camp-assets.py
- scripts/verify-3d-release.mjs
- scripts/provider-character-assets.test.mjs
- scripts/check-gltf-assets.mjs
- scripts/preview-gltf-assets.py
- scripts/render-gltf-previews.py
- scripts/import-provider-assets.py
- scripts/prepare-modular-characters.py
- scripts/asset-pipeline.py
- scripts/asset-pipeline-candidate.py
- scripts/asset-pipeline-rules.json
- scripts/render-tiny-treats-previews.py
- scripts/provider-character-binding.py
- scripts/modular-character-sources.json
- scripts/verify-modular-character-appearance.py
- scripts/verify-modular-character-arms.py
- scripts/modular-character-body-shaping.py
- scripts/modular-character-clothing-fit.py
- scripts/modular-character-cuff-opening.py
tests:
- scripts/asset-pipeline.test.py
- scripts/asset-pipeline-candidate.test.py
- scripts/render-tiny-treats-previews.test.py
- scripts/prepare-modular-characters.test.py
- scripts/verify-modular-character-appearance.test.py
- scripts/verify-modular-character-arms.test.py
- scripts/modular-character-arm-fit-blender-test.py
- scripts/modular-character-body-shaping-blender-test.py
- scripts/modular-character-clothing-fit-blender-test.py
- scripts/modular-character-clothing-fit-coverage-blender-test.py
- scripts/modular-character-cuff-opening-blender-test.py
- scripts/modular-character-hand-clothing-blender-test.py
- scripts/legacy-character-clothing-blender-test.py
- scripts/check-spec.test.mjs
- scripts/inspect-glb.test.mjs
- scripts/p0-character-assets.test.mjs
- scripts/retarget-p0-mixamo.test.mjs
- internal/assets/camp_assets_test.go
- internal/assets/provider_assets_test.go
- scripts/provider-character-assets.test.mjs
- scripts/modular-character-assets.test.mjs
- web/e2e/provider-character.spec.ts
- web/src/features/character/character3d-runtime-assets.test.ts
- web/e2e/island-3d.spec.ts
- web/e2e/spatial-occupancy-recovery.spec.ts
- scripts/check-gltf-assets.test.mjs
- scripts/preview-gltf-assets.test.py
- scripts/render-gltf-previews.test.py
- scripts/import-provider-assets.test.py
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
| 三维资源和场景 | 实际 GLB 的骨骼、蒙皮、占地、内嵌资源及字节；浏览器检查 shader 错误、真实姿态、遮挡、道具失败和 HTML 恢复 |
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
| `npm run test:assets` | GLB 检查器与实际人物、换装和离线动作的二进制检查 |
| `npm run test:asset-tools` | 锁定 Python 环境中的预览调度、缓存与静态物件增量加工检查，无需 Blender |
| `npm run test:asset-renderer` | 本机 Blender 真实四视图、坐标、缩放及逐项失败恢复专项 |
| `npm run assets:check` | 使用 Khronos Validator 只读检查当前正式 GLB，报告错误与警告 |
| `npm run test:deploy` | 构建校验清单、部署编排及发布脚本测试 |
| `npm run test:e2e` | 桌面 Chromium 和 iPhone 14 尺寸 WebKit 的浏览器流程 |
| `npm run build` | 类型检查和前后端构建 |
| `npm run verify` | 全面验证入口，含竞态检查、构建和浏览器流程 |

业务修改先写能失败的目标测试，再实现并运行所需检查。纯文档迁移通常只运行 `check:spec`，无需完整 `verify`。Vite 构建只证明可打包，TypeScript 与 OpenAPI 检查有各自职责。

`npm run test:asset-pipeline` 只使用临时仓库、JSON、小文件和子进程验证流程，包括来源类型声明、候选依赖、检查缺失、证据过期、正式基线漂移、精确字节应用及强制退出恢复。它不读取或验证正式素材。动作工具的 `--fixtures-only` 仅运行临时序列化 GLB 的批次测试，实际交付检查类另行选择。

分类检查标准由 `scripts/asset-pipeline-rules.json` 定义，稳定语义仍以商店、营地专题为准。自动格式通过、渲染产生图片、画面复核通过、正式应用和运行回归是独立事实。每项专项结论绑定候选、规则和证据字节，并覆盖计划中的实际资产或组合；未执行不得汇总为通过。上装需要肩肘腕、拳端和躯干局部视角，脸型需要无头饰画面，动作需要名称与采样帧，不能只记录一个无动作标识的时间百分比。源设计中的开襟、露指和分体护甲不能按统一封闭规则判断；来源丢件、错误遮盖与错误绑定仍须失败。 混合管线应验证规则只覆盖适用资产，并验证动画使用实际片段采样、无兼容身体的穿戴不会被过滤免检。证据导入应验证分批覆盖合并、自动警告报告保留、运行注册表变化及格式扩展名不匹配拒绝应用；恢复应验证源外链或任一声明产物改变后重建。

素材工具的安装、报告与预览入口见[运行手册](OPERATIONS.md#素材工具环境检查与预览)。`npm test` 和 `verify` 包含无需 Blender 的 Python 工具测试，需要先运行 `uv sync --locked`；真实 Blender 专项按需单独执行，没有 Blender 时会标记跳过，不能记为真实渲染通过。预览调度测试使用独立进程替身及实际 PNG 验证缓存、输入变动、部分失败和恢复；真实 Blender 专项才证明模型能被导入并生成四视图。增量加工测试使用序列化 GLB/glTF、实际外链文件和暂存字节，验证依赖变化、缓存损坏及失败后重建；它不代表已重新加工全部候选。

身体连接需要在最终 GLB 和实际动作上检查部件重叠，不能只比较原有共享顶点。膝部专项入口是 `scripts/modular-character-skeleton-knee-blender-test.py`；披肩专项入口是 `scripts/modular-character-back-fit-blender-test.py`，以实际闭面射线区分穿透与来源开口。手端镜头被另一只手或前臂遮挡时应保留这一事实，并补充能够看见目标拳端的视角，不能把腕口内侧图记为闭合拳端已通过。

最终读取模式不能再次执行修形。人形腰髋入口 `scripts/modular-character-human-waist-fit-blender-test.py` 使用独立 `--baseline-input` 核对原腰口，骷髅腰部入口 `scripts/modular-character-skeleton-waist-fit-blender-test.py` 使用独立 `--seam-reference-model` 核对分区配对，不能拿最终模型与自身比较。颈部入口 `scripts/modular-character-head-fit-blender-test.py` 分别检查支撑的上下接口；兜帽入口 `scripts/modular-character-hood-fit-blender-test.py` 可检查全部兼容脸型。腰带主带、开放边缘和附挂扣袋需要区分，身体位于饰件后方不能直接算成闭面穿透。

Playwright 用独立 API、前端端口和临时数据库，不复用日常开发服务；配置入口是 `playwright.config.ts`。首次运行前执行 `npx playwright install chromium webkit`。端口冲突时使用隔离配置，不停止未知服务或复用其数据。

较慢专项按需运行：

```sh
node web/src/features/media/verify-media-auto-stop.mjs
python3 scripts/verify-storage-faults.py
node scripts/verify-3d-release.mjs /absolute/path/to/release
```

录音专项使用 Chromium 实际编码和测试麦克风输入。磁盘专项在 macOS 自建的受限临时卷中制造空间不足和提交失败；结果只证明实际运行的平台与场景。

三维发行专项使用指定发行目录中的二进制与静态页面，在临时目录初始化空库，按实际目录检查全部三维资源的类型与字节。它通过真实任务打卡解锁活动，购买服装与陈设并核对原键重放，再保存已拥有的外观和布局，检查版本冲突与同一持久目录重启后的钱包、外观、布局和资源。另从冻结的旧迁移建立 WAL 数据库，验证不兼容结构被拒绝且逻辑内容保留。该命令只运行本机兼容的发行包，比较当前源码的受控资源；原始目录、日常数据库和未知服务不参与验证。

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
- 营地隐藏动画的可见性事件模拟不能证明操作系统真实后台行为。

3D 样片与正式场景的浏览器检查加载实际 GLB，覆盖混搭、动作、房屋、暂停、读取失败恢复和保存结果未知。真实画面需检查阅读书本与桌椅贴合、不同方向墙体剖切及窄屏工具栏；仅有 Canvas 或成功响应不足以证明渲染正确，shader 编译错误也必须检查。无头 Chromium 当前使用 SwiftShader 软件渲染；因此帧间隔不能作为真实 GPU 的帧率证据，WebKit 的设备尺寸也不能作为手机性能证据。桌面 60 fps、手机 30 fps 是正式场景的目标，需绑定实际设备、陈设规模、画质和加载环境另行测量。

制作工具的失败与恢复使用隔离目录及真实子进程检查退出码、清单状态和旧文件保留；人物入口还使用真实 Blender 复现 PNG 重复生成及不可覆写边界。动作分批恢复以不同目标骨架验证逐来源重算和旧身份保留。

人物来源适配分别验证源模型语义、交付 GLB 与正式浏览器流程。实际加载器测试读取正式 GLB，验证两种基础身体的默认装，以及形象、头部、上装、下装、鞋子和背部的混穿；测试仅替换图片解码，因此不证明图片和 GPU 显示。真实几何检查应确认换形象不改变身体和手脚，帽子不包含脸部，衣物不带入来源皮肤或骨骼，披风和箭袋可以独立选择。中箭需验证头部绑定、帽子替换与卸下，而非切换战损角色。

逐件四向检查从当前目录枚举非空穿戴，在两种基础身体上分别只替换对应槽；脸型卸下头饰检查，防止帽子或胡须掩盖缺口。报告记录实际组合、源 GLB 哈希、逐项失败和总览图。原生衣物完整性还须回到原包核对：腰带和腕环不能因身体分区而截断，开襟衣片也不能按腰线拆碎。网格非空和文件存在不能代替这些检查。

袖子和护臂还须以肩、肘、前臂、腕和手的局部画面检查，躯干包络或全身缩图不能证明这些部位完整显示。衣物外表面被基础皮肤遮住时，即使原生面全部保留，仍然不合格。几何检查须区分内外壁，并对变形后的外表面取样；显示和隐藏身体的同相机对照可用于定位遮挡，修复后仍应在身体正常显示时验收。

闭合衣身还须使用居中的正、背近景，完整覆盖胸腹、背腰和下摆。躯干诊断图可隐藏全部基础身体节点，以区分衣物本身的缺块与身体外穿；验收主图仍显示实际身体。

同侧手臂的检查须恢复跨身体节点的完整骨组件，避免开放骨面把骨间空隙误判为内部。检查用的区域封口只参与内外判断，穿入深度仍来自真实表面；胸口或另一条手臂的自然遮挡不计入同侧失败，肩胸交界另用近景检查。数值通过后仍须核对外壁露肤和腕口接缝，闭合手套还应沿手轴查看拳端，不能把正常露指口与外壁穿肤混为一谈。

基础身体简化须另外检查肩、肘、腕和腰部在实际蒙皮动作中的接合，以及手掌、拇指与既有道具的配合。裸身外形不能沿用旧衣袖和手套轮廓，也不能通过过度缩小身体消除穿插。原款手套、护手须逐源核对实际衣物面已归入上装，并排除切分腕部时补出的人工封口；仅验证上装非空不能证明手部完整。

新增的髋、膝骨关节须分别检查真实体积接合，分区共享顶点一致不能证明两个独立骨部件仍相连。[髋部检查](../../scripts/modular-character-skeleton-hip-blender-test.py) 使用实际交付动作，分别验证修补时的来源属性保护及导出后无适配重读的接合；[膝部检查](../../scripts/modular-character-skeleton-knee-blender-test.py) 另行核对新增股骨与原小腿。腰背位置场须同时作用于躯干、腿和手臂分区中的来源骨面，肋骨按位置拆入手臂节点的部分也不能漏掉；局部穿衣数值通过后仍须检查裸身轮廓。

[手部来源提取检查](../../scripts/modular-character-hand-clothing-blender-test.py) 在衣物适配之前调用实际制作函数，逐三角比较源位置、UV、材质和原蒙皮，并检查裸手与骨骼被排除。成品经过已声明的矩阵、重绑或细分后，源坐标与原权重会改变；成品使用 [衣物适配检查](../../scripts/modular-character-clothing-fit-blender-test.py)、[动作穿入检查](../../scripts/modular-character-arm-fit-blender-test.py)、[闭拳覆盖检查](../../scripts/modular-character-clothing-fit-coverage-blender-test.py) 及真实画面分别验收，不能把来源提取检查当作最终 GLB 的完整性结论。

[衣物适配接口](../../scripts/modular-character-clothing-fit.py) 的可选 `arm_surface_fit` 在原有矩阵和绑定完成后执行：只对声明的源肩帽范围细分，再按X下降、Z上升的权重贴合同一轮实际身体的同侧肩臂表面，并用相同权重混合目标三角的真实蒙皮。可选 `strength` 同时乘到位移和蒙皮混合量，默认1，须为大于0且不超过1的有限数值；略低于1可避免不同源点完全投影到同一点，仍须检查正源域子面的实际几何面积。参考通过已有的纯数值 `hand_surface.arm_surface` 传入。真实来源回归检查原面覆盖、UV插值、远端和其他组件保持、肩部权重以及缺失参考和无效范围；接口正确仍须结合最终动作、颈部遮挡与实际画面验收。

矩阵适配中的 `transform_weight.z_bounds` 使用两个不同的有限高度，按给定端点从完全生效过渡到零。端点方向可反转，位置和法线须使用同一渐变方向；真实 Blender 平面回归以有限差分核对法线，并检查区间外的截断与原方向兼容。

原本封闭的护臂可以在制作阶段为手臂开通内孔，保留可见外壁、口沿、UV与材质。去除的内部端盖、新增内壁和内衬分别记录；闭合拳套保留闭掌，屈腕时还须保持原款应有的覆盖，不能因刚体分区留下新的裸腕缝。

四向画面及动作采样只证明对应身体、组合和采样帧，不能据此声称每个组合与每个动作的所有帧都检查过。浏览器验证应实际购买骷髅及独立穿戴、混搭保存后重开，并检查模型请求与 shader 错误；画面仍需查看截图。Kenney 人物的历史测试结果不作为当前六槽目录的验证证据。

独立场景检查分别验证数据库与浏览器边界：真实 SQLite 的独立连接竞争证明同一实例只能占用一处，迁移检查保留旧布局顺序和版本；浏览器检查购买解锁、无房活动、收起搬运、各场景草稿及结果未知恢复。房屋通路允许派生的分数厘米矩形，用户保存坐标仍为整数；支撑面以实际 GLB 的楼板射线核对，同时采样门廊侧边和倒角，再以实际执行器验证插值及移动房屋后的局部坐标转换。不能用门洞中心线或通路包围范围代替整个平台的高度。

真实 GPU 采样须记录实际 Canvas 的驱动、视口、DPR、布局与可见物件、前台焦点和时长，并同时统计原生 WebGL 绘制调用与帧间隔。室外布局中的室内家具未必处于渲染树，不能用总摆放数冒充同时绘制规模；室内展开需单独采样。开发服务的网络字节包含开发模块，缓存状态也会影响结果，不能当作正式包大小或严格冷热加载比较。

备份与从备份恢复是已取消的产品范围，真机验收不在既定范围；它们不作为待完成任务。重启持久化、事务回滚、上传和清理中断恢复仍属于现有行为，不能由“未提供备份”推导为无需验证。

人物与固定穿戴改造的旧数据处理范围见 [商店专题](../FEATURES/SHOP.md#素材与兼容边界)，其中明确不提供的兼容与转换能力不列为待验证项。现有数据库历史校验和不兼容时拒绝启动仍按 [存储专题](../SYSTEM/STORAGE.md#迁移与兼容)验证。

完成说明记录本次实际命令、环境、结果及未验证项即可。不要重新建立逐阶段任务账本；规则归专题，具体执行证据归变更说明。
