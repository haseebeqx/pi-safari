import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafariSessionStrategyStore, DEFAULT_SAFARI_SESSION_STRATEGY, normalizeSafariSessionStrategy } from '../src/session-strategy.ts';
import type { SafariSessionStrategy } from '../src/session-strategy.ts';

test('normalizes unknown strategy values to the default', () => {
  assert.equal(normalizeSafariSessionStrategy('per-session'), 'per-session');
  assert.equal(normalizeSafariSessionStrategy('per-project'), 'per-project');
  assert.equal(normalizeSafariSessionStrategy('global'), 'global');
  assert.equal(normalizeSafariSessionStrategy('bogus'), DEFAULT_SAFARI_SESSION_STRATEGY);
  assert.equal(normalizeSafariSessionStrategy(undefined), DEFAULT_SAFARI_SESSION_STRATEGY);
});

test('strategy store persists per project key and clears', () => {
  const store = createSafariSessionStrategyStore();
  const strategy: SafariSessionStrategy = 'per-project';
  assert.equal(store.load('/Users/me/project-a'), DEFAULT_SAFARI_SESSION_STRATEGY);
  store.save('/Users/me/project-a', strategy);
  store.save(undefined, 'global');
  assert.equal(store.load('/Users/me/project-a'), 'per-project');
  assert.equal(store.load(undefined), 'global');
  store.clear('/Users/me/project-a');
  // Clearing a per-project entry falls back to the machine-wide default.
  assert.equal(store.load('/Users/me/project-a'), 'global');
  store.clear(undefined);
  assert.equal(store.load('/Users/me/project-a'), DEFAULT_SAFARI_SESSION_STRATEGY);
});

test('machine-wide global default persists and applies to projects without their own entry', () => {
  const store = createSafariSessionStrategyStore();
  store.save(undefined, 'global');
  assert.equal(store.load('/Users/me/project-a'), 'global');
  store.save('/Users/me/project-a', 'per-project');
  assert.equal(store.load('/Users/me/project-a'), 'per-project');
  store.clear('/Users/me/project-a');
  assert.equal(store.load('/Users/me/project-a'), 'global');
  store.clear(undefined);
  assert.equal(store.load('/Users/me/project-a'), DEFAULT_SAFARI_SESSION_STRATEGY);
});

test('per-project entries do not leak into machine-wide default lookups', () => {
  const store = createSafariSessionStrategyStore();
  store.save('/Users/me/project-a', 'per-project');
  assert.equal(store.load('/Users/me/project-a'), 'per-project');
  assert.equal(store.load('/Users/me/project-b'), DEFAULT_SAFARI_SESSION_STRATEGY);
});
