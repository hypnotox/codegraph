# Robot Framework support

CodeGraph indexes `.robot` and `.resource` files with a native data parser.
The vendored Tree-sitter grammar remains available for source highlighting;
it no longer limits graph extraction. No Robot installation or Python execution
is required.

## Graph coverage

- Space/tab and pipe formats, continuations, comments, escaped literals, Unicode,
  CRLF, and source-declared language aliases.
- Keywords, tests/tasks, documentation, arguments, section variables, local `VAR`
  bindings, assignments, loops and conditionals, with original source ranges.
- Suite/keyword/test setup and teardown, templates, per-test `NONE` overrides,
  and test defaults inherited from ancestor `__init__.robot` files.
- Relative and transitive resources, static variables in paths and keyword names,
  `${CURDIR}` relative to its declaring file, collection lookups and nested names.
- Local/resource/library precedence, explicit namespaces and aliases, normalized
  names, localized BDD prefixes, embedded arguments and compatible regular expressions.
  Ambiguity remains unresolved; lookup never falls back to unrelated global symbols.
- Static Python modules/classes, decorated names, automatic keyword exposure,
  `@not_keyword`, `@library`, `ROBOT_AUTO_KEYWORDS`, `__all__`, imported base classes
  and function reexports. Calls target the existing Python implementation nodes.
- Literal Python and JSON variables and the YAML subset below. JSON files are
  tracked as data files so their edits participate in incremental indexing.
  References to JSON/YAML variables lead to their source document.
- Checked-in Libdoc XML (`.libspec` or `.xml`) and JSON keyword specifications,
  imported by path or by a unique matching library filename.
- BuiltIn `Run Keyword`, `Run Keywords`, conditional/error-handling variants,
  `Repeat Keyword` and `Wait Until Keyword Succeeds` connect to statically named
  nested keywords, including alternative branches. A shadowing user/library
  keyword does not acquire BuiltIn semantics.

Sync rebinds Robot callers after Robot, Python, variable-document or Libdoc edits.
Changing/removing an initialization file also reparses affected child suites:
a changed template can turn argument rows into calls or vice versa. Other
unchanged Robot files keep their extracted symbols.

## Static-analysis boundaries

This is not runtime emulation. Environment/command-line values, executed variable
providers, computed Python expressions, library constructors and dynamic/hybrid
keyword APIs are not evaluated. Installed libraries need local source or a
checked-in Libdoc; no interpreter or installed-package search is performed.
Python module search covers the importing directory, project root, and `src`
layouts with `pyproject.toml` or `setup.py`. Runtime search-order changes and
caller-suite-specific resource environments are not inferred.

Arguments and keyword-call return values are unknown. Straight-line local `VAR`
values may resolve; branch-dependent assignments do not become asserted constants.
The graph follows every statically identified conditional target without claiming
which branch executes.

The native YAML reader supports literal block mappings/sequences, scalar values,
and JSON-form flow values. Anchors, aliases, tags, block scalars, timestamps and
non-JSON flow syntax still require a complete YAML parser and remain unresolved.
Use JSON variable files when that full static-data coverage is needed on this
branch. Python-specific embedded-regexp extensions not supported by JavaScript
also remain unresolved. These are remaining static coverage limits, not runtime
features.

## Local validation

```sh
npm ci
npm run build
npx vitest run __tests__/robot-framework.test.ts
node dist/bin/codegraph.js index --help
```

Use a fresh index (or force a rebuild) when testing an existing project; the
extraction version changed. Normal builds need no grammar compiler.

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
