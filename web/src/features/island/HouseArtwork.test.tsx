import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HouseArtwork, HousePartitionArtwork, bathroomPartitions } from './HouseArtwork';

describe('家庭房屋剖面', () => {
  it.each([false, true])('房屋款式 cottage=%s 展开后移除屋顶前墙并保留地板和后墙', (cottage) => {
    const { container, rerender } = render(<svg><HouseArtwork indoor={false} cottage={cottage} /></svg>);
    expect(container.querySelector('[data-house-roof]')).not.toBeNull();
    expect(container.querySelector('[data-house-front]')).not.toBeNull();
    rerender(<svg><HouseArtwork indoor cottage={cottage} /></svg>);
    expect(container.querySelector('[data-house-roof]')).toBeNull();
    expect(container.querySelector('[data-house-front]')).toBeNull();
    expect(container.querySelector('[data-house-floor]')).not.toBeNull();
    expect(container.querySelector('[data-house-back]')).not.toBeNull();
    expect(container.querySelector('[data-bathroom-floor]')).not.toBeNull();
  });

  it('隔墙可以独立插入家具绘制顺序，不随整个房屋一起盖住室内物件', () => {
    const { container } = render(<svg><HouseArtwork indoor cottage={false} />{bathroomPartitions.map((wall) => <HousePartitionArtwork key={wall.id} segment={wall.id} />)}</svg>);
    expect(container.querySelectorAll('[data-house-partition]')).toHaveLength(bathroomPartitions.length);
    expect(bathroomPartitions.every((wall) => Number.isFinite(wall.depth))).toBe(true);
    expect(new Set(bathroomPartitions.map((wall) => wall.depth)).size).toBe(bathroomPartitions.length);
  });

  it('展开时保留凸窗、窗帘、壁灯和门廊地板，收起会挡住室内的门廊屋檐', () => {
    const { container, rerender } = render(<svg><HouseArtwork indoor cottage={false} /></svg>);
    const back = container.querySelector('[data-house-back]');
    expect(back?.querySelector('[data-house-bay]')).not.toBeNull();
    expect(back?.querySelector('[data-house-curtains]')).not.toBeNull();
    expect(back?.querySelector('[data-house-wall-light]')).not.toBeNull();
    expect(container.querySelector('[data-house-porch-floor]')).not.toBeNull();
    expect(container.querySelector('[data-house-porch-roof]')).toBeNull();
    rerender(<svg><HouseArtwork indoor={false} cottage={false} /></svg>);
    expect(container.querySelector('[data-house-front] [data-house-bay]')).not.toBeNull();
    expect(container.querySelector('[data-house-porch-roof]')).not.toBeNull();
  });

});
