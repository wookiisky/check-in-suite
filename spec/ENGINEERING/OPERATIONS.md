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
- scripts/asset-pipeline.py
- scripts/asset-pipeline-candidate.py
- scripts/asset-pipeline-rules.json
- scripts/prepare-camp-assets.py
- scripts/render-tiny-treats-previews.py
- scripts/fetch-provider-assets.py
- scripts/import-provider-assets.py
- scripts/update-spatial-thumbnail-aliases.py
- scripts/import-provider-characters.py
- scripts/prepare-modular-characters.py
- scripts/provider-character-binding.py
- scripts/modular-character-evidence.json
- scripts/verify-modular-character-appearance.py
- scripts/modular-character-sources.json
- scripts/import-provider-animations.py
- scripts/update-tiny-treats-walk-surfaces.py
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

正式人物使用六槽制作入口，基础身体与衣物分别输出；原始包和标准化预处理件位于本地来源目录，不进入发行包。以下示例使用本机 macOS 的 Blender 安装路径，其他电脑按实际位置调整：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python scripts/prepare-modular-characters.py --
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python scripts/legacy-character-clothing-blender-test.py --
go test ./internal/character ./internal/assets
go test ./internal/httpapi -run 'TestGraphicsAssetsHTTP'
npm run test:assets
```

标准化预处理件缺失时，先从配方对应的原始 KayKit 包恢复；预处理入口只写本地工作区，不更新正式目录：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python scripts/import-provider-characters.py -- --output-directory .local/3d-sources/modular-character-inputs-v3-complete
```

`scripts/modular-character-sources.json` 声明人物来源与拆分配方，模型和六槽定义由 `internal/character/character-catalog.json` 管理。人形和骷髅是基础身体，职业不再进入角色目录；脸与头皮属于形象，帽子和头发属于头部，披风和箭袋属于背部。中箭只制作头部插箭，使用来源包中的独立箭模型，不把整个战损头骨当成头饰。身体、脸、衣物与缩略图分别保留来源依据，新字节和元数据使用新资源身份。

可换色穿戴的制作配方指定独立材质与默认色，预设色来自 `internal/character/wearable-colors.json`。原有纯色布料直接指定底色。带贴图的部件在 Blender 导出后按 `scripts/modular-character-dye-regions.json` 分配三角面，通过 `uv` 锁定的 Pillow 环境生成保留明暗的中性贴图。加工保留顶点属性、蒙皮及固定部件的原贴图，默认颜色以原素材渲染为参考，缩略图显示原配色。退役背部部件仍从原套装的上衣网格分离，以免披风或披肩重新混入上装。

默认背心沿实际身体表面裁出圆领。领口沿左右对称的圆弧分段，切出的顶点沿原网格插值蒙皮权重。

原有 `scripts/prepare-3d-resources.py` 不再负责生成正式人物，避免重新引入旧四槽目录。模型与动作的来源和权利分别登记，原始 FBX 与加工工程仍留在 `.local/3d-sources/`。

家具与户外模型使用 `scripts/prepare-camp-assets.py` 整理，来源包分别放在 `.local/3d-sources/kenney-furniture/`、`kenney-nature/`、`kenney-survival/`。生活动作与书本工程保存在 `.local/3d-sources/living-actions/`，Mixamo 原始动作位于 `.local/3d-sources/mixamo/`。正式模型的实际边界、地面锚点、来源与加工参数分别登记在 `internal/assets/camp-source-manifest.json`、`camp-asset-metadata.json` 和 `camp-living-source.json`；座姿的靠近点与根位置由共享场景目录使用，不在浏览器按模型名称猜测。

扩充官方免费资源时，`scripts/fetch-provider-assets.py` 负责保存包级快照；原包及解压内容位于 `.local/3d-sources/provider-packs/`，来源、免费版本、原包校验值和许可依据记录在 `internal/assets/provider-pack-manifest.json`。免费与付费下载内容分别处理，不因为同属 CC0 就把付费文件记为免费取得。重新发现官方目录可能引入新版本，应核对清单差异，不能把重新抓取当作复现旧快照。

