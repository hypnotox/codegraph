import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { detectLanguage, getLanguageDisplayName, isSourceFile, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { ROBOT_KEYWORD, ROBOT_TEST } from '../src/extraction/languages/robot';

beforeAll(async () => { await loadGrammarsForLanguages(['robot']); });

function extract(source: string, file = 'suite.robot') {
  return extractFromSource(file, source, 'robot');
}

const keywords = (...names: string[]) => `*** Keywords ***\n${names.map((n) => `${n}\n    Log    ok\n`).join('\n')}`;

describe('Robot Framework extraction', () => {
  it('recognizes suite and resource extensions without configuration', () => {
    for (const file of ['suite.robot', 'shared.resource', 'SUITE.ROBOT', 'SHARED.RESOURCE']) {
      expect(detectLanguage(file)).toBe('robot');
      expect(isSourceFile(file)).toBe(true);
    }
    expect(getLanguageDisplayName('robot')).toBe('Robot Framework');
  });

  it('preserves keyword/test names, documentation, source ranges and variables', () => {
    const result = extract(`*** Variables ***\n\${NAME}    world\n\n*** Test Cases ***\nA Test\n    My Keyword    \${NAME}\n\n*** Keywords ***\nMy Keyword\n    [Documentation]    A useful keyword.\n    [Arguments]    \${value}\n    Log    \${value}\n`);
    expect(result.errors).toEqual([]);
    const keyword = result.nodes.find((n) => n.name === 'My Keyword');
    expect(keyword).toMatchObject({ kind: 'function', startLine: 9, docstring: 'A useful keyword.', isExported: true });
    expect(keyword?.endLine).toBeGreaterThanOrEqual(12);
    expect(keyword?.decorators).toContain(ROBOT_KEYWORD);
    expect(keyword?.signature).toContain('${value}');
    expect(result.nodes.find((n) => n.name === 'A Test')?.decorators).toContain(ROBOT_TEST);
    expect(result.nodes.find((n) => n.name === '${NAME}')?.kind).toBe('variable');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: result.nodes.find((n) => n.name === 'A Test')!.id, referenceName: 'My Keyword', referenceKind: 'calls', line: 6, column: 4 }),
    ]));
  });

  it('extracts calls in assignments, loops, conditionals and keyword teardown', () => {
    const result = extract(`*** Keywords ***\nWork\n    [Teardown]    Cleanup\n    \${value}=    Fetch Value\n    IF    \${value}\n        Use Value\n    END\n    FOR    \${item}    IN    a    b\n        Process Item    \${item}\n    END\n    IF    \${value}    Inline Yes    ELSE    Inline No\n`);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toEqual(expect.arrayContaining(['Cleanup', 'Fetch Value', 'Use Value', 'Process Item', 'Inline Yes', 'Inline No']));
    expect(calls).toHaveLength(6);
  });

  it('records Resource, Library and Variables imports, including continuation arguments', () => {
    const result = extract(`*** Settings ***\nResource\n...    shared.resource\nLibrary    Collections\nVariables    values.py\n`, 'shared.robot');
    expect(result.nodes.filter((n) => n.kind === 'import').map((n) => n.name)).toEqual(['shared.resource', 'Collections', 'values.py']);
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'imports')).toHaveLength(3);
  });

  it('treats template rows as data and preserves setup/teardown calls', () => {
    const result = extract(`*** Settings ***\nTest Template    Check Value\nTest Setup    Prepare\nTest Teardown    Cleanup\n\n*** Test Cases ***\nDefault Template\n    not a keyword    second value\nOwn Template\n    [Template]    Other Check\n    another value\nNormal Test\n    [Template]    NONE\n    [Setup]    NONE\n    Real Keyword\n`);
    const calls = (name: string) => result.unresolvedReferences.filter((r) => r.fromNodeId === result.nodes.find((n) => n.name === name)!.id).map((r) => r.referenceName);
    expect(calls('Default Template')).toEqual(['Prepare', 'Cleanup', 'Check Value']);
    expect(calls('Own Template')).toEqual(['Prepare', 'Cleanup', 'Other Check']);
    expect(calls('Normal Test')).toEqual(['Cleanup', 'Real Keyword']);
    expect(result.unresolvedReferences.some((r) => r.referenceName.includes('value'))).toBe(false);
  });

  it('honors task defaults and supports inline template rows', () => {
    const result = extract(`*** Settings ***\nTask Template    Check\nTask Setup    Prepare\n\n*** Tasks ***\nOne    a    b\nTwo    c    d\n`);
    expect(result.nodes.filter((n) => n.decorators?.includes(ROBOT_TEST))).toHaveLength(2);
    expect(result.unresolvedReferences.map((r) => r.referenceName)).toEqual(['Prepare', 'Check', 'Prepare', 'Check']);
  });

  it('handles Unicode names, CRLF and a final line without a newline', () => {
    const result = extract('*** Keywords ***\r\nPrüfe Größe\r\n    Andere Prüfung');
    expect(result.nodes.find((n) => n.name === 'Prüfe Größe')).toBeDefined();
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'Andere Prüfung')).toBe(true);
  });
});

