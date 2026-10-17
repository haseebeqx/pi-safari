import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';
import { ACTION_SCOPES, SessionApproval } from '../src/permissions.ts';
import { Safari } from '../src/safari.ts';

const context = (mode = 'tui') => ({ mode, hasUI: mode === 'tui', ui: { confirm: async () => { assert.fail('no automatic prompt'); }, notify() {} } }) as any;
const input = (a: SessionApproval, text: string, source: 'interactive' | 'extension' | 'rpc' = 'interactive', streamingBehavior?: 'steer' | 'followUp') => a.input({ text, source, streamingBehavior }, context());
function setup() {
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any>();
  extension({ registerTool(t: any) { tools.set(t.name, t); }, registerCommand(n: string, c: any) { commands.set(n, c); }, on(n: string, h: any) { events.set(n, h); } } as unknown as ExtensionAPI);
  return { tools, commands, events };
}

test('registration and lifecycle; mutations fail closed without launching Safari', async () => {
  const { tools, commands, events } = setup();
  assert.equal(tools.size, 18);
  assert.equal(tools.has('safari_request_scope'), false);
  assert.equal(tools.get('safari_read').parameters.properties.maxChars.maximum, 12000);
  assert.equal(tools.get('safari_search').parameters.properties.maxResults.maximum, 10);
  assert.equal(tools.get('safari_fetch').parameters.properties.maxChars.maximum, 12000);
  assert.equal(tools.get('safari_fetch').parameters.properties.timeoutMs.maximum, 10000);
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

test('basic browsing wrappers do not ask permission, even in noninteractive mode', async () => {
  const { tools } = setup();
  // Stub service boundary, not authorization. No browser/process is started.
  const methods = { safari_open: 'open', safari_search: 'search', safari_fetch: 'fetch', safari_follow_link: 'followLink', safari_read: 'read', safari_tabs: 'tabs', safari_close: 'closeTab' } as const;
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
