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
  assert.equal(store.load('/Users/me/project-a'), DEFAULT_SAFARI_SESSION_STRATEGY);
});
