# KayKit 四槽人物样片

该模型从 KayKit Adventurers 1.0 的 Rogue 与 Barbarian 加工而来，源修订为 `672074b73ba276876a19e8816ecdc5241817ab47`，许可为 [CC0](LICENSE.txt)。加工过程由 [首件准备脚本](../../../../../scripts/prepare-p0-character.py)记录；它针对这两个已检查的源模型，没有提供通用模型生成或自动服装适配能力。

## 身体与部件

[人物描述](character.json)登记骨架、默认选择、固定身体节点、可覆盖的身体分区，以及四个部位的可选节点。运行时应先解析整套选择，再同时更新部件与身体分区的可见性。

两种头部选项分别为 Rogue 短发与 Barbarian 光头短须。后者包含源模型的胡须及眉毛，不包含头顶头发，因此不能隐藏补做的头皮。上衣、下装与鞋子分别拥有两种实际几何，来源于两个原人物；没有使用配色替换来增加选项数量。

加工时按源纹理中的明确单元分离头发与皮肤，再沿统一腰线、腕线及鞋口切开网格、封闭切面并保留蒙皮。不同款式的腰部和鞋口收敛到同一截面。原始尺寸与 Rogue 骨架保留；实例根节点使用描述中的 `scale` 将最高短发形象缩放到约 1.8 米。

头部和手部为固定节点。头皮及衣服内部的身体分区经过补做或收紧，供服装覆盖与动画使用。这些内部网格没有按裸露人物的外观制作，不应直接作为裸露身体商品使用。

## 复现与检查

现有样片使用 Blender 4.5 制作。再次加工前，先将原始 `Rogue.glb` 与 `Barbarian.glb` 放入仓库的 `.local/3d-sources/kaykit-adventurers/Characters/gltf/`，并将原许可放入该源目录。当前统一调用全局安装的 Blender，以下使用本机 macOS 路径：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/prepare-p0-character.py
node --test scripts/p0-character-assets.test.mjs
```

全局安装与版本验证边界见[运行手册](../../../../../spec/ENGINEERING/OPERATIONS.md#codex-连接-blender)。切换全局工具后尚未重新加工本样片，因此不能据此认定新版本的加工结果与 Blender 4.5 一致。

脚本将运行资源写入本目录，将可继续编辑的 Blender 工程保存在 `.local/3d-sources/character-work/`。测试检查实际 GLB 中的独立几何、共同骨架、蒙皮权重、原地动作，以及加工前后的骨骼层级和逆绑定矩阵；这些结构检查不能替代混搭与动作的视觉检查。

GLB 内嵌纹理，并保留待机、行走、跑步、坐下和抬手五个源动作。Mixamo 补充动作由另一份资源登记和交付，不混用 KayKit 的许可声明。
