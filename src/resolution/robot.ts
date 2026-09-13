/** Static Robot lookup. Unknown values and ambiguous names never become guessed edges. */
import * as path from 'path';
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { normalizeRobotName as normalize, ROBOT_KEYWORD, robotData, unescapeRobot } from '../extraction/languages/robot';
import { extractRobotData } from '../extraction/robot-data';
import { inspectPython, type PythonLibrary } from './robot-python';

interface Binding { node?: Node; value: unknown }
interface Library { namespace: string; keywords: { name: string; node: Node }[] }
interface Scope { files: string[]; variables: Map<string, Binding>; imports: Map<string, string>; libraries: Library[]; builtins: Set<string> }
const variableName = (s: string) => normalize(s.replace(/^[$@&%]\{|\}$/g, ''));
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match embedded arguments without discarding whitespace or underscores in their values. */
function embeddedPattern(name: string): RegExp | undefined {
  const parts: string[] = [];
  let start = 0, embedded = false;
  for (let i = 0; i < name.length - 1; i++) {
    if (name.slice(i, i + 2) !== '${') continue;
    let end = i + 2, depth = 1;
    for (; end < name.length && depth; end++) {
      if (name[end] === '\\') { end++; continue; }
      if (name[end] === '{') depth++;
      if (name[end] === '}') depth--;
    }
    if (depth) return undefined;
    parts.push(escapeRegex(name.slice(start, i)));
    const argument = name.slice(i + 2, end - 1), colon = argument.indexOf(':');
    let pattern = colon < 0 ? '.*?' : argument.slice(colon + 1);
    // Python-specific regexp extensions cannot safely be interpreted as JavaScript.
    if (/\(\?[aiLmsux-]|\(\?P|\\[AZ]/.test(pattern)) return undefined;
    pattern = pattern.replace(/\((?!\?)/g, '(?:');
    parts.push(`(?:${pattern})`);
    embedded = true; start = end; i = end - 1;
  }
  if (!embedded) return undefined;
  parts.push(escapeRegex(name.slice(start)));
  try { return new RegExp(`^${parts.join('')}$`, 'iu'); } catch { return undefined; }
}

function select(name: string, candidates: { name: string; node: Node }[]): Node[] {
  const exact = candidates.filter(k => !k.name.includes('${') && normalize(unescapeRobot(k.name)) === normalize(name));
  if (exact.length) return [...new Map(exact.map(k => [k.node.id, k.node])).values()];
  const matches = candidates.filter(k => embeddedPattern(k.name)?.test(name));
  const best = matches.filter(a => !matches.some(b => a !== b &&
    embeddedPattern(a.name)?.test(b.name) && !embeddedPattern(b.name)?.test(a.name)));
  return [...new Map((best.length ? best : matches).map(k => [k.node.id, k.node])).values()];
}

export class RobotResolver {
  private scopes = new Map<string, Scope>();
  private python = new Map<string, PythonLibrary>();
  constructor(private context: ResolutionContext) {}
  clear(): void { this.scopes.clear(); this.python.clear(); }

  private pythonLibrary(file: string, cls?: string): PythonLibrary {
    const key = `${file}:${cls ?? ''}`;
    let result = this.python.get(key);
    if (!result) { result = inspectPython(file, cls, this.context, new Set(), this.python); this.python.set(key, result); }
    return result;
  }

  private libdoc(name: string): string | undefined {
    const files = this.context.getAllFiles().filter(file =>
      ['.libspec', '.libdoc.json', '.json', '.xml'].some(ext => path.basename(file) === name + ext) &&
      this.context.getNodesInFile(file).some(n => n.decorators?.includes('robot:libdoc')));
    return files.length === 1 ? files[0] : undefined;
  }

  /** Resolve only local project sources: relative paths, root modules and explicit packages. */
  private locate(name: string, from: string, python = false): { file: string; cls?: string } | undefined {
    const root = this.context.getProjectRoot();
    const candidates: { file: string; cls?: string }[] = [];
    const add = (p: string, cls?: string) => {
      const file = path.relative(root, path.isAbsolute(p) ? p : path.resolve(root, p)).replace(/\\/g, '/');
      if (this.context.getNodesInFile(file).length) candidates.push({ file, cls });
    };
    if (python && !/[\\/]/.test(name) && !/\.py$/i.test(name)) {
      const pieces = name.split('.');
      for (const base of [path.dirname(from), '', ...(this.context.fileExists('pyproject.toml') || this.context.fileExists('setup.py') ? ['src'] : [])]) {
        const module = pieces.join('/');
        add(path.join(base, module + '.py')); add(path.join(base, module, '__init__.py'));
        if (pieces.length > 1) {
          add(path.join(base, pieces.slice(0, -1).join('/') + '.py'), pieces[pieces.length - 1]);
          add(path.join(base, pieces.slice(0, -1).join('/'), '__init__.py'), pieces[pieces.length - 1]);
        }
      }
    } else {
      add(path.isAbsolute(name) ? name : path.join(path.dirname(from), name));
      if (!path.isAbsolute(name)) add(name);
    }
    if (!candidates.length && python) {
      const spec = this.libdoc(name);
      if (spec) return { file: spec };
    }
    return candidates[0];
  }

  private expand(value: unknown, bindings: Map<string, Binding>, file: string, active = new Set<string>()): unknown {
    if (typeof value !== 'string') return value;
    const tokens = /(?<!\\)[$@&%]\{([^{}]+)\}(?:\[([^\]]+)\])?/g;
    let unknown = false;
    const replace = (full: string, key: string, item?: string): unknown => {
      if (full.startsWith('%')) return undefined; // environment is runtime input
      const normalized = normalize(key);
      if (active.has(normalized)) return undefined;
      let v: unknown;
      if (normalized === 'curdir') v = path.resolve(this.context.getProjectRoot(), path.dirname(file));
      else if (normalized === '/') v = path.sep;
      else if (normalized === 'empty') v = '';
      else if (normalized === 'space') v = ' ';
      else if (normalized === 'true') v = true;
      else if (normalized === 'false') v = false;
      else if (normalized === 'none' || normalized === 'null') v = null;
      else if (/^[+-]?\d+(?:\.\d+)?$/.test(key)) v = Number(key);
      else {
        const next = new Set(active); next.add(normalized);
        const binding = bindings.get(normalized);
        v = this.expand(binding?.value, bindings, binding?.node?.filePath ?? file, next);
        // Static dictionary attribute access, never arbitrary Python attributes.
        if (v === undefined && key.includes('.')) {
          const [base, ...parts] = key.split('.');
          v = this.expand(bindings.get(normalize(base!))?.value, bindings, file, next);
          for (const part of parts) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
        }
      }
      if (Array.isArray(v)) v = v.map(x => this.expand(x, bindings, file, new Set([...active, normalized])));
      if (item !== undefined) {
        const index = this.expand(item, bindings, file, active);
        if (Array.isArray(v)) v = v.at(Number(index));
        else if (v && typeof v === 'object') v = (v as Record<string, unknown>)[String(index)];
        else v = undefined;
      }
      return v;
    };
    // Nested variable names are expanded inside-out, only while progress occurs.
    if (/[$@&%]\{[^{}]*[$@&%]\{/.test(value)) {
      const inner = value.replace(tokens, (full, key, item) => {
        const v = replace(full, key, item); if (v === undefined) { unknown = true; return full; } return String(v);
      });
      return unknown || inner === value ? undefined : this.expand(inner, bindings, file, active);
    }
    const match = [...value.matchAll(tokens)];
    if (match.length === 1 && match[0]![0] === value) return replace(value, match[0]![1]!, match[0]![2]);
    const expanded = value.replace(tokens, (full, key, item) => {
      const v = replace(full, key, item);
      if (v === undefined || typeof v === 'object') { unknown = true; return full; }
      return String(v);
    });
    return unknown ? undefined : unescapeRobot(expanded);
  }

  private variableValue(node: Node): unknown {
    const data = robotData(node), values = data.value;
    if (!Array.isArray(values) || node.decorators?.includes('robot:data-variable')) return values;
    if (node.name.startsWith('@')) return values;
    if (node.name.startsWith('&')) {
      const entries: [string, unknown][] = [];
      for (const value of values) {
        if (typeof value !== 'string' || !value.includes('=')) return undefined;
        const equal = value.indexOf('='); entries.push([value.slice(0, equal), value.slice(equal + 1)]);
      }
      return Object.fromEntries(entries);
    }
    const separator = typeof values[0] === 'string' && values[0].startsWith('SEPARATOR=') ? values.shift()!.slice(10) : ' ';
    return values.join(separator);
  }

  private scope(file: string): Scope {
    const cached = this.scopes.get(file); if (cached) return cached;
    const scope: Scope = { files: [], variables: new Map(), imports: new Map(), libraries: [], builtins: new Set(['BuiltIn']) };
    this.scopes.set(file, scope);
    const seen = new Set<string>();
    const imports: Node[] = [];
    const addFile = (next: string, at: number) => {
      if (seen.has(next)) return;
      seen.add(next); scope.files.push(next);
      const nodes = this.context.getNodesInFile(next);
      const fileId = nodes.find(n => n.kind === 'file')?.id;
      for (const n of nodes.filter(n => n.kind === 'variable' && robotData(n).owner === fileId)) {
        const name = variableName(n.name);
        if (!scope.variables.has(name)) scope.variables.set(name, { node: n, value: this.variableValue(n) });
      }
      imports.splice(at, 0, ...nodes.filter(n => n.kind === 'import' && n.language === 'robot'));
    };
    addFile(file, 0);
    // Expand imports in source order, descending into each resource before later imports.
    let progress = true;
    while (progress) {
      progress = false;
      for (let index = 0; index < imports.length; index++) {
        const imp = imports[index]!;
        if (scope.imports.has(imp.id)) continue;
        const expanded = this.expand(imp.name, scope.variables, imp.filePath);
        if (typeof expanded !== 'string') continue;
        const resource = imp.decorators?.includes('robot:resource');
        const library = imp.decorators?.includes('robot:library');
        if (library && expanded === 'BuiltIn') {
          const args = robotData(imp).args ?? [];
          const alias = args.findIndex(a => ['WITH NAME', 'AS'].includes(a.toUpperCase()));
          const namespace = alias < 0 ? 'BuiltIn' : this.expand(args[alias + 1], scope.variables, imp.filePath);
          if (typeof namespace === 'string') scope.builtins.add(namespace);
          continue;
        }
        const located = this.locate(expanded, imp.filePath, !resource && !/\.(?:json|ya?ml|libspec|xml)$/i.test(expanded));
        if (!located) continue;
        if (resource && (!/\.(robot|resource)$/i.test(located.file) || /^__init__\./i.test(path.basename(located.file)))) continue;
        scope.imports.set(imp.id, located.file); progress = true;
        if (resource) { addFile(located.file, index + 1); continue; }
        if (library) {
          let cls = located.cls;
          if (!cls && /\.py$/i.test(located.file)) {
            const name = path.basename(located.file, '.py');
            if (this.context.getNodesInFile(located.file).some(n => n.kind === 'class' && n.name === name)) cls = name;
          }
          const args = robotData(imp).args ?? [];
          const alias = args.findIndex(a => ['WITH NAME', 'AS'].includes(a.toUpperCase()));
          const namespace = alias < 0 ? (/\.(?:py|json|xml|libspec)$/i.test(expanded) ? path.basename(expanded, path.extname(expanded)) : expanded) : this.expand(args[alias + 1], scope.variables, imp.filePath);
          if (typeof namespace !== 'string') continue;
          const python = /\.py$/i.test(located.file) ? this.pythonLibrary(located.file, cls) : undefined;
          const spec = python?.dynamic ? this.libdoc(expanded.replace(/\.py$/i, '').split('/').pop()!) : undefined;
          const keywords = python && !spec ? python.keywords
            : this.context.getNodesInFile(spec ?? located.file).filter(n => n.decorators?.includes('robot:libdoc')).map(node => ({ name: node.name, node }));
          if (!scope.libraries.some(l => l.namespace === namespace)) scope.libraries.push({ namespace, keywords });
        } else {
          // A variable file with arguments requires executing get_variables().
          if (robotData(imp).args?.length) continue;
          const fileNode = this.context.getNodesInFile(located.file).find(n => n.kind === 'file');
          const bindings = /\.py$/i.test(located.file) ? this.pythonLibrary(located.file, located.cls).variables
            : new Map(extractRobotData(located.file, this.context.readFile(located.file) ?? '', fileNode?.language ?? 'yaml', true).nodes
              .filter(n => n.decorators?.includes('robot:data-variable'))
              .map(n => [n.name, { node: fileNode, value: robotData(n).value }]));
          for (const [key, binding] of bindings) if (!scope.variables.has(normalize(key))) scope.variables.set(normalize(key), binding);
        }
      }
    }
    return scope;
  }

  private bindings(ref: UnresolvedRef, scope: Scope): Map<string, Binding> {
    const bindings = new Map(scope.variables);
    const local = this.context.getNodesInFile(ref.filePath).filter(n => robotData(n).owner === ref.fromNodeId);
    for (const n of local) {
      const data = robotData(n);
      if (!data.binding || data.binding !== 'argument' && n.startLine >= ref.line) continue;
      bindings.set(variableName(n.name), { node: n, value: data.binding === 'variable' && !data.conditional ? this.variableValue(n) : undefined });
    }
    return bindings;
  }

  private lookup(name: string, scope: Scope): Node[] {
    const keywords = (file: string) => this.context.getNodesInFile(file)
      .filter(n => n.decorators?.includes(ROBOT_KEYWORD)).map(node => ({ name: node.name, node }));
    const local = select(name, keywords(scope.files[0]!));
    if (local.length) return local;
    const explicit: { name: string; node: Node }[] = [];
    const namespaces: Library[] = [...scope.files.slice(1).map(file => ({ namespace: path.basename(file, path.extname(file)), keywords: keywords(file) })), ...scope.libraries];
    for (const library of namespaces) {
      for (let i = name.indexOf('.'); i >= 0; i = name.indexOf('.', i + 1)) {
        if (normalize(library.namespace) === normalize(name.slice(0, i))) {
          explicit.push(...select(name.slice(i + 1), library.keywords).map(node => ({ name: name, node })));
        }
      }
    }
    if (explicit.length) return select(name, explicit);
    const resourceKeywords = scope.files.slice(1).flatMap(keywords);
    let resource = select(name, resourceKeywords);
    if (resource.length > 1) { const visible = resource.filter(n => n.visibility !== 'private'); if (visible.length) resource = visible; }
    if (resource.length) return resource;
    return select(name, scope.libraries.flatMap(l => l.keywords));
  }

  private callTargets(name: string, args: string[], ref: UnresolvedRef, scope: Scope, bindings: Map<string, Binding>, depth = 0): Node[] {
    if (depth > 30) return [];
    const expanded = this.expand(name, bindings, ref.filePath);
    if (typeof expanded !== 'string') return [];
    const prefixes = robotData(this.context.getNodesInFile(ref.filePath).find(n => n.kind === 'file')).prefixes ?? ['Given', 'When', 'Then', 'And', 'But'];
    const stripped = expanded.replace(new RegExp(`^(?:${prefixes.map(escapeRegex).join('|')})\\s+`, 'iu'), '');
    let matches = stripped === expanded ? [] : this.lookup(stripped, scope);
    if (!matches.length) matches = this.lookup(expanded, scope);
    if (matches.length) return matches.length === 1 ? matches : [];
    const builtin = normalize(expanded.replace(new RegExp(`^(?:${[...scope.builtins].map(escapeRegex).join('|')})\\.`, 'iu'), ''));
    // These argument positions belong to BuiltIn only; a user/library match above wins.
    const nested: string[][] = [];
    if (builtin === 'runkeywords') {
      if (args.includes('AND')) {
        let start = 0;
        for (let i = 0; i <= args.length; i++) if (i === args.length || args[i] === 'AND') { nested.push(args.slice(start, i)); start = i + 1; }
      } else nested.push(...args.map(a => [a]));
    } else if (builtin === 'runkeywordif') {
      let start = 1;
      for (let i = 2; i <= args.length; i++) {
        if (i === args.length || args[i] === 'ELSE' || args[i] === 'ELSE IF') {
          nested.push(args.slice(start, i)); start = i + (args[i] === 'ELSE IF' ? 2 : 1);
        }
      }
    } else {
      const offsets: Record<string, number> = {
        runkeyword: 0, runkeywordandcontinueonfailure: 0, runkeywordandignoreerror: 0,
        runkeywordandreturnstatus: 0, runkeywordandreturn: 0, runkeywordandwarnonfailure: 0,
        runkeywordunless: 1, runkeywordandreturnif: 1, runkeywordandexpecterror: 1,
        waituntilkeywordsucceeds: 2, repeatkeyword: 1,
        runkeywordiftestfailed: 0, runkeywordiftestpassed: 0, runkeywordiftimeoutoccurred: 0,
        runkeywordifalltestspassed: 0, runkeywordifanytestsfailed: 0,
      };
      const offset = offsets[builtin]; if (offset !== undefined) nested.push(args.slice(offset));
    }
    return nested.flatMap(cells => cells[0] ? this.callTargets(cells[0], cells.slice(1), ref, scope, bindings, depth + 1) : []);
  }

  resolve(ref: UnresolvedRef): ResolvedRef | null {
    const scope = this.scope(ref.filePath), bindings = this.bindings(ref, scope);
    let targets: Node[] = [];
    if (ref.referenceKind === 'imports') {
      const imp = this.context.getNodesInFile(ref.filePath).find(n => n.kind === 'import' && n.startLine === ref.line && n.name === ref.referenceName);
      const file = imp ? scope.imports.get(imp.id) : undefined;
      const target = file ? this.context.getNodesInFile(file).find(n => n.kind === 'file') : undefined;
      if (target) targets = [target];
    } else if (ref.referenceKind === 'references') {
      const target = bindings.get(variableName(ref.referenceName))?.node;
      if (target) targets = [target];
    } else if (ref.referenceKind === 'calls') {
      const args = ref.candidates?.[0];
      targets = this.callTargets(ref.referenceName, args ? JSON.parse(args) as string[] : [], ref, scope, bindings);
      if (!targets.length && ref.candidates?.[1] === 'robot:template') {
        const matches = this.lookup(ref.referenceName, scope);
        if (matches.length === 1 && matches[0]!.name.includes('${')) targets = matches;
      }
    }
    targets = [...new Map(targets.map(n => [n.id, n])).values()];
    if (!targets.length) return null;
    return { original: ref, targetNodeId: targets[0]!.id, confidence: 1,
      resolvedBy: ref.referenceKind === 'imports' ? 'file-path' : 'import',
      alsoTargets: targets.slice(1).map(n => ({ targetNodeId: n.id })) };
  }
}

/** Kept as a convenience for callers providing their own resolution context. */
export function resolveRobotReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  return new RobotResolver(context).resolve(ref);
}
