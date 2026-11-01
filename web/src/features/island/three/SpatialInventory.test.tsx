import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SpatialInventory } from './SpatialInventory';
import { inventoryFixture } from './spatial-inventory-test-fixtures';
import content from './spatial-content.json';
import browserContent from './spatial-inventory-content.json';

describe('营地完整库存浏览', () => {
  it('其他场景占用的实例显示去向并禁止直接复制摆放', () => {
    const props = inventoryFixture(2);
    props.state.inventory[0]!.placed_scene_key = 'forest-courtyard-v1';
    render(<SpatialInventory {...props} sceneNames={{'forest-courtyard-v1':'林间草地庭院'}} />);
    expect(screen.getByRole('button', {name:'摆放摆设 0'})).toBeDisabled();
    expect(screen.getByText(browserContent.placedElsewhere.replace('{name}','林间草地庭院'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'摆放摆设 0'}));
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it('无房场景禁用室内入口，但仍能布置户外并收起主屋', () => {
    const props = inventoryFixture(2);
    props.state.scene.house = null;
    render(<SpatialInventory {...props} />);
    expect(screen.getByRole('button', {name:content.indoorItems})).toBeDisabled();
    expect(screen.getByRole('button', {name:content.outdoorItems})).toBeEnabled();
    expect(screen.getByRole('button', {name:'摆放摆设 0'})).toBeEnabled();
  });
  it('收起主屋后仍能管理并收起已有室内草稿，不能添加或移动室内物品',()=>{
    const props=inventoryFixture(2);
    props.state.scene.house=null;
    const existing={instance_id:'owned-0',item_key:'item-0',space:'indoor' as const,x_cm:0,z_cm:0,rotation:0};
    props.state.placements=[existing];
    render(<SpatialInventory {...props} space="indoor" selected={existing} />);
    expect(screen.getByRole('button',{name:content.indoorItems})).toBeEnabled();
    expect(screen.getByRole('button',{name:content.select.replace('{name}','摆设 0')})).toBeEnabled();
    expect(screen.queryByRole('button',{name:content.add.replace('{name}','摆设 1')})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:content.moveRight})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:content.store}));
    expect(props.onStore).toHaveBeenCalledOnce();
  });
  it('只分批呈现列表，缩略图延迟加载，选择和保存保留完整库存', () => {
    const props = inventoryFixture();
    render(<SpatialInventory {...props} />);
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(24);
    expect(document.querySelectorAll('.spatial-inventory-list img')).toHaveLength(24);
    expect(document.querySelector('.spatial-inventory-list img')).toHaveAttribute('loading', 'lazy');
    fireEvent.click(screen.getByRole('button', { name: browserContent.loadMore }));
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: browserContent.loadMore }));
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(54);
    expect(screen.queryByRole('button', { name: browserContent.loadMore })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '摆放摆设 53' }));
    expect(props.onChoose).toHaveBeenCalledWith('owned-53');
    fireEvent.click(screen.getByRole('button', { name: content.save }));
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.state.inventory).toHaveLength(55);
  });

  it('按来源、素材包、类别和名称筛选，并在条件变化后重新分批', () => {
    const props = inventoryFixture();
    render(<SpatialInventory {...props} />);
    fireEvent.click(screen.getByRole('button', { name: browserContent.loadMore }));
    fireEvent.change(screen.getByRole('combobox', { name: browserContent.provider }), { target: { value: 'kenney' } });
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(24);
    fireEvent.change(screen.getByRole('combobox', { name: browserContent.pack }), { target: { value: 'furniture-kit' } });
    fireEvent.change(screen.getByRole('combobox', { name: browserContent.category }), { target: { value: 'furniture' } });
    fireEvent.change(screen.getByRole('searchbox', { name: browserContent.search }), { target: { value: '摆设 52' } });
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '摆放摆设 52' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: browserContent.clearFilters }));
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(24);
    expect(props.onChoose).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('区分没有匹配项与没有库存，保留旧物品及稳定的重复实例名称', () => {
    const props = inventoryFixture(1);
    const original = props.state.catalog[0]!;
    delete original.provider; delete original.pack_key; delete original.pack_name; delete original.category;
    props.state.inventory.push({ instance_id: 'second', item_key: 'item-0' });
    render(<SpatialInventory {...props} space="indoor" />);
    expect(screen.getByRole('option', { name: browserContent.builtin })).toBeInTheDocument();
    const secondName = content.additionalInstance.replace('{name}', '摆设 0').replace('{number}', '2');
    fireEvent.click(screen.getByRole('button', { name: content.add.replace('{name}', secondName) }));
    expect(props.onChoose).toHaveBeenCalledWith('second');
    fireEvent.change(screen.getByRole('searchbox', { name: browserContent.search }), { target: { value: '未购买的物品' } });
    expect(screen.getByText(browserContent.noMatches)).toBeInTheDocument();
    expect(screen.queryByText(content.emptyInventory)).not.toBeInTheDocument();
  });

  it('切换空间重置列表批次，忙碌时仍可筛选但不能选择物品', () => {
    const props = inventoryFixture();
    const view = render(<SpatialInventory {...props} />);
    fireEvent.click(screen.getByRole('button', { name: browserContent.loadMore }));
    view.rerender(<SpatialInventory {...props} space="indoor" busy />);
    expect(screen.getAllByRole('button', { name: /^摆放摆设 / })).toHaveLength(24);
    expect(screen.getByRole('button', { name: '摆放摆设 0' })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox', { name: browserContent.search }), { target: { value: '摆设 54' } });
    expect(screen.getByRole('button', { name: '摆放摆设 54' })).toBeDisabled();
    expect(props.state.inventory).toHaveLength(55);
  });
});
