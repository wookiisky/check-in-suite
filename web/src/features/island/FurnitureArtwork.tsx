import bed from '../../../../internal/assets/builtin/island-bed-v1.svg?raw';
import diningTable from '../../../../internal/assets/builtin/island-dining-table-v1.svg?raw';
import diningChair from '../../../../internal/assets/builtin/island-dining-chair-v1.svg?raw';
import sofa from '../../../../internal/assets/builtin/island-sofa-v1.svg?raw';
import coffeeTable from '../../../../internal/assets/builtin/island-coffee-table-v1.svg?raw';
import television from '../../../../internal/assets/builtin/island-television-v1.svg?raw';
import cabinet from '../../../../internal/assets/builtin/island-cabinet-v1.svg?raw';
import refrigerator from '../../../../internal/assets/builtin/island-refrigerator-v1.svg?raw';
import kitchenCounter from '../../../../internal/assets/builtin/island-kitchen-counter-v1.svg?raw';
import toilet from '../../../../internal/assets/builtin/island-toilet-v1.svg?raw';
import washbasin from '../../../../internal/assets/builtin/island-washbasin-v1.svg?raw';
import shower from '../../../../internal/assets/builtin/island-shower-v1.svg?raw';

// 受控内置素材同时服务商店与场景，场景保留真实轮廓作为命中范围。
const furnitureSources: Readonly<Record<string, string>> = {
  'island-bed-v1': bed,
  'island-dining-table-v1': diningTable,
  'island-dining-chair-v1': diningChair,
  'island-sofa-v1': sofa,
  'island-coffee-table-v1': coffeeTable,
  'island-television-v1': television,
  'island-cabinet-v1': cabinet,
  'island-refrigerator-v1': refrigerator,
  'island-kitchen-counter-v1': kitchenCounter,
  'island-toilet-v1': toilet,
  'island-washbasin-v1': washbasin,
  'island-shower-v1': shower,
};

// 根 SVG 的 viewBox 用于缩略图；场景直接使用同一内容中的地面坐标。
const furnitureShapes: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(furnitureSources).map(([model, source]) => [model, source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))]),
);

// 只有显式导入的本地素材能进入内联路径，不接受上传或服务端 HTML。
export function supportsFurnitureArtwork(model: string): boolean {
  return Object.hasOwn(furnitureShapes, model);
}

// 不创建透明命中矩形，阴影在源 SVG 中禁用指针事件，空白处可选中后方物件。
export function FurnitureArtwork({ model }: { model: string }) {
  const shapes = furnitureShapes[model];
  if (!shapes) return null;
  return <g data-furniture-model={model} fill="none" dangerouslySetInnerHTML={{ __html: shapes }} />;
}
