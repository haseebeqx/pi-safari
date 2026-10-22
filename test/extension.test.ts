import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';
import { ACTION_SCOPES, SessionApproval } from '../src/permissions.ts';
import { Safari } from '../src/safari.ts';
import { createSafariSessionStrategyStore, getDefaultSafariSessionStrategyStore, setDefaultSafariSessionStrategyStore } from '../src/session-strategy.ts';

const context = (mode = 'tui') => ({ mode, hasUI: mode === 'tui', ui: { confirm: async () => { assert.fail('no automatic prompt'); }, notify() {} } }) as any;
const input = (a: SessionApproval, text: string, source: 'interactive' | 'extension' | 'rpc' = 'interactive', streamingBehavior?: 'steer' | 'followUp') => a.input({ text, source, streamingBehavior }, context());
function setup() {
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any>(), flags = new Map<string, any>();
  setDefaultSafariSessionStrategyStore(createSafariSessionStrategyStore());
  extension({
    registerTool(t: any) { tools.set(t.name, t); },
    registerCommand(n: string, c: any) { commands.set(n, c); },
    registerFlag(name: string, options: any) { flags.set(name, options); },
    getFlag(name: string) { return flags.has(name) ? flags.get(name) : undefined; },
    on(n: string, h: any) { events.set(n, h); },
  } as unknown as ExtensionAPI);
  return { tools, commands, events };
}

test('registration and lifecycle; mutations fail closed without launching Safari', async () => {
  const { tools, commands, events } = setup();
  assert.equal(tools.size, 21);
  assert.deepEqual(Object.keys(tools.get('safari_wait_for_navigation').parameters.properties), ['targetId', 'epoch', 'expectedUrl', 'timeoutMs']);
  assert.equal(tools.has('safari_request_scope'), false);
  assert.equal(tools.get('safari_read').parameters.properties.maxChars.maximum, 12000);
  const searchParams = tools.get('safari_search').parameters.properties;
  assert.deepEqual(Object.keys(searchParams), ['query', 'url', 'region', 'time', 'selectors']);
  assert.deepEqual(Object.keys(searchParams.selectors.properties), ['item', 'link', 'title', 'snippet']);
  assert.deepEqual(searchParams.selectors.required, ['item']);
  assert.equal(searchParams.url.type, 'string');
  assert.equal(searchParams.url.maxLength, 8192);
  assert.equal(tools.get('safari_fetch').parameters.properties.maxChars.maximum, 12000);
  assert.equal(tools.get('safari_fetch').parameters.properties.timeoutMs.maximum, 10000);
  assert.deepEqual(Object.keys(tools.get('safari_snapshot').parameters.properties), ['targetId', 'epoch', 'entirePage', 'media']);
  assert.match(tools.get('safari_snapshot').description ?? '', /print/);
  const execute = () => tools.get('safari_activate').execute('id', {}, undefined, undefined, context());
  await assert.rejects(execute(), /disabled/);
  const command = commands.get('safari-permissions').handler;
  for (const event of ['session_before_switch', 'session_before_fork', 'session_start', 'session_shutdown']) {
    await command('allow', context()); await events.get(event)(); await assert.rejects(execute(), /disabled/);
  }
  // Input is the only implicit origin, not before_agent_start/model/session content.
  assert.equal(events.has('before_agent_start'), false);
  await events.get('input')({ text: 'close this tab', source: 'interactive' }, context());
  await assert.rejects(execute(), /disabled/);
  await events.get('agent_end')();
  await assert.rejects(execute(), /disabled/);
});

test('safari-session command persists strategy per project and resets', async () => {
  const { commands, events } = setup();
  const store = getDefaultSafariSessionStrategyStore();
  const ctx = context();
  assert.equal(store.load(undefined), 'per-session');
  await commands.get('safari-session').handler('per-project', ctx);
  assert.equal(store.load(undefined), 'per-project');
  await commands.get('safari-session').handler('global', ctx);
  assert.equal(store.load(undefined), 'global');
  await commands.get('safari-session').handler('reset', ctx);
  assert.equal(store.load(undefined), 'per-session');
  await assert.rejects(commands.get('safari-session').handler('/other', ctx), /Usage/);
});

