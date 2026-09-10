/** Static Robot keyword lookup: local keywords, then explicitly imported resources. */
import * as path from 'path';
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { normalizeRobotName, ROBOT_KEYWORD, ROBOT_RESOURCE } from '../extraction/languages/robot';

/** Resolve only indexed Robot files, relative to the file containing the import. */
function resourcePath(name: string, from: string, context: ResolutionContext): string | null {
  const directory = path.dirname(from);
  // CURDIR denotes the importing file's directory, not the process cwd.
  const expanded = name.replace(/\$\{CURDIR\}/gi, path.resolve(context.getProjectRoot(), directory))
    .replace(/\$\{\/\}/g, '/');
  if (/[$@&%]\{/.test(expanded)) return null;
  const absolute = path.isAbsolute(expanded) ? expanded
    : path.resolve(context.getProjectRoot(), directory, expanded);
  const relative = path.relative(context.getProjectRoot(), absolute).replace(/\\/g, '/');
  return context.getNodesInFile(relative).some((n) => n.kind === 'file' && n.language === 'robot')
    ? relative : null;
}

function resourceImports(file: string, context: ResolutionContext): Node[] {
  return context.getNodesInFile(file).filter((n) =>
    n.kind === 'import' && n.decorators?.includes(ROBOT_RESOURCE));
}

/** Walk imports from extracted nodes; no second source parser or whole-project name search. */
function visibleFiles(file: string, context: ResolutionContext): string[] {
  const seen = new Set<string>();
  const pending = [file];
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const resource of resourceImports(next, context)) {
      const target = resourcePath(resource.name, next, context);
      if (target && !seen.has(target)) pending.push(target);
    }
  }
  return [...seen];
}

function keywords(file: string, context: ResolutionContext): Node[] {
  return context.getNodesInFile(file).filter((n) =>
    n.language === 'robot' && n.kind === 'function' && n.decorators?.includes(ROBOT_KEYWORD));
}

function matchingKeywords(name: string, files: string[], context: ResolutionContext): Node[] {
  const normalized = normalizeRobotName(name);
  const local = keywords(files[0]!, context).filter((n) => normalizeRobotName(n.name) === normalized);
  if (local.length) return local;
  const imported = files.slice(1).flatMap((file) => keywords(file, context))
    .filter((n) => normalizeRobotName(n.name) === normalized);
  if (imported.length) return imported;

  // A keyword's full name can itself contain dots. Try ordinary names first,
  // then an explicit resource namespace (the filename without its extension).
  return files.flatMap((file) => {
    const namespace = normalizeRobotName(path.basename(file, path.extname(file)));
    if (!normalized.startsWith(`${namespace}.`)) return [];
    const keyword = normalized.slice(namespace.length + 1);
    return keywords(file, context).filter((n) => normalizeRobotName(n.name) === keyword);
  });
}

export function resolveRobotReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind === 'imports') {
    const resource = resourceImports(ref.filePath, context).find((n) =>
      n.startLine === ref.line && n.name === ref.referenceName);
    if (!resource) return null; // Library/Variables imports need separate cross-language semantics.
    const file = resourcePath(resource.name, ref.filePath, context);
    const target = file ? context.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
    return target ? { original: ref, targetNodeId: target.id, confidence: 1, resolvedBy: 'file-path' } : null;
  }
  if (ref.referenceKind !== 'calls' || /[$@&%]\{/.test(ref.referenceName)) return null;

  const files = visibleFiles(ref.filePath, context);
  let matches = matchingKeywords(ref.referenceName, files, context);
  // Robot tries the complete name before treating Given/When/Then/And/But as a prefix.
  if (!matches.length) {
    const withoutPrefix = ref.referenceName.replace(/^(?:given|when|then|and|but)\s+/i, '');
    if (withoutPrefix !== ref.referenceName) matches = matchingKeywords(withoutPrefix, files, context);
  }
  if (matches.length !== 1) return null;
  const target = matches[0]!;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 1,
    resolvedBy: target.filePath === ref.filePath ? 'exact-match' : 'import',
  };
}
