# 成长营地 Spec

Spec 帮助 Coding Agent 找到完成任务所需的上下文，也帮助工程师理解系统行为和设计原因。源码、类型、OpenAPI、迁移和配置定义可执行的结构。专题解释业务规则、模块协作和取舍，测试验证具体行为。

初次了解项目，先读[系统概览](SYSTEM/OVERVIEW.md)。处理具体任务时，直接找相关专题。启动项目见 [README](../README.md)。

## 开发期数据规则

服务尚未发布。发布前的后续开发无需考虑兼容或迁移旧数据，结构或数据契约变化时可以重建开发库。重建是显式的开发操作，步骤见[运行手册](ENGINEERING/OPERATIONS.md#数据库迁移与不兼容处理)。

## 找到相关专题

- **已知任务**：从下表打开负责该规则的专题，按需要继续阅读相关专题。
- **已知文件或目录**：用仓库相对路径查专题开头的 `source` 和 `tests`。按完整路径段匹配文件和它的上级目录声明。查目录时，也看指向目录内文件的声明。多个专题命中时，结合 `summary`、`owns` 和实际调用关系，判断哪些规则受影响。路径没有命中或提供的上下文不足时，回到下表按任务查找。

| 要做什么 | 先读 | 涉及时再读 |
| --- | --- | --- |
| 理解模块协作、运行结构和需求边界 | [系统概览](SYSTEM/OVERVIEW.md) | 浏览器调用读[HTTP 协议](SYSTEM/HTTP_API.md)，持久化读[存储](SYSTEM/STORAGE.md) |
| 修改登录、姓名、密码、组关系或管理授权 | [账户与授权](FEATURES/ACCOUNT.md) | 请求权限读[HTTP 协议](SYSTEM/HTTP_API.md)，事务内复核读[存储](SYSTEM/STORAGE.md) |
| 修改任务、打卡、余额回收、日周月记录或统计 | [打卡与查询](FEATURES/CHECKIN.md) | 附件读[媒体](FEATURES/MEDIA.md)，发奖和回收读[存储](SYSTEM/STORAGE.md)，联动资格读[成就](FEATURES/ACHIEVEMENTS.md)和[营地](FEATURES/ISLAND.md) |
| 修改商品、购买、已购权益或奖励接口 | [商店](FEATURES/SHOP.md) | 账务读[存储](SYSTEM/STORAGE.md)，物品摆放读[营地](FEATURES/ISLAND.md) |
| 修改成就计算、徽章展示或成就文本佩戴 | [成就](FEATURES/ACHIEVEMENTS.md) | 记录、排期和删除读[打卡](FEATURES/CHECKIN.md) |
| 修改营地布置、活动资格或人物动作 | [营地](FEATURES/ISLAND.md) | 物品所有权读[商店](FEATURES/SHOP.md)，解锁条件读[打卡](FEATURES/CHECKIN.md) |
| 修改三维外观、素材或相关验证 | [三维外观](FEATURES/SHOP.md#三维外观保存)、[营地动效](FEATURES/ISLAND.md#动效资源与验证边界) | 素材制作和安装读[运行手册](ENGINEERING/OPERATIONS.md#三维资源制作与安装)，测试选择读[测试指南](ENGINEERING/TESTING.md) |
| 修改上传、录音或文件清理 | [媒体](FEATURES/MEDIA.md) | 鉴权读[HTTP 协议](SYSTEM/HTTP_API.md)，记录关联读[打卡](FEATURES/CHECKIN.md) |
| 修改管理页布局、通用页面交互、家庭留言或声音 | [界面与家庭互动](FEATURES/INTERFACE.md) | 具体交互规则读对应功能专题 |
| 修改接口、错误或重试 | [HTTP 协议](SYSTEM/HTTP_API.md) | 参数结构查 [OpenAPI](../api/openapi.yaml)，业务拒绝条件查对应功能专题 |
| 修改事务、钱包、日期或迁移 | [存储与一致性](SYSTEM/STORAGE.md) | 数据库升级和故障处置读[运行手册](ENGINEERING/OPERATIONS.md#数据库迁移与不兼容处理) |
| 构建、安装、发布或排障 | [运行手册](ENGINEERING/OPERATIONS.md) | 验证范围和环境限制读[测试指南](ENGINEERING/TESTING.md) |
| 选择测试或核对验证范围 | [测试指南](ENGINEERING/TESTING.md) | 结合受影响专题的 `tests` 选择实际要跑的测试 |

## 更新和验证

1. **修改前**，判断哪些稳定规则受影响，定位负责的专题，并核对事实源。已有契约与实现冲突时，先记录差异并确认预期。只移动源码或测试时，检查专题的路径引用。
2. **修改时**，同一规则只在负责的专题完整说明。把概念、正常流程、约束及失败恢复放在一起，交代设计原因。其他专题按需概括并链接，系统概览只在模块关系或整体描述变化时更新。完整字段表、私有实现、普通文案和配置值留在各自的事实源。出现独立职责才新增专题。移动或删除前，先安置独有内容并修复引用，历史过程由 Git 保留。
3. **修改后**，运行 `npm run check:spec`。改动[校验器](../scripts/check-spec.mjs)时，再运行 `npm run test:spec`。行为变更按受影响规则选择测试，并记录实际验证的结果和范围。

校验器一次汇报发现的元数据、归属和文件名重复、路径、一级标题、本地链接及索引导航问题。规则是否与实现一致、测试是否足以证明规则，需要结合源码和实际验证判断。

## 专题格式

专题按职责放在 `spec/<职责目录>/<专题>.md`，当前分为 `SYSTEM`、`FEATURES` 和 `ENGINEERING`。每篇只有一个一级标题，文件名忽略大小写后全局唯一。每篇专题都从本页直接链接，素材预览若需保存，放在 `spec/assets/`。

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

`summary` 写成一行，`owns` 中的规则名全局唯一。`source` 和 `tests` 只列直接相关的仓库相对路径，可以引用与专题职责一致的模块目录。列表项直接填写，没有准确入口时用 `[]`。`tests` 列出可选的验证入口，结果以实际执行为准。
