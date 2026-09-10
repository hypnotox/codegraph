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
      FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind=?`).all(kind);
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

  it('does not guess an unimported, ambiguous, dynamic or Python-library target', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    a.resource\nResource    b.resource\nLibrary    library.py\n\n*** Test Cases ***\nA Test\n    Ambiguous\n    Unimported\n    Python Call\n    \${dynamic}\n`,
      'a.resource': keywords('Ambiguous'),
      'b.resource': keywords('Ambiguous'),
      'unrelated.resource': keywords('Unimported', 'Python Call'),
      'library.py': 'def python_call():\n    pass\n',
    });
    expect(edges()).toEqual([]);
    expect(edges('imports')).toHaveLength(2);
  });

  it('uses explicit resource qualification to disambiguate otherwise equal keywords', async () => {
    await index({
      'suite.robot': `*** Settings ***\nResource    a.resource\nResource    b.resource\n\n*** Test Cases ***\nA Test\n    a.DO_work\n`,
      'a.resource': keywords('Do Work'),
      'b.resource': keywords('Do Work'),
    });
    expect(edges()).toEqual([{ source: 'A Test', sourceFile: 'suite.robot', target: 'Do Work', targetFile: 'a.resource' }]);
  });

  it('resolves BDD prefixes but prefers a keyword whose complete name matches', async () => {
    await index({
      'suite.robot': `*** Test Cases ***\nA Test\n    Given Ready\n    When Ready\n\n${keywords('Given Ready', 'Ready')}`,
    });
    expect(edges().filter((e) => e.source === 'A Test').map((e) => e.target).sort()).toEqual(['Given Ready', 'Ready']);
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
});
