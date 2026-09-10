# Robot Framework support

CodeGraph indexes `.robot` and `.resource` files with this vendored Tree-sitter
grammar. Installing CodeGraph does not install or fetch another grammar package.

## Graph coverage

- User keywords, tests/tasks, section variables, documentation and source ranges.
- Ordinary keyword calls, including assignment, loop and conditional bodies.
- Suite setup/teardown, keyword teardown, and per-file test/task setup, teardown
  and templates, including per-test overrides and `NONE`.
- Relative `Resource` imports, `${CURDIR}` and `${/}`, transitive resources,
  resource-qualified calls, and case/space/underscore-insensitive keyword lookup.
- English Given/When/Then/And/But prefixes, after trying the full keyword name.

On Robot file changes, sync re-evaluates Robot reference bindings, including
unchanged callers, without reparsing unchanged files.

Tests and keywords share CodeGraph's existing `function` node kind but are tagged
`robot:test` and `robot:keyword`. Only keywords are eligible call targets. Template
rows are arguments, not keyword calls. Displayed names retain their original text.

This is static analysis, not the Robot runtime. Python/library keyword resolution,
embedded-argument matching, dynamically constructed names/imports, keywords passed
as arguments to `Run Keyword`-style dispatchers, and inherited `__init__.robot`
suite settings are not resolved. Library and Variables imports are recorded but
not linked to implementations. Lookup follows each source file's own resource
imports; runtime caller-suite search paths are not inferred. Ambiguous and
unsupported references remain unresolved rather than falling back to unrelated
same-named symbols elsewhere in the project. Syntax coverage follows the vendored
grammar; this is not a claim of complete Robot Framework version compatibility.

## Provenance and local changes

Source: https://github.com/Hubro/tree-sitter-robot

Pinned commit: `8f1a8d8c3875db2cd29865b5a1db7716b4eab4c3` (2026-08-19).

Copyright 2022 Tomas Sandven; ISC license, retained in `LICENSE`. The normal
CodeGraph build copies this notice beside the distributed Robot WASM.

The syntax rules are unchanged. The metadata additionally recognizes `.resource`
and omits unused editor-query and host-binding declarations. Only grammar/build
inputs, generated parser sources and the parser corpus are retained; editor
queries, host-language bindings and upstream package/release tooling are omitted.
Generated sources and WASM use Tree-sitter CLI **0.25.10**, ABI **14**, to match
CodeGraph's `web-tree-sitter` runtime. There is no submodule or runtime dependency
on the upstream repository.

## Build and test

Normal development uses the committed WASM and needs no grammar compiler:

```sh
npm ci
npm run build
npx vitest run __tests__/robot-framework.test.ts
```

Only grammar changes require regenerating the parser. Install Tree-sitter CLI
0.25.10 and Emscripten (`emcc` on PATH), then run from the CodeGraph root:

```sh
npm run build:grammar:robot
npm run build
npx vitest run __tests__/robot-framework.test.ts
```

The rebuild script generates the parser, runs the retained corpus, and replaces
`src/extraction/wasm/tree-sitter-robot.wasm`. It reads only checked-in grammar
sources, not an upstream checkout. Commit generated sources and the WASM together.