describe('Robot Framework indexing and resolution', () => {
  let dir: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-robot-')); });
  afterEach(() => { graph?.destroy(); graph = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  function write(file: string, source: string) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  async function index(files: Record<string, string>) {
    for (const [file, source] of Object.entries(files)) write(file, source);
    graph = await CodeGraph.init(dir, { silent: true });
    await graph.indexAll();
  }

  function edges(kind = 'calls'): { source: string; sourceFile: string; target: string; targetFile: string }[] {
    return (graph as any).db.db.prepare(`SELECT s.name AS source, s.file_path AS sourceFile, t.name AS target, t.file_path AS targetFile
      FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind=? ORDER BY e.line, e.id`).all(kind);
  }

  it('indexes resources and resolves local and cross-file calls with Robot name normalization', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nA Test\n    OPEN_session\n\n*** Keywords ***\nLocal Work\n    OPEN session\n`,
      'shared.resource': keywords('Open Session'),
    });
    expect(edges()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'A Test', target: 'Open Session', targetFile: 'shared.resource' }),
      expect.objectContaining({ source: 'Local Work', target: 'Open Session', targetFile: 'shared.resource' }),
    ]));
    expect(edges('imports')).toEqual(expect.arrayContaining([expect.objectContaining({ sourceFile: 'suite.robot', targetFile: 'shared.resource' })]));
  });

  it('follows transitive relative resources and CURDIR from each importing file', async () => {
    await index({
      'tests/suite.robot': `*** Settings ***\nResource    ../resources/one.resource\n\n*** Test Cases ***\nA Test\n    Two.Do Work\n`,
      'resources/one.resource': `*** Settings ***\nResource    \${CURDIR}/nested/Two.resource\n`,
      'resources/nested/Two.resource': keywords('Do Work'),
    });
    expect(edges()).toContainEqual(expect.objectContaining({ source: 'A Test', target: 'Do Work', targetFile: 'resources/nested/Two.resource' }));
    expect(edges('imports')).toHaveLength(2);
  });

  it('prefers a local keyword over imported names and never targets a same-named test', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nWork\n    WORK\n\n${keywords('Work')}`,
      'shared.resource': keywords('Work'),
    });
    expect(edges().filter((e) => e.source === 'Work')).toEqual([
      { source: 'Work', sourceFile: 'suite.robot', target: 'Work', targetFile: 'suite.robot' },
    ]);
  });

  it('resolves a static Python library without guessing unrelated or dynamic targets', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    a.resource\nResource    b.resource\nLibrary    library.py\n\n*** Test Cases ***\nA Test\n    Ambiguous\n    Unimported\n    Python Call\n    \${dynamic}\n`,
      'a.resource': keywords('Ambiguous'),
      'b.resource': keywords('Ambiguous'),
      'unrelated.resource': keywords('Unimported', 'Python Call'),
      'library.py': 'def python_call():\n    pass\n',
    });
    expect(edges()).toEqual([expect.objectContaining({ target: 'python_call', targetFile: 'library.py' })]);
    expect(edges('imports')).toHaveLength(3);
  });

  it('uses explicit resource qualification to disambiguate otherwise equal keywords', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    a.resource\nResource    b.resource\n\n*** Test Cases ***\nA Test\n    a.DO_work\n`,
      'a.resource': keywords('Do Work'),
      'b.resource': keywords('Do Work'),
    });
    expect(edges()).toEqual([{ source: 'A Test', sourceFile: 'suite.robot', target: 'Do Work', targetFile: 'a.resource' }]);
  });

  it('resolves BDD prefixes before full names, following Robot Framework', async () => {
    await index({
      'suite.robot': `*** Test Cases ***\nA Test\n    Given Ready\n    When Ready\n\n${keywords('Given Ready', 'Ready')}`,
    });
    expect(edges().filter((e) => e.source === 'A Test').map((e) => e.target).sort()).toEqual(['Ready', 'Ready']);
  });

  it('does not loop or duplicate keyword candidates when resource imports form a cycle', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    a.resource\n\n*** Test Cases ***\nA Test\n    Work\n`,
      'a.resource': `*** Settings ***\nResource    b.resource\n\n${keywords('Work')}`,
      'b.resource': `*** Settings ***\nResource    a.resource\n`,
    });
    expect(edges()).toEqual([{ source: 'A Test', sourceFile: 'suite.robot', target: 'Work', targetFile: 'a.resource' }]);
  });

  it('resolves an unchanged normalized caller when its resource gains the keyword', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nA Test\n    NEW_keyword\n`,
      'shared.resource': keywords('Existing'),
    });
    expect(edges()).toEqual([]);
    write('shared.resource', keywords('Existing', 'New Keyword'));
    await graph!.sync();
    expect(edges()).toContainEqual(expect.objectContaining({ source: 'A Test', target: 'New Keyword' }));
  });

  it('updates unchanged callers when a transitive resource import changes', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nA Test\n    Work\n`,
      'shared.resource': `*** Settings ***\nResource    a.resource\n`,
      'a.resource': keywords('Work'),
      'b.resource': keywords('Work'),
    });
    expect(edges()).toContainEqual(expect.objectContaining({ source: 'A Test', targetFile: 'a.resource' }));
    write('shared.resource', `*** Settings ***\nResource    b.resource\n`);
    await graph!.sync();
    expect(edges()).toEqual([{ source: 'A Test', sourceFile: 'suite.robot', target: 'Work', targetFile: 'b.resource' }]);
  });

  it('drops an old binding when a new normalized keyword makes an imported call ambiguous', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    a.resource\nResource    b.resource\n\n*** Test Cases ***\nA Test\n    Do Work\n`,
      'a.resource': keywords('Do Work'),
      'b.resource': keywords('Other'),
    });
    expect(edges()).toHaveLength(1);
    write('b.resource', keywords('Other', 'DO_work'));
    await graph!.sync({ paths: ['b.resource'] });
    expect(edges()).toEqual([]);
  });

  it('updates resource visibility after deletion and recreation without changing the suite', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nA Test\n    Work\n`,
      'shared.resource': `*** Settings ***\nResource    a.resource\n`,
      'a.resource': keywords('Work'),
    });
    expect(edges()).toHaveLength(1);
    fs.unlinkSync(path.join(dir, 'shared.resource'));
    await graph!.sync({ paths: ['shared.resource'] });
    expect(edges()).toEqual([]);
    write('shared.resource', `*** Settings ***\nResource    a.resource\n`);
    await graph!.sync({ paths: ['shared.resource'] });
    expect(edges()).toContainEqual(expect.objectContaining({ source: 'A Test', targetFile: 'a.resource' }));
    const unchanged = await graph!.sync();
    expect(unchanged.filesModified + unchanged.filesAdded + unchanged.filesRemoved).toBe(0);
    expect(edges()).toHaveLength(1);
  });

  it('re-resolves after a resource keyword is renamed and its caller changes', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nA Test\n    Before\n`,
      'shared.resource': keywords('Before'),
    });
    expect(edges().map((e) => e.target)).toEqual(['Before']);
    write('shared.resource', keywords('After'));
    write('suite.robot', `*** Settings ***\nResource    shared.resource\n\n*** Test Cases ***\nA Test\n    After\n`);
    await graph!.sync();
    expect(edges().map((e) => e.target)).toEqual(['After']);
  });
  it('resolves embedded arguments and regex constraints, preferring exact and more specific matches', async () => {
    await index({ 'suite.robot': `*** Test Cases ***\nExample\n    User Alice logs in\n    Count 42\n    Count nope\n    User Bob logs in\n\n${keywords('User ${name} logs in', 'User Bob logs in', 'Count ${number:\\d+}')} ` });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual([
      'User ${name} logs in', 'Count ${number:\\d+}', 'User Bob logs in',
    ]);
  });

  it('keeps ambiguous embedded matches unresolved', async () => {
    await index({ 'suite.robot': `*** Test Cases ***\nExample\n    Do a thing\n\n${keywords('Do ${value}', '${action} a thing')}` });
    expect(edges()).toEqual([]);
  });

  it('resolves literal suite variables, nested names and collection lookups in imports and calls', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    \${FOLDER}/shared.resource\n*** Variables ***\n\${FOLDER}    resources\n\${NAME}    Work\n\${SELECT}    NAME\n@{NAMES}    Work    Other\n&{WORDS}    action=Work\n*** Test Cases ***\nExample\n    \${NAME}\n    \${\${SELECT}}\n    \${NAMES}[0]\n    \${WORDS.action}\n`,
      'resources/shared.resource': keywords('Work'),
    });
    expect(edges().filter(e => e.source === 'Example')).toHaveLength(4);
    expect(edges('references').some(e => e.target === '${NAME}')).toBe(true);
  });

  it('binds arguments and assignments without treating their values as known at runtime', async () => {
    await index({ 'suite.robot': `*** Variables ***\n\${TARGET}    Work\n*** Keywords ***\nCaller\n    [Arguments]    \${TARGET}=Work\n    \${TARGET}\nOther Caller\n    \${TARGET}=    Compute\n    \${TARGET}\n${keywords('Work', 'Compute').replace('*** Keywords ***\n', '')}` });
    expect(edges().filter(e => e.source === 'Caller')).toEqual([]);
    expect(edges().filter(e => e.source === 'Other Caller').map(e => e.target)).toEqual(['Compute']);
    expect(edges('references').filter(e => e.source === 'Caller').map(e => e.target)).toEqual(['${TARGET}']);
  });

  it('resolves straight-line VAR values but does not assert branch-dependent values', async () => {
    await index({ 'suite.robot': `*** Test Cases ***\nExample\n    VAR    \${target}    Work\n    \${target}\n    IF    \${condition}\n        VAR    \${target}    Other\n    END\n    \${target}\n\n${keywords('Work', 'Other')}` });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Work']);
  });

  it('handles pipe syntax, escaped pipes, comments and continuation cells', async () => {
    await index({ 'suite.robot': '| *** Settings *** |\n| Resource | shared.resource |\n| *** Test Cases *** |\n| Example |\n| | Work | first |\n| | ... | second |\n| | Escaped \\| Pipe | # comment |\n', 'shared.resource': keywords('Work', 'Escaped \\| Pipe') });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Work', 'Escaped \\| Pipe']);
  });

  it('resolves Python aliases, decorated keyword names, automatic exposure and inherited methods', async () => {
    await index({
      'suite.robot': `*** Settings ***\nLibrary    libs.Actions    AS    API\n*** Test Cases ***\nExample\n    API.Custom Name\n    API.Inherited\n    API.Hidden\n    API.Undecorated\n`,
      'libs.py': `from robot.api.deco import keyword as kw, library\nclass Base:\n    def inherited(self):\n        pass\n@library\nclass Actions(Base):\n    @kw(name="Custom Name")\n    def custom(self):\n        pass\n    def undecorated(self):\n        pass\n    def _hidden(self):\n        pass\n`,
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['custom', 'inherited']);
  });

  it('honors not_keyword and does not execute dynamic libraries', async () => {
    await index({
      'suite.robot': `*** Settings ***\nLibrary    ordinary.py\nLibrary    Dynamic.py\n*** Test Cases ***\nExample\n    Public\n    Hidden\n    Dynamic.Public\n`,
      'ordinary.py': `from robot.api.deco import not_keyword\ndef public():\n    pass\n@not_keyword\ndef hidden():\n    pass\n`,
      'Dynamic.py': `class Dynamic:\n    def get_keyword_names(self):\n        return ['public']\n    def public(self):\n        pass\n`,
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['public']);
  });

  it('follows BuiltIn nested calls and every conditional arm without evaluating conditions', async () => {
    await index({ 'suite.robot': `*** Test Cases ***\nExample\n    Run Keyword    Work\n    Run Keywords    Work    AND    Other\n    Run Keyword If    \${condition}    Work    ELSE IF    \${other}    Other    ELSE    Last\n    Wait Until Keyword Succeeds    2x    1s    Run Keyword    Last\n\n${keywords('Work', 'Other', 'Last')}` });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Work', 'Work', 'Other', 'Work', 'Other', 'Last', 'Last']);
  });

  it('does not treat a shadowed Run Keyword as BuiltIn dispatch', async () => {
    await index({ 'suite.robot': `*** Test Cases ***\nExample\n    Run Keyword    Work\n\n${keywords('Run Keyword', 'Work')}` });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Run Keyword']);
  });

  it('loads Python and JSON static variables for transitive resource lookup', async () => {
    await index({
      'suite.robot': `*** Settings ***\nVariables    values.py\nVariables    names.json\nResource    \${DIRECTORY}/\${FILE}\n*** Test Cases ***\nExample\n    \${KEYWORD}\n`,
      'values.py': `DIRECTORY = 'resources'\nKEYWORD = 'Work'\nUNKNOWN = compute()\n`,
      'names.json': '{"FILE": "shared.resource"}',
      'resources/shared.resource': keywords('Work'),
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Work']);
    expect(edges('imports')).toHaveLength(3);
  });

  it('loads static YAML literals and reports unsupported constructs', async () => {
    await index({ 'suite.robot': `*** Settings ***\nVariables    values.yaml\n*** Test Cases ***\nExample\n    \${KEYWORD}\n\n${keywords('Work')}`, 'values.yaml': 'KEYWORD: Work\nNESTED:\n  key: value\n' });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Work']);
  });

  it('resolves pre-generated Libdoc XML and JSON without importing the library', async () => {
    await index({
      'suite.robot': `*** Settings ***\nLibrary    Remote.libspec    WITH NAME    Remote\nLibrary    More.json    AS    More\n*** Test Cases ***\nExample\n    Remote.Do Work\n    More.Other Work\n`,
      'Remote.libspec': '<keywordspec name="Remote"><kw name="Do Work"><doc>Does work.</doc></kw></keywordspec>',
      'More.json': '{"name":"More", "type":"LIBRARY", "keywords":[{"name":"Other Work", "doc":"More work."}]}',
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Do Work', 'Other Work']);
  });

  it('rebinds unchanged Robot callers after Python decorator and JSON variable edits', async () => {
    await index({
      'suite.robot': `*** Settings ***\nLibrary    lib.py\nVariables    vars.json\n*** Test Cases ***\nExample\n    Run Keyword    \${TARGET}\n`,
      'lib.py': 'def work():\n    pass\n', 'vars.json': '{"TARGET":"Work"}',
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['work']);
    write('lib.py', 'from robot.api.deco import keyword\n@keyword("Other")\ndef work():\n    pass\n');
    await graph!.sync();
    expect(edges().filter(e => e.source === 'Example')).toEqual([]);
    write('vars.json', '{"TARGET":"Other"}');
    await graph!.sync();
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['work']);
  });

  it('resolves imported base classes and module keyword reexports with __all__', async () => {
    await index({
      'suite.robot': `*** Settings ***\nLibrary    child.Child\nLibrary    facade.py\n*** Test Cases ***\nExample\n    child.Child.Base Work\n    Renamed Work\n    Excluded\n`,
      'base.py': 'class Base:\n    def base_work(self):\n        pass\n',
      'child.py': 'from base import Base\nclass Child(Base):\n    pass\n',
      'implementation.py': 'def work():\n    pass\n',
      'facade.py': 'from implementation import work as renamed_work\n__all__ = ["renamed_work"]\ndef excluded():\n    pass\n',
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['base_work', 'work']);
  });

  it('finds an unambiguous checked-in Libdoc by library name', async () => {
    await index({ 'suite.robot': `*** Settings ***\nLibrary    Remote\n*** Test Cases ***\nExample\n    Remote.Remote Work\n`,
      'specs/Remote.libspec': '<keywordspec name="Remote"><kw name="Remote Work"><doc>Remote.</doc></kw></keywordspec>' });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Remote Work']);
  });

  it('keeps CURDIR tied to the resource that declares a variable', async () => {
    await index({ 'suite.robot': `*** Settings ***\nResource    resources/vars.resource\nResource    \${MORE}\n*** Test Cases ***\nExample\n    Work\n`,
      'resources/vars.resource': '*** Variables ***\n${MORE}    ${CURDIR}/work.resource\n',
      'resources/work.resource': keywords('Work') });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Work']);
  });

  it('keeps resource and variable cycles unresolved without executing Python providers', async () => {
    await index({ 'suite.robot': `*** Settings ***\nVariables    vars.py\nResource    \${A}\n*** Variables ***\n\${A}    \${B}\n\${B}    \${A}\n*** Test Cases ***\nExample\n    \${TARGET}\n\n${keywords('Work')}`,
      'vars.py': 'TARGET = "Work"\ndef get_variables():\n    raise RuntimeError("must never execute")\n' });
    expect(edges().filter(e => e.source === 'Example')).toEqual([]);
  });

  it('refreshes bindings on reopen and converges to a fresh index after data edits', async () => {
    const files = { 'suite.robot': `*** Settings ***\nVariables    vars.json\n*** Test Cases ***\nExample\n    Run Keywords    \${TARGET}    AND    Last\n\n${keywords('Work', 'Other', 'Last')}`, 'vars.json': '{"TARGET":"Work"}' };
    await index(files);
    graph!.destroy(); graph = await CodeGraph.open(dir, { silent: true });
    write('vars.json', '{"TARGET":"Other"}');
    await graph!.sync({ paths: ['vars.json'] });
    const synced = edges().filter(e => e.source === 'Example');
    expect(synced.map(e => e.target)).toEqual(['Other', 'Last']);
    graph!.destroy(); graph = undefined;
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    graph = await CodeGraph.init(dir, { silent: true }); await graph.indexAll();
    expect(edges().filter(e => e.source === 'Example')).toEqual(synced);
  });

  it('inherits test defaults and reparses children after init edits and deletion', async () => {
    await index({
      '__init__.robot': '*** Settings ***\nTest Setup    Prepare\nTest Template    Work\n',
      'tests/suite.robot': `*** Test Cases ***\nExample\n    data value\nExplicit\n    [Setup]    NONE\n    [Template]    NONE\n    Other\n\n${keywords('Prepare', 'Work', 'Other', 'data value')}`,
    });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Prepare', 'Work']);
    expect(edges().filter(e => e.source === 'Explicit').map(e => e.target)).toEqual(['Other']);
    write('__init__.robot', '*** Settings ***\nTest Template    Other\n');
    await graph!.sync({ paths: ['__init__.robot'] });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['Other']);
    fs.unlinkSync(path.join(dir, '__init__.robot'));
    await graph!.sync({ paths: ['__init__.robot'] });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['data value']);
  });

  it('binds embedded templates without treating data rows as calls', async () => {
    await index({ 'suite.robot': `*** Settings ***\nTest Template    User \${name} logs in\n*** Test Cases ***\nExample\n    Alice\n    Bob\n\n${keywords('User ${name} logs in', 'Alice', 'Bob')}` });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['User ${name} logs in']);
  });

  it('resolves source-declared localized headers, settings and BDD prefixes', async () => {
    await index({ 'suite.robot': 'Language: de\n*** Einstellungen ***\nRessource    shared.resource\n*** Testfälle ***\nBeispiel\n    Angenommen Bereit\n', 'shared.resource': keywords('Bereit') });
    expect(edges().filter(e => e.source === 'Beispiel').map(e => e.target)).toEqual(['Bereit']);
  });

  it('keeps self-referencing list variables unknown', async () => {
    await index({ 'suite.robot': `*** Variables ***\n@{CYCLE}    \${CYCLE}\n*** Test Cases ***\nExample\n    \${CYCLE}[0]\n` });
    expect(edges()).toEqual([]);
  });

  it('respects import order for variables from nested resources and data files', async () => {
    await index({ 'suite.robot': `*** Settings ***\nResource    first.resource\nVariables    later.json\n*** Test Cases ***\nExample\n    \${TARGET}\n\n${keywords('First', 'Later')}`,
      'first.resource': '*** Settings ***\nVariables    first.json\n',
      'first.json': '{"TARGET":"First"}', 'later.json': '{"TARGET":"Later"}' });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['First']);
  });

  it('supports BuiltIn aliases and keywords decorated only with tags', async () => {
    await index({ 'suite.robot': '*** Settings ***\nLibrary    BuiltIn    AS    BI\nLibrary    lib.py\n*** Test Cases ***\nExample\n    BI.Run Keyword    Work\n',
      'lib.py': 'from robot.api.deco import keyword\n@keyword(tags=["example"])\ndef work():\n    pass\n' });
    expect(edges().filter(e => e.source === 'Example').map(e => e.target)).toEqual(['work']);
  });

  it('uses a checked-in spec for an otherwise dynamic local library', async () => {
    await index({ 'suite.robot': '*** Settings ***\nLibrary    Dynamic.py\n*** Test Cases ***\nExample\n    Dynamic.Work\n',
      'Dynamic.py': 'class Dynamic:\n    def get_keyword_names(self):\n        raise RuntimeError("must not execute")\n',
      'specs/Dynamic.libspec': '<keywordspec name="Dynamic"><kw name="Work"><doc>Known from Libdoc.</doc></kw></keywordspec>' });
    expect(edges().filter(e => e.source === 'Example')).toEqual([expect.objectContaining({ target: 'Work', targetFile: 'specs/Dynamic.libspec' })]);
  });

});
