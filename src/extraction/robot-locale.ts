/** Source-declared language aliases from Robot Framework's static language tables. */
import tables from './robot-languages.json';
import { normalizeRobotName } from './languages/robot';

interface LanguageTable { headers: Record<string, string>; settings: Record<string, string>; prefixes: string[] }
const languages: Record<string, LanguageTable> = tables.languages;

export function robotLocale(source: string): { header(name: string): string; setting(name: string): string; prefixes: string[] } {
  const selected = new Set(['en']);
  const preamble = source.split(/^\s*\*{3}/m)[0] ?? '';
  for (const match of preamble.matchAll(/^\s*language\s*:\s*(.*)$/gim)) {
    for (const code of match[1]!.split(',')) selected.add(code.trim().toLowerCase());
  }
  const headers = new Map<string, string>(), settings = new Map<string, string>(), prefixes = new Set<string>();
  for (const code of selected) {
    const table = languages[code]; if (!table) continue;
    for (const [local, canonical] of Object.entries(table.headers)) headers.set(normalizeRobotName(local), normalizeRobotName(canonical));
    for (const [local, canonical] of Object.entries(table.settings)) settings.set(normalizeRobotName(local), normalizeRobotName(canonical));
    for (const prefix of table.prefixes) prefixes.add(prefix);
  }
  return {
    header: name => headers.get(normalizeRobotName(name)) ?? normalizeRobotName(name),
    setting: name => settings.get(normalizeRobotName(name)) ?? normalizeRobotName(name),
    prefixes: [...prefixes].sort((a, b) => b.length - a.length),
  };
}
