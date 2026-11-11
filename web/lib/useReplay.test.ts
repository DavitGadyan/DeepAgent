import { describe, expect, it } from 'vitest';
import { stepCursor } from './useReplay';

describe('stepCursor', () => {
  it('moves one event forward', () => {
    expect(stepCursor(3, 10)).toBe(4);
  });

  it('returns to live on reaching the end of the log', () => {
    expect(stepCursor(9, 10)).toBeNull();
    expect(stepCursor(12, 10)).toBeNull();
  });

  it('keeps going when the log grew since the last step', () => {
    expect(stepCursor(9, 25)).toBe(10);
  });

  it('stays live when already live', () => {
    expect(stepCursor(null, 10)).toBeNull();
  });
});
