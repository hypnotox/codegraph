/** Robot Framework symbols and references, extracted from the vendored grammar. */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// Persist the distinction using existing node metadata: tests are not keywords,
// and Library/Variables imports must not be resolved as Resource imports.
export const ROBOT_KEYWORD = 'robot:keyword';
export const ROBOT_TEST = 'robot:test';
export const ROBOT_RESOURCE = 'robot:resource';

export function normalizeRobotName(name: string): string {
  return name.toLowerCase().replace(/[\s_]/gu, '');
}

function child(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((n) => n.type === type);
}

/** Arguments can continue on subsequent lines; keep their order, not their children. */
function argumentsOf(node: SyntaxNode): SyntaxNode[] {
  const args = child(node, 'arguments');
  if (!args) return [];
  return args.namedChildren.flatMap((n) => n.type === 'argument' ? [n]
    : n.type === 'continuation' ? n.namedChildren.filter((c) => c.type === 'argument') : []);
}

function settingName(node: SyntaxNode): string {
  return normalizeRobotName(node.childForFieldName('name')?.text ?? '');
}

function isSetting(node: SyntaxNode): boolean {
  return node.type === 'keyword_setting' || node.type === 'test_case_setting';
}

function enabledKeyword(argument: SyntaxNode | undefined): string | undefined {
  const name = argument?.text.trim();
  return name && name.toUpperCase() !== 'NONE' ? name : undefined;
}

function extractRobot(root: SyntaxNode, ctx: ExtractorContext): void {
  const fileId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fileId) return;
  const settings = root.namedChildren
    .flatMap((section) => section.namedChildren)
    .filter((section) => section.type === 'settings_section')
    .flatMap((section) => section.namedChildren)
    .filter((n) => n.type === 'setting_statement');
  const defaults = new Map(settings.map((n) => [settingName(n), n]));

  function reference(name: string | undefined, at: SyntaxNode, kind: 'calls' | 'imports'): void {
    if (!name) return;
    ctx.addUnresolvedReference({
      fromNodeId: ctx.nodeStack[ctx.nodeStack.length - 1]!,
      referenceName: name,
      referenceKind: kind,
      line: at.startPosition.row + 1,
      column: at.startPosition.column,
      filePath: ctx.filePath,
      language: 'robot',
    });
  }

  function visitDefinition(node: SyntaxNode): void {
    const name = child(node, 'name')?.text.trim();
    if (!name) return;
    const isTest = node.type === 'test_case_definition';
    const body = child(node, 'body');
    const ownSettings = (body?.namedChildren ?? []).filter(isSetting);
    // The grammar also allows a keyword setting on the definition's first line.
    ownSettings.push(...node.namedChildren.filter(isSetting));
    const own = new Map(ownSettings.map((n) => [settingName(n), n]));
    const documentation = own.get('documentation');
    const args = own.get('arguments');
    const symbol = ctx.createNode('function', name, node, {
      decorators: [isTest ? ROBOT_TEST : ROBOT_KEYWORD],
      isExported: !isTest,
      signature: args ? `${name}    ${argumentsOf(args).map((n) => n.text).join('    ')}` : name,
      docstring: documentation ? argumentsOf(documentation).map((n) => n.text).join(' ') : undefined,
    });
    if (!symbol) return;
    ctx.pushScope(symbol.id);

    // A test-level NONE setting overrides, rather than inherits, its default.
    function testSetting(name: string): SyntaxNode | undefined {
      return own.get(name) ?? defaults.get(`test${name}`) ?? defaults.get(`task${name}`);
    }
    for (const name of isTest ? ['setup', 'teardown'] : ['teardown']) {
      const setting = isTest ? testSetting(name) : own.get(name);
      if (setting) reference(enabledKeyword(argumentsOf(setting)[0]), setting, 'calls');
    }
    const templateSetting = isTest ? testSetting('template') : undefined;
    const template = templateSetting ? enabledKeyword(argumentsOf(templateSetting)[0]) : undefined;
    if (template) reference(template, node, 'calls');
    // In a templated test these rows contain argument values, NOT keyword names.
    if (body && !template) visit(body);
    ctx.popScope();
  }

  function visit(node: SyntaxNode): void {
    switch (node.type) {
      case 'keyword_definition':
      case 'test_case_definition':
        visitDefinition(node);
        return;
      case 'setting_statement': {
        const name = settingName(node);
        const target = argumentsOf(node)[0];
        if (target && ['resource', 'library', 'variables'].includes(name)) {
          ctx.createNode('import', target.text.trim(), node, {
            signature: node.text.trim(),
            decorators: [name === 'resource' ? ROBOT_RESOURCE : `robot:${name}`],
          });
          reference(target.text.trim(), node, 'imports');
        } else if (name === 'suitesetup' || name === 'suiteteardown') {
          reference(enabledKeyword(target), node, 'calls');
        }
        return;
      }
      case 'keyword_invocation': {
        const keyword = child(node, 'keyword');
        if (keyword) reference(keyword.text.trim(), keyword, 'calls');
        return;
      }
      case 'variable_assignment': {
        // Hubro's grammar represents `${x}=    Keyword    arg` as arguments;
        // its first argument is the invoked keyword, not a variable value.
        const keyword = argumentsOf(node)[0];
        if (keyword) reference(keyword.text.trim(), keyword, 'calls');
        return;
      }
      case 'variable_definition': {
        const variable = node.namedChildren.find((n) =>
          ['scalar_variable', 'list_variable', 'dictionary_variable'].includes(n.type));
        if (variable) ctx.createNode('variable', variable.text, node, { signature: node.text.trim() });
        return;
      }
      case 'keyword_setting':
      case 'test_case_setting':
      case 'comment':
        return;
    }
    for (const item of node.namedChildren) visit(item);
  }

  visit(root);
}

export const robotExtractor: LanguageExtractor = {
  functionTypes: [], classTypes: [], methodTypes: [], interfaceTypes: [],
  structTypes: [], enumTypes: [], typeAliasTypes: [], importTypes: [],
  callTypes: [], variableTypes: [],
  nameField: 'name', bodyField: 'body', paramsField: 'arguments',
  visitNode(node, ctx) {
    if (node.type !== 'source_file') return false;
    extractRobot(node, ctx);
    return true;
  },
};
