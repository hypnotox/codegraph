/** Static Python library inspection using codegraph's existing tree-sitter grammar. */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import * as path from 'path';
import type { Node } from '../types';
import { getParser } from '../extraction/grammars';
import type { ResolutionContext } from './types';

export interface PythonKeyword { name: string; node: Node }
export interface PythonLibrary { automatic?: boolean; dynamic?: boolean; keywords: PythonKeyword[]; variables: Map<string, { value: unknown; node?: Node }> }

/** Deliberately excludes calls, comprehensions, interpolation and attribute execution. */
function literal(n: SyntaxNode | null, values: Map<string, unknown>): unknown {
  if (!n) return undefined;
  if (n.type === 'identifier') return values.get(n.text);
  if (n.type === 'true') return true;
  if (n.type === 'false') return false;
  if (n.type === 'none') return null;
  if (['integer', 'float'].includes(n.type)) { const v = Number(n.text.replace(/_/g, '')); return Number.isFinite(v) ? v : undefined; }
  if (n.type === 'unary_operator' && /^[+-]/.test(n.text)) {
    const v = literal(n.namedChildren[0] ?? null, values); return typeof v === 'number' ? (n.text[0] === '-' ? -v : v) : undefined;
  }
  if (n.type === 'string') {
    if (n.namedChildren.some(c => c.type === 'interpolation') || /^[bf]/i.test(n.text)) return undefined;
    const match = n.text.match(/^(r?)("""|'''|"|')([\s\S]*)\2$/i);
    if (!match) return undefined;
    if (match[1]) return match[3];
    return match[3]!.replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|[\\'"nrt])/g, (_, c: string) =>
      c.length > 1 ? String.fromCodePoint(parseInt(c.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c);
  }
  if (['list', 'tuple'].includes(n.type)) {
    const items = n.namedChildren.map(c => literal(c, values));
    return items.some(v => v === undefined) ? undefined : items;
  }
  if (n.type === 'dictionary') {
    const entries: [string, unknown][] = [];
    for (const pair of n.namedChildren) {
      if (pair.type !== 'pair') return undefined;
      const key = literal(pair.childForFieldName('key'), values), value = literal(pair.childForFieldName('value'), values);
      if (typeof key !== 'string' || value === undefined) return undefined;
      entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

export function inspectPython(file: string, className: string | undefined, context: ResolutionContext, seen = new Set<string>(), cache = new Map<string, PythonLibrary>()): PythonLibrary {
  const result: PythonLibrary = { keywords: [], variables: new Map() };
  const identity = `${file}:${className ?? ''}`;
  const cached = cache.get(identity);
  if (cached) return cached;
  cache.set(identity, result);
  if (seen.has(identity)) return result;
  seen = new Set(seen); seen.add(identity);
  const source = context.readFile(file), parser = getParser('python');
  if (source === null || !parser) return result;
  const tree = parser.parse(source);
  if (!tree) return result;
  try {
    const root = tree.rootNode;
    const nodes = context.getNodesInFile(file);
    const values = new Map<string, unknown>();
    const aliases = new Map<string, string>([['robot.api.deco.keyword', 'keyword'], ['robot.api.deco.not_keyword', 'not_keyword'], ['robot.api.deco.library', 'library']]);
    for (const item of root.namedChildren) {
      if (item.type === 'import_statement') {
        for (const c of item.namedChildren) {
          const name = c.childForFieldName('name')?.text ?? c.text;
          if (name === 'robot.api.deco') for (const kind of ['keyword', 'not_keyword', 'library']) aliases.set(`${c.childForFieldName('alias')?.text ?? name}.${kind}`, kind);
        }
      }
      if (item.type === 'import_from_statement' && item.childForFieldName('module_name')?.text === 'robot.api.deco') {
        for (const c of item.namedChildren.slice(1)) {
          const name = c.childForFieldName('name')?.text ?? c.text;
          if (name === '*') for (const kind of ['keyword', 'not_keyword', 'library']) aliases.set(kind, kind);
          else aliases.set(c.childForFieldName('alias')?.text ?? name, name);
        }
      }
    }
    const unwrap = (n: SyntaxNode) => n.type === 'decorated_definition' ? n.childForFieldName('definition') ?? n : n;
    function assignments(body: SyntaxNode): void {
      for (const statement of body.namedChildren) {
        const n = statement.type === 'expression_statement' ? statement.namedChildren[0] : statement;
        if (n?.type !== 'assignment') continue;
        const left = n.childForFieldName('left');
        if (left?.type !== 'identifier') continue;
        const value = literal(n.childForFieldName('right'), values);
        values.set(left.text, value);
        result.variables.set(left.text, { value, node: nodes.find(v => v.name === left.text && v.startLine === n.startPosition.row + 1) });
      }
    }
    assignments(root);
    const classes = root.namedChildren.map(unwrap).filter(n => n.type === 'class_definition');
    const cls = className ? classes.find(n => n.childForFieldName('name')?.text === className) : undefined;
    const imports = context.getImportMappings(file, 'python');
    function imported(name: string): { file: string; name: string } | undefined {
      const imp = imports.find(i => i.localName === name && !i.isNamespace);
      if (!imp) return undefined;
      const dots = imp.source.match(/^\.+/)?.[0].length ?? 0;
      const module = imp.source.slice(dots).replace(/\./g, '/');
      const bases = dots ? [path.join(path.dirname(file), ...Array(Math.max(0, dots - 1)).fill('..'))] : [path.dirname(file), '', ...(context.fileExists('pyproject.toml') || context.fileExists('setup.py') ? ['src'] : [])];
      for (const base of bases) for (const candidate of [path.join(base, module + '.py'), path.join(base, module, '__init__.py')]) {
        if (context.getNodesInFile(candidate).length) return { file: candidate, name: imp.exportedName };
      }
      return undefined;
    }
    if (className && !cls) {
      const target = imported(className);
      const resolved = target ? inspectPython(target.file, target.name, context, seen, cache) : result;
      cache.set(identity, resolved); return resolved;
    }
    const visited = new Set<string>();
    const byName = new Map<string, PythonKeyword>();
    const automaticByClass = new Map<string, boolean>();
    let dynamic = false;
    function functions(body: SyntaxNode, automatic: boolean): void {
      for (const wrapper of body.namedChildren) {
        const n = unwrap(wrapper);
        if (n.type !== 'function_definition') continue;
        const methodName = n.childForFieldName('name')?.text;
        if (!methodName) continue;
        let exposedName: string | undefined, explicit = false, hidden = false;
        for (const decorator of wrapper.type === 'decorated_definition' ? wrapper.namedChildren.filter(c => c.type === 'decorator') : []) {
          const expression = decorator.namedChildren[0];
          const fn = expression?.type === 'call' ? expression.childForFieldName('function')?.text : expression?.text;
          const kind = aliases.get(fn ?? '') ?? (fn === 'property' ? 'property' : undefined);
          if (kind === 'not_keyword' || kind === 'property' || fn?.endsWith('.setter') || fn?.endsWith('.deleter')) hidden = true;
          if (kind === 'keyword') {
            explicit = true;
            const args = expression?.childForFieldName('arguments')?.namedChildren ?? [];
            const nameArg = args.find(a => a.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'name');
            const nameExpression = nameArg?.childForFieldName('value') ?? args.find(a => a.type !== 'keyword_argument') ?? null;
            const value = literal(nameExpression, values);
            if (typeof value === 'string') exposedName = value;
            else if (nameExpression && value !== null) hidden = true;
          }
        }
        const target = nodes.find(v => ['function', 'method'].includes(v.kind) && v.name === methodName && v.startLine === n.startPosition.row + 1);
        if (hidden || (!explicit && (!automatic || methodName.startsWith('_')))) { byName.delete(methodName); continue; }
        if (target) byName.set(methodName, { name: exposedName ?? methodName.replace(/_/g, ' '), node: target });
      }
    }
    function visitClass(n: SyntaxNode): void {
      const name = n.childForFieldName('name')!.text;
      if (visited.has(name)) return;
      visited.add(name);
      let inheritedAutomatic = true;
      for (const base of [...(n.childForFieldName('superclasses')?.namedChildren ?? [])].reverse()) {
        const local = classes.find(c => c.childForFieldName('name')?.text === base.text);
        if (local) { visitClass(local); inheritedAutomatic = automaticByClass.get(base.text) ?? true; }
        else {
          const target = imported(base.text);
          if (target) {
            const parent = inspectPython(target.file, target.name, context, seen, cache);
            inheritedAutomatic = parent.automatic ?? true; dynamic ||= parent.dynamic === true;
            for (const keyword of parent.keywords) byName.set(keyword.node.name, keyword);
          }
        }
      }
      const body = n.childForFieldName('body');
      if (!body) return;
      assignments(body);
      const ownAutomatic = body.namedChildren.some(s => s.namedChildren.some(n => n.type === 'assignment' && n.childForFieldName('left')?.text === 'ROBOT_AUTO_KEYWORDS'));
      let automatic = ownAutomatic ? values.get('ROBOT_AUTO_KEYWORDS') === true : inheritedAutomatic;
      const wrapper = n.parent;
      if (wrapper?.type === 'decorated_definition') {
        for (const d of wrapper.namedChildren.filter(c => c.type === 'decorator')) {
          const expr = d.namedChildren[0], fn = expr?.childForFieldName('function')?.text ?? expr?.text;
          if (aliases.get(fn ?? '') === 'library') {
            automatic = false;
            for (const arg of expr?.childForFieldName('arguments')?.namedChildren ?? []) {
              if (arg.childForFieldName('name')?.text === 'auto_keywords') automatic = literal(arg.childForFieldName('value'), values) === true;
            }
          }
        }
      }
      automaticByClass.set(name, automatic);
      functions(body, automatic);
      dynamic ||= body.namedChildren.map(unwrap).some(n => n.type === 'function_definition' && ['get_keyword_names', 'getKeywordNames'].includes(n.childForFieldName('name')?.text ?? ''));
    }
    if (cls) visitClass(cls);
    else {
      for (const imp of imports) {
        const target = imported(imp.localName);
        if (!target) continue;
        const keyword = inspectPython(target.file, undefined, context, seen, cache).keywords.find(k => k.node.name === target.name);
        if (keyword) byName.set(imp.localName, { ...keyword,
          name: keyword.name === keyword.node.name.replace(/_/g, ' ') ? imp.localName.replace(/_/g, ' ') : keyword.name });
      }
      functions(root, values.get('ROBOT_AUTO_KEYWORDS') !== false);
      const includes = values.get('__all__');
      if (values.has('__all__')) for (const name of byName.keys()) if (!Array.isArray(includes) || !includes.includes(name)) byName.delete(name);
    }
    // Dynamic/hybrid libraries determine the exposed set by executing Python.
    const body = cls?.childForFieldName('body') ?? root;
    result.automatic = cls ? automaticByClass.get(cls.childForFieldName('name')!.text) : values.get('ROBOT_AUTO_KEYWORDS') !== false;
    result.dynamic = dynamic || body.namedChildren.map(unwrap).some(n => n.type === 'function_definition' && ['get_keyword_names', 'getKeywordNames'].includes(n.childForFieldName('name')?.text ?? ''));
    if (result.dynamic) return result;
    if (body.namedChildren.map(unwrap).some(n => n.type === 'function_definition' && n.childForFieldName('name')?.text === 'get_variables')) result.variables.clear();
    result.keywords = [...byName.values()];
    return result;
  } finally { tree.delete(); }
}