test('safari-session global persists a machine-wide default strategy', async () => {
  const { commands } = setup();
  const store = getDefaultSafariSessionStrategyStore();
  const projectCtx = context(); (projectCtx as any).cwd = '/Users/me/project-b';
  assert.equal(store.load('/Users/me/project-b'), 'per-session');
  await commands.get('safari-session').handler('global', projectCtx);
  assert.equal(store.load('/Users/me/project-b'), 'global');
  assert.equal(store.load('/Users/me/project-c'), 'global');
  await commands.get('safari-session').handler('per-project', projectCtx);
  assert.equal(store.load('/Users/me/project-b'), 'per-project');
  await commands.get('safari-session').handler('reset', projectCtx);
  assert.equal(store.load('/Users/me/project-b'), 'per-session');
});

test('session_start applies the resolved strategy and tears down unless global', async () => {
  const { events } = setup();
  const ctx = context();
  await events.get('session_start')({ type: 'session_start', reason: 'startup' } as any, ctx);
  await events.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' } as any);
});

test('safari_evaluate is a standalone tier: no task approval or /safari-permissions grant', async () => {
  const { tools, commands, events } = setup();
  const evalTool = tools.get('safari_evaluate');
  assert.deepEqual(Object.keys(evalTool.parameters.properties), ['targetId', 'epoch', 'expectedUrl', 'expression']);
  assert.equal(evalTool.parameters.properties.expression.maxLength, 8000);
  const ctx = context();
  const run = (c = ctx) => evalTool.execute('id', { targetId: 'page-1', epoch: 'one', expectedUrl: 'https://example.com/', expression: '1+1' }, undefined, undefined, c);
  await assert.rejects(run(), /standalone/);
  // The full restricted-action grant does not imply JavaScript evaluation.
  await commands.get('safari-permissions').handler('allow', ctx);
  await assert.rejects(run(), /standalone/);
  await assert.rejects(commands.get('safari-evaluate').handler('/other', ctx), /Usage/);
  await assert.rejects(commands.get('safari-evaluate').handler('allow', context('print')), /noninteractive/);
  const original = Safari.prototype.evaluate;
  Safari.prototype.evaluate = (async () => ({ observed: 'eval' })) as any;
  try {
    await commands.get('safari-evaluate').handler('allow', ctx);
    assert.match(JSON.stringify(await run()), /observed/);
    // Even after a grant, noninteractive contexts stay blocked.
    for (const c of [context('print'), context('json'), context('rpc')]) await assert.rejects(run(c), /noninteractive/);
    // The evaluation grant implies no restricted-action permission.
    const fresh = setup();
    await fresh.commands.get('safari-evaluate').handler('allow', ctx);
    await assert.rejects(fresh.tools.get('safari_activate').execute('id', {}, undefined, undefined, ctx), /disabled/);
    // Revoke clears it, and session lifecycle events reset a fresh grant.
    await commands.get('safari-evaluate').handler('revoke', ctx);
    await assert.rejects(run(), /standalone/);
    for (const event of ['session_start', 'session_before_switch', 'session_before_fork', 'session_shutdown']) {
      await commands.get('safari-evaluate').handler('allow', ctx);
      await events.get(event)();
      await assert.rejects(run(), /standalone/);
    }
  } finally { Safari.prototype.evaluate = original; }
});

test('basic browsing wrappers do not ask permission, even in noninteractive mode', async () => {
  const { tools } = setup();
  // Stub service boundary, not authorization. No browser/process is started.
  const methods = { safari_open: 'open', safari_search: 'search', safari_fetch: 'fetch', safari_follow_link: 'followLink', safari_read: 'read', safari_tabs: 'tabs', safari_close: 'closeTab', safari_dialog: 'dialog', safari_wait_for_navigation: 'waitNavigation' } as const;
  for (const [tool, method] of Object.entries(methods)) {
    const original = Safari.prototype[method];
    (Safari.prototype as any)[method] = async () => ({ observed: true });
    try { assert.match(JSON.stringify(await tools.get(tool).execute('id', {}, undefined, undefined, context('print'))), /observed/); }
    finally { (Safari.prototype as any)[method] = original; }
  }
});

test('only dedicated command grants full session access, with no confirm dialog', async () => {
  const a = new SessionApproval(), ctx = context();
  await assert.rejects(a.command('/other', ctx), /Usage/);
  await a.command('allow', ctx);
  input(a, 'Read this page');
  for (const scope of ACTION_SCOPES) await a.run(ctx, scope, async () => a.require());
  a.endRequest(); await a.run(ctx, 'activate', async () => a.require());
  await a.command('revoke', ctx); await assert.rejects(a.run(ctx, 'activate', async () => assert.fail('revoked')), /disabled/);
  assert.throws(() => a.require(), /disabled/);
});

