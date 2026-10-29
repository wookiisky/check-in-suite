import type { Equipment } from './types';
import { assetURL } from './helpers';
import content from './content.json';
import { CharacterStage } from './CharacterStage';
import type { StageEditor } from './CharacterStage';
import './shop.css';

// 主页和衣柜共用画布，背景、角色、饰品与固定特效保持同一展示规则。
export function CharacterPanel({
  equipment,
  displayName,
  reduceMotion = false,
  editor,
}: {
  equipment: Equipment;
  displayName: string;
  reduceMotion?: boolean;
  editor?: StageEditor;
}) {
  return (
    <section className="shop-character" aria-label={content.character}>
      <h3>{displayName}</h3>
      {equipment.title ? (
        <p className="shop-character-title">
          <img src={assetURL(equipment.title.asset_key_snapshot)} alt="" />
          {equipment.title.name_snapshot}
        </p>
      ) : (
        <p className="shop-hint">{content.emptyTitle}</p>
      )}
      <CharacterStage equipment={equipment} reduceMotion={reduceMotion} {...(editor ? { editor } : {})} />
    </section>
  );
}
