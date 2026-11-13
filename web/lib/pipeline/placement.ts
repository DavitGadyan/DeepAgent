/** Where the thread hover card goes on the page, next to the card it describes. */
import type { Size } from './layout';

/** Mirrored in app/pipeline.css (.tc). */
export const THREAD_CARD_W = 288;
const MARGIN = 8;
const GAP = 8;

/** The part of a DOMRect the placement reads. */
export interface Box {
  left: number;
  top: number;
  bottom: number;
}

/** CSS for a `position: fixed` element: `top` when it hangs below the anchor, `bottom` above. */
export interface Placement {
  left: number;
  top?: number;
  bottom?: number;
}

/**
 * Below the anchor when the anchor is in the upper half of the window, above
 * it otherwise, so the card never leaves the window whatever its height; and
 * moved left when it would cross the right edge.
 */
export function placeCard(anchor: Box, viewport: Size): Placement {
  const farthest = Math.max(MARGIN, viewport.width - THREAD_CARD_W - MARGIN);
  const left = Math.min(Math.max(anchor.left, MARGIN), farthest);
  const inUpperHalf = (anchor.top + anchor.bottom) / 2 < viewport.height / 2;
  return inUpperHalf
    ? { left, top: anchor.bottom + GAP }
    : { left, bottom: viewport.height - anchor.top + GAP };
}