`scripts/import-provider-assets.py` 根据按来源维护的审核配置整理完整物件。完整物件库与本次选入清单分开：未选入物件和制作工程保留在本地，发行包只包含本次使用的 GLB、PNG 与元数据。源条目及范围排除、准备失败、本次选择均保留在 `internal/assets/provider-asset-manifest.json`，不能只检查商品总数就认定清单无遗漏。

Provider 构建候选时同步保留并补充历史缩略图到稳定物品的明确映射。独立的 `uv run --locked python scripts/update-spatial-thumbnail-aliases.py` 默认只输出本地候选文件，可用显式参数选择其他输入与输出。运行时只嵌入紧凑的 `internal/island/spatial-thumbnail-aliases.json`；旧发布记录与加工历史的来源指针和校验值保留在该文件中，不依靠名称或前缀猜测身份。启动初始化据此刷新旧报价的资源引用，同时保留管理配置和成交事实。

人物加工记录由 `internal/assets/provider-character-manifest.json` 保存。源模型中的裸露皮肤与骨骼要归回基础身体，职业衣物单独输出；原始骷髅缺少或被衣物替代的局部身体需要补齐，不能只隐藏衣服就宣称已得到完整裸身。身体分区的腰线、腕线和踝线不能裁掉保留款的原生配件，衣物保留自然边界和蒙皮。配方通过 `excluded_slots` 声明不交付的部件，这些部件不进入正式穿戴目录和初始报价，原始来源仍可用于验证。重复外观按实际几何与材质去重。补全后外观变得相同时，配方明确保留已存在的穿戴身份并共用资源，不再新增重复报价；这不修改已有商品名称和订单事实。

完整衣片和胸甲还须适配两种基础身体的实际表面，不能仅靠固定方盒缩放认定兼容。开襟衣物保留原开口与壳厚，并在静止和动作采样中核对主体、肩部与袖根是否露出；不能用隐藏整个躯干来掩盖衣甲陷入身体的问题。

形象需要包含完整裸脸和头皮，摘下胡须后也须保留嘴和下颌，头饰不能包含来源脸部。各穿戴的覆盖区域通过配方明确传给渲染器，帽子覆盖头皮时不影响眼鼻嘴；眉毛、胡须和围领不遮盖头皮。封闭鞋型覆盖基础脚掌，卸鞋后恢复基础脚部；默认裸头与穿帽、穿鞋与卸鞋都要检查。背部与上装分别制作，验证披风、箭袋是否跟随同一骨架。素材名称直接描述颜色、形状及实际包含的物件，不以来源职业或“旧版”代替外形。实际混穿与动作检查应绑定输出文件和组合，不能沿用旧人物的历史画面结果。

Kenney 人物的制作与验证入口已退出正式流程，建筑、家具和动物摆设仍使用各自的静态物件流程。原始下载包可以保留用于来源核对，不能因为保留原包就重新上架人物。