test('new input and end-of-request expire implicit grants', async () => {
  const a = new SessionApproval();
  input(a, 'Click the login button'); input(a, 'Read the page');
  await assert.rejects(a.run(context(), 'click', async () => assert.fail('stale')), /disabled/);
  input(a, 'Click the login button'); a.endRequest();
  await assert.rejects(a.run(context(), 'click', async () => assert.fail('stale')), /disabled/);
});

test('noninteractive and cancelled mutation calls fail closed, even after full grant', async () => {
  const a = new SessionApproval();
  for (const approved of [false, true]) {
    if (approved) await a.command('allow', context());
    for (const ctx of [context('rpc'), context('json'), context('print'), { ...context(), hasUI: false }, undefined]) {
      await assert.rejects(a.run(ctx, 'click', async () => assert.fail('dispatched')), /noninteractive/);
      await assert.rejects(a.command('allow', ctx), /noninteractive/);
    }
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(a.run(context(), 'click', async () => assert.fail('cancelled'), controller.signal), /cancelled/);
});

test('revoke and regrant cannot revive queued or in-flight operation scopes', async () => {
  const a = new SessionApproval(), ctx = context(); await a.command('allow', ctx);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const blocked = new Promise<void>(r => { release = r; });
  const old = a.run(ctx, 'click', async () => { a.require(); started(); await blocked; a.require(); assert.fail('revived'); });
  await ready; await a.command('revoke', ctx); await a.command('allow', ctx);
  release(); await assert.rejects(old, /disabled/);
  await a.run(ctx, 'click', async () => a.require());
});

test('real Safari queue retains each operation generation across regrant', async () => {
  const approval = new SessionApproval(), ctx = context();
  const safari = new Safari({ epoch: 'one', close() {}, async call() { assert.fail('stale operation reached transport'); } }, () => approval.require());
  await approval.command('allow', ctx);
  let release!: () => void, enqueued!: () => void;
  const ready = new Promise<void>(r => { enqueued = r; });
  const blocker = safari.serial(() => new Promise<void>(r => { release = r; }));
  const pending = approval.run(ctx, 'activate', () => { const operation = safari.activate({ targetId: 'page-1', epoch: 'one' }); enqueued(); return operation; });
  await ready; await approval.command('revoke', ctx); await approval.command('allow', ctx);
  release(); await blocker; await assert.rejects(pending, /disabled/);
});

test('close and scroll wrappers bypass permission without task/grant; other actions stay blocked', async () => {
  const { tools } = setup();
  assert.deepEqual(ACTION_SCOPES, ['activate', 'navigate', 'click', 'type', 'keyPress', 'hover', 'upload']);
  const originalClose = Safari.prototype.closeTab, originalInteract = Safari.prototype.interact;
  let closes = 0, scrolls = 0;
  Safari.prototype.closeTab = async () => { closes++; return { status: 'closed' }; };
  Safari.prototype.interact = async (_target, _url, action) => {
    assert.equal(action.type, 'scroll'); scrolls++;
    return { targetId: 'page-1', epoch: 'one', url: 'https://example.com/', note: 'mock' };
  };
  try {
    for (const ctx of [context(), context('print'), context('json'), context('rpc')]) {
      await tools.get('safari_close').execute('id', {}, undefined, undefined, ctx);
      await tools.get('safari_interact').execute('id', { action: { type: 'scroll' } }, undefined, undefined, ctx);
      for (const type of ['click', 'type', 'keyPress', 'hover']) {
        await assert.rejects(tools.get('safari_interact').execute('id', { targetId: 'page-1', epoch: 'one', expectedUrl: 'https://example.com/', action: { type } }, undefined, undefined, ctx), /disabled/);
      }
      for (const name of ['safari_activate', 'safari_navigate']) {
        await assert.rejects(tools.get(name).execute('id', {}, undefined, undefined, ctx), /disabled/);
      }
      await assert.rejects(tools.get('safari_upload').execute('id', { targetId: 'page-1', epoch: 'one', expectedUrl: 'https://example.com/', selector: 'input#f', purpose: 'Upload file', files: ['/tmp/f.txt'] }, undefined, undefined, ctx), /disabled/);
    }
    assert.equal(closes, 4); assert.equal(scrolls, 4);
  } finally { Safari.prototype.closeTab = originalClose; Safari.prototype.interact = originalInteract; }
});
