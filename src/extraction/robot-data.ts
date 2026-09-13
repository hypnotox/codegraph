/** Static variable documents and pre-generated Libdoc files; never invokes Libdoc. */
import * as path from 'path';
import { parseTree, getNodeValue, type ParseError } from 'jsonc-parser';
import type { ExtractionResult, Language, Node } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { robotDecorators } from './languages/robot';

export function extractRobotData(filePath: string, source: string, language: Language, variables = false): ExtractionResult {
  const result: ExtractionResult = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  const lines = source.split('\n');
  const file: Node = { id: generateNodeId(filePath, 'file', filePath, 1), kind: 'file', name: path.basename(filePath),
    qualifiedName: filePath, filePath, language, startLine: 1, endLine: lines.length, startColumn: 0,
    endColumn: lines[lines.length - 1]!.length, updatedAt: Date.now() };
  result.nodes.push(file);
  function add(name: string, line: number, value: unknown, keyword = false, docstring?: string): void {
    const kind = keyword ? 'function' : 'variable';
    const n: Node = { ...file, id: generateNodeId(filePath, kind, name, line), name, kind,
      qualifiedName: `${filePath}::${name}`, startLine: line, endLine: line, docstring,
      decorators: robotDecorators({ value }, keyword ? 'robot:libdoc' : 'robot:data-variable') };
    result.nodes.push(n); result.edges.push({ source: file.id, target: n.id, kind: 'contains' });
  }
  // Ordinary configuration files remain file-level data. Parse variable contents
  // only when a Robot Variables import requests them; Libdoc identifies itself.
  if (!variables && !/<keywordspec\b/.test(source) &&
      !(/\.json$/i.test(filePath) && /"keywords"\s*:/.test(source) && /"(?:specversion|specVersion|type)"\s*:/.test(source))) return result;
  try {
    if (/\.(?:libspec|xml)$/i.test(filePath)) {
      // Libdoc XML is a fixed data format. Ignore comments, never expand DTD entities.
      const xml = source.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
      if (!/<keywordspec\b/.test(xml)) return result;
      const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, e: string) => {
        if (e[0] === '#') { const n = parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10); return n <= 0x10ffff ? String.fromCodePoint(n) : all; }
        return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e] ?? all;
      });
      for (const match of xml.matchAll(/<kw\b([^>]*)>([\s\S]*?)<\/kw>/g)) {
        const name = match[1]!.match(/\bname\s*=\s*(["'])(.*?)\1/);
        if (!name) continue;
        const doc = match[2]!.match(/<doc(?:\s[^>]*)?>([\s\S]*?)<\/doc>/)?.[1];
        add(decode(name[2]!), xml.slice(0, match.index).split('\n').length, undefined, true,
          doc ? decode(doc.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : undefined);
      }
      return result;
    }
    let value: Record<string, unknown>;
    const locations = new Map<string, number>();
    if (/\.json$/i.test(filePath)) {
      const errors: ParseError[] = [];
      const tree = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
      if (errors.length) throw new Error('Invalid JSON variable or Libdoc document');
      if (tree?.type !== 'object') return result;
      value = getNodeValue(tree) as Record<string, unknown>;
      for (const item of tree.children ?? []) {
        locations.set(String(item.children?.[0]?.value), source.slice(0, item.offset).split('\n').length);
      }
    } else {
      const entries = staticYaml(source);
      value = Object.fromEntries(entries.map(e => [e.key, e.value]));
      for (const entry of entries) locations.set(entry.key, entry.line);
    }
    if (Array.isArray(value.keywords) && typeof value.name === 'string' && ('specversion' in value || 'specVersion' in value || value.type === 'LIBRARY')) {
      for (const kw of value.keywords as { name?: unknown; doc?: string }[]) {
        if (typeof kw.name === 'string') {
          const line = lines.findIndex(l => l.includes(JSON.stringify(kw.name))) + 1;
          add(kw.name, Math.max(1, line), undefined, true, kw.doc);
        }
      }
    } else {
      for (const [key, item] of Object.entries(value)) add(key, locations.get(key) ?? 1, item);
    }
  } catch (error) {
    result.errors.push({ filePath, severity: 'warning', code: 'parse_error',
      message: `Static data extraction: ${error instanceof Error ? error.message : String(error)}` });
  }
  return result;
}

/** A literal-only YAML reader. Unsupported syntax stays unresolved as a whole document. */
function staticYaml(source: string): { key: string; value: unknown; line: number }[] {
  const rows = source.split(/\r?\n/).map((text, i) => ({ text, line: i + 1 }))
    .filter(r => r.text.trim() && !/^\s*(?:#|---$|\.\.\.$)/.test(r.text));
  const scalar = (text: string): unknown => {
    text = text.trim();
    if (/^[&*!>|%]/.test(text) || text.includes('<<:')) throw new Error('Unsupported YAML construct; use JSON for complete static variable data');
    if (text.startsWith('"') || /^[\[{]/.test(text)) {
      try { return JSON.parse(text); } catch { throw new Error('Unsupported YAML flow value'); }
    }
    if (text.startsWith("'")) {
      if (!text.endsWith("'")) throw new Error('Unterminated YAML string');
      return text.slice(1, -1).replace(/''/g, "'");
    }
    text = text.replace(/\s+#.*$/, '');
    if (/^(?:null|~)$/i.test(text)) return null;
    if (/^(?:true|false|yes|no|on|off)$/i.test(text)) return /^(?:true|yes|on)$/i.test(text);
    if (/^[+-]?0[0-7]+$/.test(text)) return parseInt(text, 8);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) throw new Error('YAML timestamps require a YAML parser');
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
    return text;
  };
  const indent = (text: string) => text.length - text.trimStart().length;
  let index = 0;
  function block(level: number): unknown {
    const list = rows[index]?.text.trimStart().startsWith('- ');
    const items: unknown[] = [], map: [string, unknown][] = [];
    while (index < rows.length && indent(rows[index]!.text) === level) {
      const row = rows[index++]!, text = row.text.trim();
      if (list) {
        if (!text.startsWith('- ')) throw new Error('Mixed YAML sequence and mapping');
        items.push(scalar(text.slice(2)));
      } else {
        const match = text.match(/^([^:]+):(?:\s+(.*))?$/);
        if (!match) throw new Error('Unsupported YAML mapping');
        const key = scalar(match[1]!);
        if (typeof key !== 'string' || key === '<<') throw new Error('Unsupported YAML key');
        const value = match[2] !== undefined ? scalar(match[2]) : index < rows.length && indent(rows[index]!.text) > level ? block(indent(rows[index]!.text)) : null;
        map.push([key, value]);
      }
    }
    return list ? items : Object.fromEntries(map);
  }
  const value = rows.length ? block(0) : {};
  if (index !== rows.length) throw new Error('Unsupported YAML indentation or multiline value');
  if (!value || Array.isArray(value) || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, value]) => ({ key, value, line: rows.find(r => indent(r.text) === 0 && r.text.startsWith(key + ':'))?.line ?? 1 }));
}
