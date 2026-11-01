import { Mesh } from 'three';
import type { Object3D } from 'three';

export const sampleSlots = ['hair', 'upper', 'lower', 'shoes'] as const;
export type SampleSlot = typeof sampleSlots[number];
export type SampleAppearance = Record<SampleSlot, string>;

// 样片部件登记实际节点和遮盖区域，不依据商品名称判断能力。
export interface SampleWearable {
  id: string; // 当前身体规格内的部件身份。
  nodes: readonly string[]; // 该部件的实际网格。
  covers: readonly string[]; // 被隐藏的身体区域。
}

// 这是 P0 素材描述；业务接口要等样片通过后再在 P1 定义。
export interface CharacterSampleDefinition {
  model_url: string; // 同源 GLB。
  scale: number; // 转换到样片目标身高的统一倍率。
  rig_id: string; // 骨架绑定姿势的身份。
  fixed_nodes: readonly string[]; // 面部和手等始终可见的网格。
  body_regions: Readonly<Record<string, readonly string[]>>; // 可按服装覆盖的身体分区。
  slots: Record<SampleSlot, readonly SampleWearable[]>; // 四槽的已加工部件。
  defaults: SampleAppearance; // 四槽免费默认项。
}

// 先完整解析选择，再一次更新节点，错误选择不能留下半套外观。
export function applySampleAppearance(root: Object3D, definition: CharacterSampleDefinition, appearance: SampleAppearance) {
  const selected = sampleSlots.map((slot) => {
    const option = definition.slots[slot].find((candidate) => candidate.id === appearance[slot]);
    if (!option) throw new Error(`SAMPLE_WEARABLE_MISSING: ${slot}/${appearance[slot]}`);
    return option;
  });
  const covered = new Set(selected.flatMap((option) => option.covers));
  const visible = new Set([
    ...definition.fixed_nodes,
    ...Object.entries(definition.body_regions).filter(([region]) => !covered.has(region)).flatMap(([, nodes]) => nodes),
    ...selected.flatMap((option) => option.nodes),
  ]);
  root.traverse((node) => { if (node instanceof Mesh) node.visible = visible.has(node.name); });
}

// 枚举当前四槽所有真实部件组合，供样片静态和动作检查。
export function sampleAppearanceCombinations(definition: CharacterSampleDefinition): SampleAppearance[] {
  return sampleSlots.reduce((combinations, slot) => combinations.flatMap((appearance) => definition.slots[slot].map((option) => ({ ...appearance, [slot]: option.id }))), [{ ...definition.defaults }]);
}
