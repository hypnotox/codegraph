/** Native Robot data parser. No library imports or execution are needed to index a suite. */
import type { ExtractionResult, Node, NodeKind, ReferenceKind } from '../types';
import { robotLocale } from './robot-locale';
import { generateNodeId } from './tree-sitter-helpers';
import { ROBOT_KEYWORD, ROBOT_TEST, robotDecorators, robotRows,
  type RobotCell, type RobotRow, type RobotData, type RobotDefaults } from './languages/robot';

export function extractRobot(filePath: string, source: string, inherited: RobotDefaults = {}): ExtractionResult {
  const result: ExtractionResult = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  const lines = source.split(/\r\n|\n|\r/);
  const rows = robotRows(source);
  const locale = robotLocale(source);
  const fileId = generateNodeId(filePath, 'file', filePath, 1);
  let owner = fileId;
  function node(kind: NodeKind, name: string, row: RobotRow, extra: Partial<Node> = {}): Node {
    const n: Node = { id: generateNodeId(filePath, kind, name, row.line), kind, name,
      qualifiedName: `${filePath}::${owner === fileId ? '' : (result.nodes.find(n => n.id === owner)?.name ?? '') + '::'}${name}`, filePath, language: 'robot',
      startLine: row.line, endLine: row.endLine, startColumn: row.cells[0]?.column ?? 0,
      endColumn: lines[row.endLine - 1]?.length ?? 0, updatedAt: Date.now(), ...extra };
    result.nodes.push(n);
    if (kind !== 'file') result.edges.push({ source: owner, target: n.id, kind: 'contains' });
    return n;
  }
  node('file', filePath.split('/').pop()!, { cells: [], line: 1, endLine: lines.length, indented: false },
    { id: fileId, qualifiedName: filePath, decorators: robotDecorators({ defaults: inherited, prefixes: locale.prefixes }) });
  function ref(cell: RobotCell, kind: ReferenceKind, candidates?: string[]): void {
    if (!cell.text || cell.text.toUpperCase() === 'NONE') return;
    result.unresolvedReferences.push({ fromNodeId: owner, referenceName: cell.text, referenceKind: kind,
      line: cell.line, column: cell.column, filePath, language: 'robot', candidates });
  }
  function variable(cell: RobotCell, row: RobotRow, binding: RobotData['binding'], value?: unknown, conditional = false): void {
    const match = cell.text.match(/^([$@&]\{[^}]+\})(?:\s*=)?/);
    if (!match) return;
    node(binding === 'argument' ? 'parameter' : 'variable', match[1]!, row, {
      signature: row.cells.map(c => c.text).join('    '),
      decorators: robotDecorators({ owner, binding, value, conditional }),
    });
  }
  function variables(cells: RobotCell[]): void {
    for (const cell of cells) for (const match of cell.text.matchAll(/(?<!\\)[$@&%]\{([^{}]+)\}/g)) {
      ref({ ...cell, text: match[0], column: cell.column + match.index! }, 'references');
    }
  }
  function call(cells: RobotCell[], row: RobotRow, conditional = false): void {
    let i = 0;
    while (/^[$@&]\{[^}]+\}\s*=?$/.test(cells[i]?.text ?? '')) {
      // A lone ${name} is a dynamic call, not an assignment.
      if (i === cells.length - 1) break;
      variable(cells[i]!, row, 'assignment', undefined, conditional); i++;
    }
    const head = cells[i];
    if (!head) return;
    const args = cells.slice(i + 1);
    if (head.text === 'IF' && args.length > 1) {
      let start = 1;
      for (let j = 1; j <= args.length; j++) {
        if (j === args.length || args[j]!.text === 'ELSE' || args[j]!.text === 'ELSE IF') {
          call(args.slice(start, j), row, true);
          start = j + (args[j]?.text === 'ELSE IF' ? 2 : 1);
        }
      }
      variables(args); return;
    }
    if (head.text === 'VAR') {
      if (args[0]) variable(args[0], row, 'variable', args.slice(1).filter(c => !/^scope=/.test(c.text)).map(c => c.text), conditional);
      variables(args.slice(1)); return;
    }
    if (head.text === 'FOR') {
      for (const cell of args.slice(0, args.findIndex(c => /^IN(?: |$)/.test(c.text)))) variable(cell, row, 'assignment', undefined, true);
    } else if (head.text === 'EXCEPT') {
      const alias = args.findIndex(c => c.text === 'AS');
      if (alias >= 0 && args[alias + 1]) variable(args[alias + 1]!, row, 'assignment', undefined, true);
    }
    if (['IF', 'ELSE', 'ELSE IF', 'END', 'FOR', 'WHILE', 'TRY', 'EXCEPT', 'FINALLY', 'RETURN', 'BREAK', 'CONTINUE', 'GROUP'].includes(head.text)) {
      variables(args); return;
    }
    // Preserve arguments for resolver-owned BuiltIn dispatch. Shadowing is decided there.
    ref(head, 'calls', [JSON.stringify(args.map(c => c.text))]);
    variables(cells.slice(i));
  }
  const defaults = new Map<string, RobotRow>();
  let section = '';
  const definitions: { row: RobotRow; body: RobotRow[]; test: boolean }[] = [];
  let current: typeof definitions[number] | undefined;
  for (const row of rows) {
    const header = row.cells[0]!.text.match(/^\*{3}\s*(.*?)\s*\*{3}$/);
    if (header) { section = locale.header(header[1]!); current = undefined; continue; }
    if (section === 'settings' || section === 'setting') {
      const name = locale.setting(row.cells[0]!.text);
      defaults.set(name, row);
      if (['resource', 'library', 'variables'].includes(name) && row.cells[1]) {
        node('import', row.cells[1].text, row, { signature: row.cells.map(c => c.text).join('    '),
          decorators: robotDecorators({ args: row.cells.slice(2).map(c => c.text) }, `robot:${name}`) });
        ref({ ...row.cells[1], line: row.line }, 'imports');
      } else if (['suitesetup', 'suiteteardown'].includes(name)) call(row.cells.slice(1), row);
    } else if (section === 'variables' || section === 'variable') {
      variable(row.cells[0]!, row, 'variable', row.cells.slice(1).map(c => c.text));
    } else if (['keywords', 'keyword', 'testcases', 'testcase', 'tasks', 'task'].includes(section)) {
      if (!row.indented) {
        current = { row, body: [], test: !section.startsWith('keyword') };
        definitions.push(current);
        if (row.cells.length > 1) current.body.push({ ...row, cells: row.cells.slice(1), indented: true });
      } else current?.body.push(row);
    }
  }
  for (const definition of definitions) {
    const { row, body, test } = definition;
    const own = new Map(body.filter(r => /^\[.*\]$/.test(r.cells[0]!.text))
      .map(r => [locale.setting(r.cells[0]!.text.slice(1, -1)), r]));
    const args = own.get('arguments');
    const symbol = node('function', row.cells[0]!.text, row, {
      endLine: body[body.length - 1]?.endLine ?? row.endLine,
      endColumn: lines[(body[body.length - 1]?.endLine ?? row.endLine) - 1]?.length ?? 0,
      decorators: [test ? ROBOT_TEST : ROBOT_KEYWORD], isExported: !test,
      visibility: own.get('tags')?.cells.some(c => c.text.toLowerCase() === 'robot:private') ? 'private' : 'public',
      signature: args ? `${row.cells[0]!.text}    ${args.cells.slice(1).map(c => c.text).join('    ')}` : row.cells[0]!.text,
      docstring: own.get('documentation')?.cells.slice(1).map(c => c.text).join(' '),
    });
    owner = symbol.id;
    for (const cell of args?.cells.slice(1) ?? []) variable(cell, args!, 'argument');
    for (const match of symbol.name.matchAll(/\$\{([^}]+)\}/g)) {
      variable({ ...row.cells[0]!, text: '${' + match[1]!.split(':')[0] + '}' }, row, 'argument');
    }
    const setting = (name: string): RobotRow | undefined => {
      const declared = own.get(name) ?? (test ? defaults.get(`test${name}`) ?? defaults.get(`task${name}`) : undefined);
      if (declared || !test || !inherited[name]) return declared;
      return { ...row, cells: [{ ...row.cells[0]!, text: name }, ...inherited[name]!.map(text => ({ ...row.cells[0]!, text }))] };
    };
    for (const name of ['setup', 'teardown']) { const s = setting(name); if (s) call(s.cells.slice(1), s); }
    const template = test ? setting('template')?.cells[1] : undefined;
    const activeTemplate = template && template.text.toUpperCase() !== 'NONE';
    if (activeTemplate) ref(template, 'calls', ['[]', 'robot:template']);
    let depth = 0;
    for (const r of body) {
      if (/^\[.*\]$/.test(r.cells[0]!.text)) continue;
      if (r.cells[0]!.text === 'END') depth = Math.max(0, depth - 1);
      if (!activeTemplate) call(r.cells, r, depth > 0); else variables(r.cells);
      if (['IF', 'FOR', 'WHILE', 'TRY'].includes(r.cells[0]!.text)) depth++;
    }
    owner = fileId;
  }
  return result;
}
