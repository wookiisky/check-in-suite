import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScenePicker } from './ScenePicker';
import content from './scene-picker-content.json';

describe('独立场景选择',()=>{
  it('已拥有场景可前往，未拥有场景只提供购买入口',()=>{
    const onChoose=vi.fn(),onPurchase=vi.fn();
    render(<ScenePicker scenes={[{scene_key:'seaside-v1',name:'海边',thumbnail_url:'/sea.png',free:true,owned:true},{scene_key:'forest-courtyard-v1',name:'林间',thumbnail_url:'/forest.png',free:false,owned:true},{scene_key:'lakeside-garden-v1',name:'湖畔',thumbnail_url:'/lake.png',free:false,owned:false}]} current="seaside-v1" loading={false} error={null} onChoose={onChoose} onPurchase={onPurchase} onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button',{name:content.current})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:content.go.replace('{name}','林间')}));
    expect(onChoose).toHaveBeenCalledWith('forest-courtyard-v1');
    fireEvent.click(screen.getByRole('button',{name:content.buy.replace('{name}','湖畔')}));
    expect(onPurchase).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});
