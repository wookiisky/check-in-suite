# 成长营地 Spec

这里维护成长营地当前的行为、设计原因和修改约束。先按任务找到负责该规则的专题，再读其中的源码与测试入口；通常不需要通读全部文档。项目启动见 [README](../README.md)。

## 从任务开始

| 要做什么 | 从哪里读 | 何时继续阅读 |
| --- | --- | --- |
| 理解系统、判断需求边界 | [系统概览](SYSTEM/OVERVIEW.md) | 涉及数据一致性时读存储；涉及浏览器调用时读 HTTP |
| 修改登录、姓名、密码或管理授权 | [账户与授权](FEATURES/ACCOUNT.md) | HTTP 约束、事务内权限复核分别见 HTTP、存储 |
| 修改任务、打卡、余额回收、日周月记录或统计 | [打卡与查询](FEATURES/CHECKIN.md) | 发奖和回收读存储；附件读媒体；连动资格读成就、营地 |
| 修改购买、装扮或奖励兑现 | [商店与装扮](FEATURES/SHOP.md) | 账务读存储，摆放和物品互动读营地 |
| 修改成就计算或徽章佩戴 | [成就](FEATURES/ACHIEVEMENTS.md) | 记录、排期和删除规则读打卡 |
| 修改营地布置、活动资格或动画 | [营地](FEATURES/ISLAND.md) | 所有权读商店，任务解锁读打卡 |
| 修改上传、录音或文件清理 | [媒体](FEATURES/MEDIA.md) | 鉴权读 HTTP，记录关联读打卡 |
| 修改通用页面交互、家庭留言或声音 | [界面与家庭互动](FEATURES/INTERFACE.md) | 具体业务交互继续读对应功能专题 |
| 修改接口、错误或重试 | [HTTP 协议](SYSTEM/HTTP_API.md) | 参数结构查 OpenAPI，业务拒绝条件查功能专题 |
| 修改事务、钱包、日期或迁移 | [存储与一致性](SYSTEM/STORAGE.md) | 实际安装和故障处置读运行手册 |
| 构建、安装、升级或排障 | [运行手册](ENGINEERING/OPERATIONS.md) | 验证范围和环境限制读测试指南 |
| 选择测试、了解证据边界 | [测试指南](ENGINEERING/TESTING.md) | 用专题的 tests 定位候选，按改动选择实际验证 |

## 从文件开始

| 已知路径 | 对应专题 |
| --- | --- |
| `cmd/island/`、`internal/config/`、`scripts/`、`deploy/` | 系统概览、运行手册、测试指南；文档校验脚本见本页 |
| `api/openapi.yaml`、`internal/httpapi/`、`web/src/api/` | HTTP 协议及端点对应功能 |
| `internal/storage/`、`internal/core/`、`internal/wallet/`、`internal/idempotency/`、`migrations/` | 存储与一致性、HTTP 协议 |
| `internal/account/`、`web/src/features/account/` | 账户与授权 |
| `internal/checkin/`、`web/src/features/checkin/`、`web/src/features/reports/` | 打卡与查询；成就和活动资格按改动扩展 |
| `internal/shop/`、`internal/assets/`、`web/src/features/shop/`、`web/src/features/character/` | 商店与装扮；营地使用同一所有权及素材 |
| `internal/achievement/`、`web/src/features/achievements/` | 成就 |
| `internal/island/`、`web/src/features/island/` | 营地 |
| `internal/media/`、`web/src/features/media/` | 媒体 |
| `internal/message/`、`web/src/features/family/`、`web/src/components/`、`web/src/feedback/` | 界面与家庭互动 |
| `internal/demo/` | 运行手册中的测试数据初始化 |

一个文件可能参与多个规则。先看相关专题的 `summary` 和 `owns` 确定归属；索引未列出的文件使用目录和符号搜索，不需要维护第二份注册表。

## 写作和维护

1. 先核对源码、类型、OpenAPI、迁移、配置和测试，再修改文档。已确认契约与实现冲突时，记录差异并确认处理方向，不能把当前实现自动当作正确契约。
2. 同一稳定规则只在一个专题完整维护，其他专题概括并链接。概念、正常流程、例外和恢复条件放在一起，说明为什么这样设计。
3. 行为变化时同步负责该规则的专题；只在协作关系或概括变化时更新系统概览。私有实现、普通文案和配置值优先留在可执行来源，不复制完整字段表。
4. 新专题只为已有事实建立，加入本页导航。移动或删除前确认独有内容已有归属，并修复引用；历史过程由 Git 保留。
5. 运行 `npm run check:spec`；本次修改了校验器时再运行 `npm run test:spec`。说明本次实际检查和未验证项，不把元数据中的候选测试当作已经通过。

专题放在 `spec/<职责目录>/<专题>.md`，当前使用 SYSTEM、FEATURES、ENGINEERING。文件名在专题间忽略大小写后唯一，每篇只有一个一级标题。暂不增加目录索引、Context 文件或独立治理文档；素材预览放在 `spec/assets/`，不属于专题。

每篇专题使用以下四个字段。为便于维护，采用单行摘要、普通列表或空列表 `[]`，列表项不加引号，不使用复杂 YAML 写法：

```yaml
---
summary: 一句话说明本文负责的事实和边界。
owns:
- example.behavior
source:
- internal/example/service.go
tests: []
---
```

`owns` 是全局唯一的规则名称；只为有实际维护价值的事实命名，不另设分类白名单。`source` 和 `tests` 使用仓库根目录相对路径，指向直接相关的真实文件或模块目录，没有准确入口时用空列表。共享源码可以出现在不同专题；目录级引用适用于专题确实负责整个模块的情况。

校验器检查元数据、归属与文件名唯一性、路径、一级标题、本地文件及标题链接，以及根索引是否包含每篇专题。它一次报告发现的错误，不生成导航，也不判断文字是否正确或业务测试是否充分。本地链接采用常规 Markdown 内联链接和标题锚点。

## 迁移后的内容归属

原产品和技术方案按能力合并为以上专题，旧任务清单中的有效决定归入对应规则，历史验收的限制保存在测试指南。旧静态原型、原型截图及阶段计划已退出当前文档系统，历史可从 Git 查阅。

素材预览保留为辅助资料：[素材分类预览](assets/materials.html)、[素材总览图](assets/materials-overview.png)、[人物与发型预览](assets/human-avatars.html)、[人物预览图](assets/human-avatars.png)。另保留本轮人物效果截图：[桌面衣柜](assets/character-wardrobe-desktop.png)、[手机衣柜](assets/character-wardrobe-mobile.png)、[桌面营地](assets/character-island-desktop.png)、[手机营地](assets/character-island-mobile.png)。这些预览用于查看外观，当前可用能力和素材身份以源码目录为准。

本系统参考 Cortex 的 Spec 维护方法，保留唯一入口、规则归属和事实源映射；运行不依赖其他仓库。
