import { describe, expect, it } from 'vitest';
import { jsonLines } from './jsonLines';

const text = (lines: ReturnType<typeof jsonLines>) =>
  lines.map((line) => {
    const key = line.key ? `"${line.key}": ` : '';
    return `${'  '.repeat(line.depth)}${key}${line.text}${line.comma ? ',' : ''}`;
  });

describe('jsonLines', () => {
  it('prints the entries as one JSON object', () => {
    const lines = jsonLines([
      ['thread_id', 'abc'],
      ['score', 82],
    ]);

    expect(text(lines)).toEqual(['{', '  "thread_id": "abc",', '  "score": 82', '}']);
    expect(JSON.parse(text(lines).join(''))).toEqual({ thread_id: 'abc', score: 82 });
  });

  it('gives a nested object a line per key', () => {
    const lines = jsonLines([
      ['application', { action: 'tailor', files: 2 }],
      ['fit', 'Good'],
    ]);

    expect(text(lines)).toEqual([
      '{',
      '  "application": {',
      '    "action": "tailor",',
      '    "files": 2',
      '  },',
      '  "fit": "Good"',
      '}',
    ]);
  });

  it('cuts a long string and keeps the whole value for the tooltip', () => {
    const long = 'x'.repeat(80);
    const [, line] = jsonLines([['company_brief', long]]);

    expect(line?.text.length).toBeLessThan(50);
    expect(line?.text.endsWith('…"')).toBe(true);
    expect(line?.full).toBe(long);
  });

  it('changes the id of a line when its value changes, so the card can flash it', () => {
    const id = (value: string) => jsonLines([['location', value]])[1]?.id;

    expect(id('Berlin')).toBe(id('Berlin'));
    expect(id('Berlin')).not.toBe(id('Germany'));
  });

  it('keeps the id of the rank, which changes too often to flash', () => {
    const id = (value: string) => jsonLines([['rank', value]])[1]?.id;

    expect(id('#2 of 7')).toBe(id('#3 of 8'));
  });

  it('gives every line of one object its own id', () => {
    const lines = jsonLines([
      ['title', 'A'],
      ['application', { action: 'tailor', state: 'done' }],
      ['error', 'A'],
    ]);

    expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
  });
});
