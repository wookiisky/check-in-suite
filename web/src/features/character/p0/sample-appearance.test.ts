import { describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { applySampleAppearance, sampleAppearanceCombinations } from './sample-appearance';
import type { CharacterSampleDefinition } from './sample-appearance';

// 名称只属于这个测试模型；校验真实 GLB 引用由素材检查与浏览器承担。
const definition: CharacterSampleDefinition = {
  model_url: '/fixture.glb', scale: 1, rig_id: 'fixture', fixed_nodes: ['face'],
  body_regions: { torso: ['body'], feet: ['feet'] },
  slots: {
    hair: [{ id: 'short', nodes: ['short'], covers: [] }, { id: 'long', nodes: ['long'], covers: [] }],
    upper: [{ id: 'shirt', nodes: ['shirt'], covers: ['torso'] }, { id: 'vest', nodes: ['vest'], covers: [] }],
    lower: [{ id: 'trousers', nodes: ['trousers'], covers: [] }, { id: 'shorts', nodes: ['shorts'], covers: [] }],
    shoes: [{ id: 'boots', nodes: ['boots'], covers: ['feet'] }, { id: 'sandals', nodes: ['sandals'], covers: [] }],
  },
  defaults: { hair: 'short', upper: 'shirt', lower: 'trousers', shoes: 'boots' },
};

// 在真实 Three 场景节点上检查可见性，避免只比较配置的拷贝。
function model() {
  const root = new Group();
  for (const name of ['face', 'body', 'feet', 'short', 'long', 'shirt', 'vest', 'trousers', 'shorts', 'boots', 'sandals']) {
    const node = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); node.name = name; root.add(node);
  }
  return root;
}

describe('P0 四槽换装', () => {
  it('逐槽独立替换实际节点，同时恢复不再被覆盖的身体', () => {
    const root = model();
    applySampleAppearance(root, definition, definition.defaults);
    expect(root.getObjectByName('face')!.visible).toBe(true);
    expect(root.getObjectByName('body')!.visible).toBe(false);
    expect(root.getObjectByName('feet')!.visible).toBe(false);
    applySampleAppearance(root, definition, { ...definition.defaults, upper: 'vest' });
    expect(root.getObjectByName('vest')!.visible).toBe(true);
    expect(root.getObjectByName('shirt')!.visible).toBe(false);
    expect(root.getObjectByName('body')!.visible).toBe(true);
    expect(root.getObjectByName('boots')!.visible).toBe(true);
    expect(root.getObjectByName('short')!.visible).toBe(true);
  });

  it('枚举四槽笛卡尔积，每一组合恰好显示各槽的一个实际部件', () => {
    const combinations = sampleAppearanceCombinations(definition);
    expect(combinations).toHaveLength(16);
    expect(new Set(combinations.map((value) => JSON.stringify(value))).size).toBe(16);
    for (const appearance of combinations) {
      const root = model();
      applySampleAppearance(root, definition, appearance);
      for (const options of Object.values(definition.slots)) {
        expect(options.filter((option) => option.nodes.every((name) => root.getObjectByName(name)!.visible))).toHaveLength(1);
      }
    }
  });

  it('无效选择不改变已经显示的组合', () => {
    const root = model(); applySampleAppearance(root, definition, definition.defaults);
    const before = root.children.map((node) => node.visible);
    expect(() => applySampleAppearance(root, definition, { ...definition.defaults, hair: 'missing' })).toThrow('missing');
    expect(root.children.map((node) => node.visible)).toEqual(before);
  });
});
