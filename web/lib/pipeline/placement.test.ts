import { describe, expect, it } from 'vitest';
import { placeCard, THREAD_CARD_W } from './placement';

const WINDOW = { width: 1200, height: 800 };

describe('placeCard', () => {
  it('hangs the card below an anchor in the upper half of the window', () => {
    expect(placeCard({ left: 300, top: 100, bottom: 200 }, WINDOW)).toEqual({
      left: 300,
      top: 208,
    });
  });

  it('puts the card above an anchor in the lower half, so it stays in the window', () => {
    expect(placeCard({ left: 300, top: 600, bottom: 700 }, WINDOW)).toEqual({
      left: 300,
      bottom: 208,
    });
  });

  it('moves the card left when it would cross the right edge', () => {
    const { left } = placeCard({ left: 1100, top: 100, bottom: 200 }, WINDOW);

    expect(left + THREAD_CARD_W).toBeLessThan(WINDOW.width);
  });

  it('never starts left of the window, even in a narrow one', () => {
    expect(placeCard({ left: -40, top: 0, bottom: 10 }, WINDOW).left).toBe(8);
    expect(placeCard({ left: 50, top: 0, bottom: 10 }, { width: 200, height: 800 }).left).toBe(8);
  });
});
