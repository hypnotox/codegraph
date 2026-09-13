/** Persisted Robot semantics shared by extraction and static resolution. */
import type { Node } from '../../types';

export const ROBOT_KEYWORD = 'robot:keyword';
export const ROBOT_TEST = 'robot:test';
export const ROBOT_RESOURCE = 'robot:resource';
const DATA = 'robot:data:';

export type RobotDefaults = Record<string, string[]>;

export interface RobotData {
  args?: string[];
  defaults?: RobotDefaults;
  prefixes?: string[];
  value?: unknown;
  owner?: string;
  binding?: 'argument' | 'assignment' | 'variable';
  conditional?: boolean;
}

export function robotData(node: Node | undefined): RobotData {
  const data = node?.decorators?.find(d => d.startsWith(DATA));
  return data ? JSON.parse(data.slice(DATA.length)) as RobotData : {};
}

export function robotDecorators(data: RobotData, ...tags: string[]): string[] {
  return [...tags, DATA + JSON.stringify(data)];
}

export function normalizeRobotName(name: string): string {
  return name.toLowerCase().replace(/[\s_\u001c-\u001f\u0085]/gu, '');
}

export interface RobotCell { text: string; line: number; column: number }
export interface RobotRow { cells: RobotCell[]; line: number; endLine: number; indented: boolean }

/** Robot's data syntax: tab/two-space separated or pipe separated cells. */
export function robotRows(source: string): RobotRow[] {
  const rows: RobotRow[] = [];
  for (const [index, raw] of source.split(/\r\n|\n|\r/).entries()) {
    const line = index + 1;
    const pipe = /^\s*\|(?:\s|$)/u.test(raw);
    const cells: RobotCell[] = [];
    let start = 0;
    if (pipe) {
      const bars = [...raw.matchAll(/\|(?=\s|$)/gu)].filter(m => m.index === 0 || /\s/u.test(raw[m.index! - 1]!));
      start = bars.shift()!.index! + 1;
      for (const bar of bars) {
        const text = raw.slice(start, bar.index);
        cells.push({ text: text.trim(), line, column: start + text.length - text.trimStart().length });
        start = bar.index! + 1;
      }
      if (raw.slice(start).trim()) {
        const text = raw.slice(start); cells.push({ text: text.trim(), line, column: start + text.length - text.trimStart().length });
      }
    } else {
      const delimiter = /(?:(?:[^\S\r\n]|\u0085|[\u001c-\u001f])*\t(?:[^\S\r\n]|\u0085|[\u001c-\u001f])*|(?:[^\S\r\n\t]|\u0085|[\u001c-\u001f]){2,})/gu;
      for (const match of raw.matchAll(delimiter)) {
        cells.push({ text: raw.slice(start, match.index).trim(), line, column: start });
        start = match.index! + match[0].length;
      }
      cells.push({ text: raw.slice(start).trimEnd(), line, column: start });
    }
    const indented = cells[0]?.text === '';
    while (cells[0]?.text === '') cells.shift();
    const comment = cells.findIndex(c => c.text.startsWith('#'));
    if (comment >= 0) cells.splice(comment);
    if (!cells.length) continue;
    if (cells[0]!.text === '...') {
      const previous = rows[rows.length - 1];
      if (previous) { previous.cells.push(...cells.slice(1)); previous.endLine = line; }
    } else rows.push({ cells, line, endLine: line, indented });
  }
  return rows;
}

/** Unescape Robot literals, preserving escaped variable openers for substitution. */
export function unescapeRobot(value: string): string {
  return value.replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/gu, (_, c: string) => {
    if (/^[xuU]/.test(c) && c.length > 1) {
      const code = parseInt(c.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c;
  });
}
