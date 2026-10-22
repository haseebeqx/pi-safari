import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SAFARI_SESSION_STRATEGIES = ['per-session', 'per-project', 'global'] as const;
export type SafariSessionStrategy = (typeof SAFARI_SESSION_STRATEGIES)[number];
export const DEFAULT_SAFARI_SESSION_STRATEGY: SafariSessionStrategy = 'per-session';
const FALLBACK_PROJECT_KEY = 'default';

export function normalizeSafariSessionStrategy(value: unknown): SafariSessionStrategy {
  return SAFARI_SESSION_STRATEGIES.includes(value as SafariSessionStrategy) ? (value as SafariSessionStrategy) : DEFAULT_SAFARI_SESSION_STRATEGY;
}

export interface SafariSessionStrategyStore {
  load(cwd: string | undefined): SafariSessionStrategy;
  save(cwd: string | undefined, strategy: SafariSessionStrategy): void;
  clear(cwd: string | undefined): void;
}

export function createSafariSessionStrategyStore(filePath?: string): SafariSessionStrategyStore {
  const file = filePath;
  const memory = new Map<string, SafariSessionStrategy>();
  const readMap = (): Record<string, SafariSessionStrategy> => {
    if (file !== undefined) {
      try {
        if (!existsSync(file)) return {};
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const map: Record<string, SafariSessionStrategy> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) map[key] = normalizeSafariSessionStrategy(value);
        return map;
      } catch { return {}; }
    }
    const map: Record<string, SafariSessionStrategy> = {};
    for (const [key, value] of memory) map[key] = value;
    return map;
  };
  const writeMap = (map: Record<string, SafariSessionStrategy>) => {
    if (file === undefined) {
      for (const key of Array.from(memory.keys())) if (!(key in map)) memory.delete(key);
      for (const [key, value] of Object.entries(map)) memory.set(key, value);
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
  };
  const keyOf = (cwd: string | undefined) => (cwd && cwd.trim().length > 0 ? cwd.trim() : FALLBACK_PROJECT_KEY);
  return {
    load(cwd) {
      const key = keyOf(cwd);
      const stored = readMap()[key];
      const strategy = normalizeSafariSessionStrategy(stored);
      if (stored !== undefined) memory.set(key, strategy);
      return strategy;
    },
    save(cwd, strategy) { const key = keyOf(cwd); const map = readMap(); map[key] = strategy; writeMap(map); },
    clear(cwd) { const key = keyOf(cwd); const map = readMap(); delete map[key]; writeMap(map); },
  };
}

let defaultStore: SafariSessionStrategyStore = createSafariSessionStrategyStore();
export function getDefaultSafariSessionStrategyStore(): SafariSessionStrategyStore { return defaultStore; }
export function setDefaultSafariSessionStrategyStore(store: SafariSessionStrategyStore): void { defaultStore = store; }
export function getDefaultSafariSessionStrategyStorePath(): string { return join(homedir(), '.pi', 'agent', 'safari-session-strategies.json'); }
