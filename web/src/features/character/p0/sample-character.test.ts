import { describe, expect, it } from 'vitest';
import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, VectorKeyframeTrack } from 'three';
import { createSampleCharacter } from './sample-character';

// 用真实骨架和动画验证实例隔离，不以普通 Object3D 克隆代替蒙皮绑定。
function riggedModel() {
  const scene = new Group();
  const bone = new Bone(); bone.name = 'root';
  const geometry = new BoxGeometry();
  const count = geometry.attributes.position!.count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) weights[index * 4] = 1;
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const body = new SkinnedMesh(geometry, new MeshBasicMaterial()); body.name = 'Body';
  scene.add(bone, body); body.bind(new Skeleton([bone]));
  const accessory = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); accessory.name = 'Weapon'; scene.add(accessory);
  const animation = new AnimationClip('Idle', 1, [new VectorKeyframeTrack('root.position', [0, 1], [0, 0, 0, 0, 1, 0])]);
  return { scene, animations: [animation], body, bone, accessory };
}

describe('P0 人物实例', () => {
  it('首次播放立即求值首帧，减少动效时也显示动作姿势', () => {
    const source = riggedModel();
    const pose = new AnimationClip('Pose', 1, [new VectorKeyframeTrack('root.position', [0, 1], [0, 2, 0, 0, 3, 0])]);
    const instance = createSampleCharacter(source.scene, [pose]);
    instance.play('Pose');
    expect(instance.root.getObjectByName('root')!.position.y).toBe(2);
    instance.dispose();
  });

  it('骨架和动画属于各自实例，几何缓存保留共享且源模型不变', () => {
    const source = riggedModel();
    const first = createSampleCharacter(source.scene, source.animations);
    const second = createSampleCharacter(source.scene, source.animations);
    const firstMesh = first.root.getObjectByName('Body') as SkinnedMesh;
    const secondMesh = second.root.getObjectByName('Body') as SkinnedMesh;
    expect(firstMesh.geometry).toBe(source.body.geometry);
    expect(firstMesh.skeleton).not.toBe(secondMesh.skeleton);
    expect(firstMesh.skeleton.bones[0]).not.toBe(source.bone);
    first.play('Idle'); second.play('Idle'); first.mixer.update(0.5); second.mixer.update(0.25);
    expect(firstMesh.skeleton.bones[0]!.position.y).toBeCloseTo(0.5);
    expect(secondMesh.skeleton.bones[0]!.position.y).toBeCloseTo(0.25);
    expect(source.bone.position.y).toBe(0);
    expect(first.root.getObjectByName('Weapon')?.visible).toBe(false);
    expect(source.accessory.visible).toBe(true);
    first.dispose(); second.dispose();
    expect(source.body.geometry.attributes.position).toBeDefined();
  });

  it('拒绝不存在的动作，释放一个实例不会终止另一个实例的动作', () => {
    const source = riggedModel();
    const first = createSampleCharacter(source.scene, source.animations);
    const second = createSampleCharacter(source.scene, source.animations);
    expect(() => first.play('Missing')).toThrow('Missing');
    first.play('Idle'); second.play('Idle'); first.dispose(); second.mixer.update(0.5);
    expect(second.root.getObjectByName('root')!.position.y).toBeCloseTo(0.5);
    second.dispose();
  });
});