只读四向混穿入口使用当前正式 GLB，不更新模型、商品或清单。组合由 `scripts/modular-character-evidence.json` 声明，结果写入 `.local/modular-character-work/evidence/`：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python scripts/verify-modular-character-appearance.py --
```

逐件核对当前目录时，使用锁定的 Python 环境调度 Blender，并生成分页四向总览图。`--only` 可重复传入穿戴身份以复核单件，`--motion walk`、`--motion cheer` 用于增加动作采样；结果只写入指定检查目录：

```sh
uv run --locked python scripts/verify-modular-character-appearance.py --all-wearables --size 256 --page-size 6 --output .local/modular-character-work/review-v2
```

原始动作由 `scripts/import-provider-animations.py` 单独处理，并在 `provider-animation-manifest.json` 中记录已完成范围与剩余范围；预览按需加载，不能让正式人物页面下载全部原始动作。

除了 Go 素材检查，`npm run test:assets` 会逐个读取正式人物与服装的实际 GLB，核对身体分区范围、骨骼层级、逆绑定矩阵和蒙皮权重。这证明当前交付数据满足结构约束，仍需结合真实换装画面检查头饰、接缝和遮挡。资源获取、静态整理、人物整理与动作整理的 Python 检查各位于相应脚本旁，可单独执行；制作需要 Blender，正式运行不依赖制作工具。

人物与静态物件加工只要出现实际失败，本次命令即返回非零并保留已完成记录供恢复；明确排除的来源不算加工失败。人物清单在失败后标为未完成，重新加工成功也须重新验证，不能沿用旧画面检查自动宣称完成。恢复跳过前会检查已声明模型与缩略图是否存在，缺失时在本次运行直接重建。正式资源不可覆写：同标识同字节可复用，异字节拒绝并保留已有文件；人物 PNG 先在暂存位置渲染，制作时关闭日期、耗时等非确定元数据。新缩略图加工配方使用新资源身份，当前已交付文件不因工具升级被批量改写。

发行包运行不需要 Python 或 Blender。构建验证需检查实际 GLB 内嵌数据、目录引用与缩略图解码，正式包还需验证新进程能从持久素材目录读取相同字节。素材制作检查不代表已完成真实手机性能验收。

动作来源按 `scripts/provider-animation-sources.json` 中的审核批次处理，不按骨名扫描结果自动纳入非人形资源。导入脚本的 `--list` 查看批次，`--batch` 或 `--only` 选择范围，`--all` 处理全部审核来源；`--first-medium` 保留首批复现入口。增量执行核对来源与产物哈希，保留已完成记录；失败保留原因并返回非零。新加工在同一来源族内合并实际目标骨架和曲线相同的输出，来源记录仍分别保留；共享元数据登记该族的官方出处与许可，逐条来源登记实际素材包。原始水平根位移留在本地源文件，正式动作移除导航方向的根位移，垂直动作与身体摇摆继续保留。恢复时逐来源核对其实际使用的目标骨架，不能因第一批已更新全局检查点而跳过其他旧批次；缺少该依据的旧记录重新加工。去重和新资源身份包含来源族元数据、实际输出骨架与动作，目标骨架变化而曲线数值相同时也不能覆盖旧资源。当前动作列表只包含成功来源正在引用的定义；待处理批次不会把旧骨架动作留在当前列表，历史资源和文件继续保留。

Tiny Treats 房屋与景物由 `scripts/prepare-tiny-treats.py` 整理，来源与产物清单为 `internal/assets/tiny-treats-manifest.json`。普通 Python 使用 `--fetch-only` 获取审核过的免费源包；制作时在后台 Blender 中执行该脚本并传 `--only all`。`scripts/tiny-treats-blender-test.py` 在实际 GLB 上核对门洞、墙体和地板，`scripts/render-tiny-treats-previews.py` 生成四向外观与剖墙。原包、工程及中间产物保留在 `.local/3d-sources/tiny-treats/`，正式包只安装选入 GLB、PNG 和元数据。已有房屋无需重导出模型即可补齐支撑面：执行 `/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python scripts/update-tiny-treats-walk-surfaces.py`，再运行实际 GLB 检查。该入口只更新房型配置和清单，可用 `--models`、`--configuration`、`--manifest` 指向隔离路径。

装扮加工输出正式人物目录候选及版本素材引用。人物动作按骨架登记，阅读挂点和踢球触点与实际片段一起更新。可以先交付装扮素材，再发布新的动作绑定。商店的初始报价由商店种子提供。

### 素材分类、候选与应用

素材制作统一由 `npm run assets:pipeline --` 调度，操作为 `inventory`、`build`、`check` 和 `apply`。`inventory` 展示加工类型、入口及检查标准，不扫描或加工素材。加工类型由审核配置显式声明，不能从商品名称、来源前缀或商品的建筑分类猜测。静态建筑摆设采用完整物件流程；可进入房屋采用场景流程。动物摆设仍属于静态物件。来源人物标准化保留独立前置入口，其 `--output` 是 `--output-directory` 的别名。

来源人物标准化把已声明的完整腰部配饰与上装分别适配。`import-provider-characters.py --waist-reference GLB --waist-clearance 数值` 为下装指定实际裸腰和所需松量，参考只读取 `body_torso`、`body_legs`，不替换上装的参考与参数。参考文件、实际外链和显式参数参与加工指纹。制作新裸腰后应重新核对腰带内口和动作，不能继续用染成肤色的原裤壳撑大下装；新来源写独立版本目录，保留已有来源和验收字节。

制作配方的 `clothing_fit` 按穿戴键显式复用矩阵、渐变和蒙皮适配，披肩也可使用同一入口；旧上装的 `upper_clothing_fit` 保留为兼容入口。`back_clothing_fit` 表示衣物领背的局部空间场，可用于上装后背或披肩，不按业务槽位猜测几何范围。前后方向由现有轴向过渡端点及有符号偏移明确给出，既有正向设置保持原结果。

各制作入口的 `--output` 统一表示候选根，默认位于 `.local/asset-pipeline/`；模型及目录按 `internal/...` 镜像输出。`build` 默认要求空候选目录，避免不同批次混用。Provider 和动作入口允许对未完成目录显式使用 `build --resume`；动作入口还会核对原正式基线，已完成候选拒绝覆盖。其他入口仍使用新目录重建。直接调用脚本同样不更新正式目录。来源文件与正式目录只读，后续应用单独执行。旧的 `--catalog-output` 只在候选内输出目录片段。原始模型、配方、工具代码与实际外链文件属于加工依赖，任何一项变化后不能继续沿用旧验收。恢复时也须核对源文件的外链依赖和全部已声明产物；仅文件存在不足以复用。动作批次分别记录本次选择完成与全库待办，未选批次的过期记录不进入当前有效列表。

以下为后续显式执行的命令示例；修改流程代码本身不执行这些步骤：

```sh
npm run assets:pipeline -- inventory
npm run assets:pipeline -- build --pipeline characters --output .local/asset-pipeline/review-characters
npm run assets:pipeline -- check --output .local/asset-pipeline/review-characters
```

Tiny Treats 的几何制作与后续预览分别执行。先构建指定房屋或景物，再对同一候选执行预览阶段：

```sh
npm run assets:pipeline -- build --pipeline tiny-treats --output .local/asset-pipeline/house-review -- --only cottage
npm run assets:pipeline -- build --pipeline tiny-treats --stage previews --output .local/asset-pipeline/house-review
```

预览阶段只处理候选清单声明的房屋与场景，生成缩略图、剖墙证据及候选运行定义，保留先前几何来源与正式基线；重新生成清单后，旧检查结论自然失效。场景须在制作阶段显式用 `--scene` 选择；所需景物不足时记录缺口，不扩大加工范围。静态 Provider 候选同时生成历史缩略图映射，后续应用无需再运行会修改正式目录的补录命令。

可构建入口见 `scripts/asset-pipeline-rules.json` 中的 `pipelines`。候选 `candidate.json` 登记生成文件、明确复用的正式文件、构建前正式基线、依赖哈希和阶段状态。候选缺少资源时，只能使用 `reused-assets.json` 中已声明且哈希一致的正式资源；不能自动回落到任意正式文件。辅助复用清单不进入正式资源目录。

`check` 自动检查候选完整性、实际图片解码、合并后运行目录的引用闭包及实际生成的 GLB 格式，将分类检查计划写入 `checks.json`。检查按具体资产类型分配，混合管线中的墙体不承担动作检查，动画使用片段时间采样；房屋与固定景物分别采用场景、静态规则。人物按身体及兼容穿戴组合检查，不兼容穿戴、未知槽位和未分配模型均不能静默退出计划。来源组件、骨架、几何适配、场景通路和画面复核仍由现有专项工具或实际审查完成；未导入结论的必需项保持 `not_run`。Khronos 警告保持待复核，不能被总体零错误掩盖。`check --evidence 文件` 接收同一候选及规则哈希的专项结果；每条结果包含规则、状态、本次实际覆盖的案例列表，以及候选目录内证据文件的相对路径和实际哈希。同一规则可以分批导入，后续复核只替换相同案例，其他已完成案例继续保留；覆盖尚不完整时保持待复核。自动校验报告及其哈希始终保留，人工接受警告不能抹掉实际格式检查结果；`gltf` 复核记录还须提供 `automatic_sha256`，与该次 `gltf-check.json` 的哈希一致。检查器依赖或自动警告报告变化后，旧接受记录失效。检查器与实际读取的运行目录也参与证据核对。案例列表取自 `checks.json` 的 `plan`，不能用截图总数代替。全身及手臂画面入口均可传 `--sampling-plan scripts/asset-pipeline-rules.json`，以实际帧、时间和视角生成 `executed_coverage`。全身工具只证明对应视角，手臂工具只登记已实现的近景；肩、肘、腕等局部项目没有相机或专项结论时仍保留待办。渲染报告不是人工复核结论，不能直接作为 `visual: passed` 导入。格式错误不能通过外部结论豁免。

验收记录的结构如下，实际哈希和覆盖内容须来自当批文件：

```json
{
  "candidate_sha256": "候选清单哈希",
  "rules_sha256": "规则文件哈希",
  "results": [
    {
      "rule": "visual",
      "status": "passed",
      "coverage": ["来自当批计划的本次实际复核案例"],
      "evidence": [{"path": "review/visual.json", "sha256": "证据文件哈希"}]
    }
  ]
}
```

所有必需检查通过后，才可显式执行 `apply --output 候选目录`。应用重新核对候选、证据和受影响正式文件基线，使用已经验收的精确字节，不重新加工。候选清单按新旧资源目录的差集声明退役源码；应用先核对并归档到 `.local/asset-pipeline/retired/<候选摘要>/`，再将其移出编译目录。`.local/assets` 中已安装的历史资源保留，不改变商品所有权或订单。应用日志位于 `.local/asset-pipeline/application.json`，记录本批文件的精确旧字节和退役项；进程中断后使用 `apply --recover` 恢复，归档仍保留。恢复遇到其他人修改过的同一文件时拒绝覆盖，须先核对。锁仅覆盖应用过程，构建应使用独立目录。

应用完成仅表示文件更新，`application_checks` 仍为 `not_run`。随后按受影响边界执行实际程序、浏览器及发行检查，结果另行记录；不能把候选检查冒充应用回归。通用入口不自动启动程序、购买商品或改写数据库。

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

静态物件导入在各自候选的 `.local/3d-sources/provider-prepared/` 暂存目录使用 `.cache.json`。它核对源模型、实际缓冲和外链图片、加工参数及代码，并检查暂存产物和元数据；不一致或丢失时重新加工。缓存省去重复边界计算和封装，不跳过发布筛选、所有权规则或正式资源的不可变版本检查，也不自动推进人物与动画批次。

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

先在新数据库执行基础建表，再交互创建账户：

```sh
sudo -u island /srv/island/current/island version
sudo -u island /srv/island/current/island migrate -config /srv/island/config/app.yaml
sudo -u island /srv/island/current/island init -config /srv/island/config/app.yaml
```

初始化依次读取用户名、姓名、登录密码及确认、管理密码及确认。终端隐藏密码；密码不能放进命令参数。再次执行 `init` 可创建其他用户名的账户；重复用户名会拒绝。各账户初始余额为零，不导入演示任务、成绩、订单或浏览器数据。

两种密码默认 10–128 个 Unicode 码点。用户名初始化后不可修改；姓名与密码也可通过已解锁的网页管理界面维护。网页切换到普通页面时会撤销管理授权，再次进入需要重新输入管理密码；修改任一密码后，该账户的全部登录会话失效，其他账户不受影响。

组同样由服务器维护者创建，命令交互读取组名，重复名称会拒绝：

```sh
sudo -u island /srv/island/current/island create-group -config /srv/island/config/app.yaml
```

网页组设置提供已有组列表，加入、退出每次需要输入自己的管理密码。每人最多一组，加入任意已有组不需要其他成员批准。查看范围与退出规则见[账户与组](../FEATURES/ACCOUNT.md#组与成员查看)。新建账户会在同一事务中建立独立商品目录和空钱包；任一步失败都不创建账户，可排除故障后用原输入重新执行 `init`。

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
sudo -u island /srv/island/current/island reset-password -username 用户名 -kind login -config /srv/island/config/app.yaml
sudo -u island /srv/island/current/island reset-password -username 用户名 -kind management -config /srv/island/config/app.yaml
```

命令交互读取新密码及确认，并撤销指定账户的全部会话。多个账户时必须使用 `-username`；只有一个账户时可以省略。其他账户会话不受影响。它不改变用户名、姓名、余额或业务记录。不提供邮件、短信或网页“忘记密码”入口。

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
