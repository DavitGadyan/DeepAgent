/** A thread printed as indented JSON, one line per key, for the JSON card. */
import type { FactValue } from './threads';

/** Longer strings are cut so one key stays on about one line of the card. */
const MAX_TEXT = 44;

export interface JsonLine {
  /**
   * Stable while the line says the same thing; the card flashes a line whose
   * id is new. The rank changes with every other thread that is scored, so its
   * id leaves the value out.
   */
  id: string;
  /** Nesting depth: 0 for the outer braces. */
  depth: number;
  /** '' for a brace line. */
  key: string;
  /** The value as a JSON literal, or a brace. */
  text: string;
  /** The uncut value when `text` was shortened; '' otherwise. */
  full: string;
  kind: 'brace' | 'string' | 'number';
  comma: boolean;
}

const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

function scalarLine(
  key: string,
  value: string | number,
  depth: number,
  path: string,
  comma: boolean,
): JsonLine {
  const isText = typeof value === 'string';
  const text = isText ? JSON.stringify(cut(value)) : String(value);
  const steady = path === 'rank';
  return {
    id: steady ? path : `${path}=${text}`,
    depth,
    key,
    text,
    full: isText && value.length > MAX_TEXT ? value : '',
    kind: isText ? 'string' : 'number',
    comma,
  };
}

const brace = (id: string, depth: number, key: string, text: string, comma = false): JsonLine => ({
  id,
  depth,
  key,
  text,
  full: '',
  kind: 'brace',
  comma,
});

/** `entries` as the lines of one JSON object; a nested object takes a line per key. */
export function jsonLines(entries: readonly [string, FactValue][]): JsonLine[] {
  const lines = entries.flatMap(([key, value], index): JsonLine[] => {
    const comma = index < entries.length - 1;
    if (typeof value !== 'object') return [scalarLine(key, value, 1, key, comma)];
    const inner = Object.entries(value);
    return [
      brace(`${key}{`, 1, key, '{'),
      ...inner.map(([innerKey, innerValue], at) =>
        scalarLine(innerKey, innerValue, 2, `${key}.${innerKey}`, at < inner.length - 1),
      ),
      brace(`${key}}`, 1, '', '}', comma),
    ];
  });
  return [brace('{', 0, '', '{'), ...lines, brace('}', 0, '', '}')];
}
