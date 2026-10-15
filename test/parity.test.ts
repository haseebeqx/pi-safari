import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Safari, validateInteraction } from '../src/safari.ts';
import { queryJS, waitJS } from '../src/inspection.ts';
import { SessionApproval } from '../src/permissions.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';

const t = { targetId: 'page-1', epoch: 'one' }, url = 'https://example.com/';
const json = (data: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
class Backend implements Transport {
  epoch = 'one'; url = url; calls: { name: string; args: Record<string, unknown> }[] = [];
  result = JSON.stringify({ matches: [], truncated: false }); fail?: string;
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolReply> {
    if (signal?.aborted) throw Error('cancelled');
    this.calls.push({ name, args });
    if (name === this.fail) throw Error('backend failed');
    if (name === 'list_tabs') return json([{ handle: 'page-1', url: this.url }]);
    if (name === 'page_info') return json({ url: this.url });
    if (name === 'evaluate_javascript') return json(this.result);
    if (name === 'navigate_to_url') this.url = String(args.url);
    return { content: [{ type: 'text', text: 'native-output' }] };
  }
  close() { this.epoch = 'retired'; }
}

test('native observations select explicit target and use verified non-draining parameters', async () => {
  const b = new Backend(), s = new Safari(b);
  for (const [run, name, args] of [
    [() => s.snapshot(t, true), 'get_page_content', { format: 'textTree', region: 'entire_page', nodeIds: 'interactive', includeAccessibilityAttributes: true, includeURLs: true, includeSubframes: false, includeRects: true, maxWordsPerParagraph: 30 }],
    [() => s.screenshot(t, true), 'screenshot', { full_page: true }],
    [() => s.console(t, 5), 'browser_console_messages', { tab_handle: t.targetId, clear: false, limit: 5 }],
    [() => s.network(t, 'example'), 'list_network_requests', { tab_handle: t.targetId, clear: false, filter: { url_substring: 'example' } }],
  ] as const) {
    b.calls = []; const result = await run();
    assert.equal(result.text, 'native-output'); assert.equal(result.url, url);
    assert.deepEqual(b.calls.map(c => c.name), ['list_tabs','switch_tab','page_info',name,'page_info','list_tabs']);
    assert.deepEqual(b.calls[3].args, args);
  }
  await assert.rejects(s.snapshot({ ...t, epoch: 'old' }), /stale/);
});

test('native observations detect URL drift and reconnect, truncate output and serialize', async () => {
  const b = new Backend(), s = new Safari(b), original = b.call.bind(b);
  b.call = async (name, args, signal) => {
    const reply = await original(name, args, signal);
    if (name === 'screenshot') b.url = 'https://changed.example/';
    return reply;
  };
  await assert.rejects(s.screenshot(t), /changed/);
  b.url = url;
  b.call = async (name, args, signal) => name === 'get_page_content' ? { content: [{ type: 'text', text: 'x'.repeat(15000) }] } : original(name, args, signal);
  const result = await s.snapshot(t); assert.equal(result.text.length, 12000); assert.equal(result.truncated, true);
  b.call = original; b.calls = [];
  await Promise.all([s.snapshot(t), s.console(t)]);
  assert.equal(b.calls[6].name, 'list_tabs');
  b.call = async (name, args, signal) => { const r = await original(name, args, signal); if (name === 'screenshot') b.epoch = 'new'; return r; };
  await assert.rejects(s.screenshot(t), /stale/);
});

test('non-browsing mutating class entry points require authorization and queued approval is rechecked', async () => {
  const b = new Backend(), s = new Safari(b);
  for (const run of [() => s.activate(t), () => s.navigate(t, url, url), () => s.interact(t, url, { type: 'click', node: '42', purpose: 'test' })]) await assert.rejects(run(), /approval/);
  assert.equal(b.calls.length, 0);
  let allowed = true;
  const guarded = new Safari(b, () => { if (!allowed) throw Error('revoked'); });
  const gate = guarded.serial(async () => { allowed = false; });
  const queued = guarded.navigate(t, url, 'https://next.example/');
  await gate; await assert.rejects(queued, /revoked/); assert.equal(b.calls.length, 0);
});

test('navigation and interactions check source URL, send exactly once and never replay failures', async () => {
  const b = new Backend(), s = new Safari(b, () => {});
  await assert.rejects(s.navigate(t, 'https://wrong.example/', url), /Source URL/);
  assert.equal(b.calls.some(c => c.name === 'navigate_to_url'), false);
  assert.equal((await s.navigate(t, url, 'https://next.example/')).url, 'https://next.example/');
  assert.deepEqual(b.calls.find(c => c.name === 'navigate_to_url')?.args, { tab_uuid: t.targetId, url: 'https://next.example/' });
  b.url = url; b.fail = 'page_interactions';
  await assert.rejects(s.interact(t, url, { type: 'type', node: '42', purpose: 'Fill name', value: 'hello', replaceAll: true }), /backend failed/);
  assert.equal(b.calls.filter(c => c.name === 'page_interactions').length, 1);
  b.fail = undefined;
  await s.interact(t, url, { type: 'scroll', purpose: 'View below', scrollDelta: { x: 0, y: 500 } });
  assert.deepEqual([...b.calls].reverse().find(c => c.name === 'page_interactions')?.args, { interactions: [{ type: 'scroll', purpose: 'View below', scrollDelta: { x: 0, y: 500 } }] });
  const original = b.call.bind(b);
  b.call = async (name, args, signal) => { const r = await original(name, args, signal); if (name === 'navigate_to_url') b.url = 'https://redirect.example/'; return r; };
  await assert.rejects(s.navigate(t, url, 'https://next.example/'), /redirected/);
  assert.equal(b.calls.filter(c => c.name === 'navigate_to_url').length, 2);
});

test('interaction and query input validation rejects unsupported or unbounded actions', () => {
  for (const a of [
    { type: 'click', purpose: 'x' }, { type: 'click', purpose: 'x', node: '$uid(42)' },
    { type: 'type', purpose: 'x', node: '1' }, { type: 'scroll', purpose: 'x', scrollDelta: { x: Infinity, y: 0 } },
    { type: 'hover', purpose: 'x', node: '1', replaceAll: true }, { type: 'keyPress', purpose: 'x', value: '' },
    { type: 'click', purpose: 'x', node: '1', injected: 'x' },
  ]) assert.throws(() => validateInteraction(a as any));
  for (const query of [{}, { selector: '' }, { text: 'x'.repeat(301) }, { selector: 'a', limit: 51 }]) assert.throws(() => queryJS(query));
  assert.throws(() => waitJS({ selector: 'a' }, 'file:///tmp/x'));
});

const element = (name: string, visible = true) => ({
  tagName: 'BUTTON', id: 'submit', innerText: name, disabled: false, checked: false,
  getAttribute: (k: string) => k === 'role' ? 'button' : null,
  getClientRects: () => visible ? [{}] : [], getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
});
function fixture(elements: any[], href = url) {
  return { location: { href }, document: { querySelectorAll: () => elements }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
}
test('actual fixed query and wait scripts enforce visibility, ambiguity, scan limits and injection quoting', () => {
  const context = fixture([element('Save'), element('Hidden', false)]);
  const data = JSON.parse(vm.runInNewContext(queryJS({ selector: 'button', text: 'save' }), context));
  assert.equal(data.matches.length, 1); assert.equal(data.matches[0].role, 'button'); assert.equal(data.matches[0].rect.width, 3);
  assert.equal('value' in data.matches[0], false);
  assert.equal(JSON.parse(vm.runInNewContext(queryJS({ selector: 'button' }, true), context)).matches.length, 1);
  assert.throws(() => vm.runInNewContext(queryJS({ selector: 'button' }, true), fixture([element('a'), element('b')])), /exactly one/);
  const truncated = JSON.parse(vm.runInNewContext(queryJS({ text: 'notfound' }), fixture(Array.from({ length: 2100 }, () => element('x')))));
  assert.equal(truncated.scanned, 2000); assert.equal(truncated.truncated, true);
  assert.equal(JSON.parse(vm.runInNewContext(waitJS({ text: 'save' }, url), context)).matched, true);
  assert.throws(() => vm.runInNewContext(waitJS({ text: 'save' }, url), fixture([], 'https://wrong.example/')), /URL changed/);
  assert.equal(JSON.parse(vm.runInNewContext(queryJS({ text: '\");throw Error("injected")//' }), context)).matches.length, 0);
});

test('wait polls until visible match, times out at zero and cancels without mutation', async () => {
  const b = new Backend(), s = new Safari(b);
  b.result = JSON.stringify({ matched: false, truncated: false });
  await assert.rejects(s.wait(t, url, { text: 'x' }, 0), /timed out/);
  const ac = new AbortController();
  const wait = s.wait(t, url, { selector: 'button' }, 10000, ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(wait, /cancelled/);
  b.result = JSON.stringify({ matched: true, truncated: false });
  assert.equal((await s.wait(t, url, { text: 'x' }, 0)).matched, true);
  assert.equal(b.calls.some(c => ['navigate_to_url','page_interactions','create_tab'].includes(c.name)), false);
});

test('session retirement cancels queued operations even if a new session approves', async () => {
  const b = new Backend(), s = new Safari(b, () => {});
  const gate = s.serial(async () => { s.close(); });
  const queued = s.open(url);
  await gate;
  await assert.rejects(queued, /session changed/);
  assert.equal(b.calls.length, 0);
});

test('permission-free close/scroll retain bounds, target, URL, cancellation and queue checks', async () => {
  const approval = new SessionApproval(); // No trusted task or session grant.
  const b = new Backend(), s = new Safari(b, () => approval.require());
  const action = { type: 'scroll' as const, purpose: 'Read below', scrollDelta: { x: 0, y: 500 } };
  await s.closeTab(t);
  await s.interact(t, url, action);
  assert.equal(b.calls.filter(c => c.name === 'close_tab').length, 1);
  assert.equal(b.calls.filter(c => c.name === 'page_interactions').length, 1);
  b.calls = [];
  await assert.rejects(s.closeTab({ ...t, epoch: 'old' }), /stale/);
  await assert.rejects(s.interact({ ...t, epoch: 'old' }, url, action), /stale/);
  assert.equal(b.calls.length, 0);
  await assert.rejects(s.interact(t, 'https://wrong.example/', action), /Source URL/);
  assert.throws(() => s.interact(t, url, { ...action, scrollDelta: { x: 0, y: 10001 } }), /delta/);
  assert.throws(() => s.interact(t, url, { ...action, scrollDelta: undefined }), /scrollDelta/);
  await assert.rejects(s.closeTab(t, AbortSignal.abort()), /cancelled/);
  await assert.rejects(s.interact(t, url, action, AbortSignal.abort()), /cancelled/);
  assert.equal(b.calls.some(c => ['close_tab', 'page_interactions'].includes(c.name)), false);
  b.calls = [];
  const gate = s.serial(async () => { s.close(); });
  const close = s.closeTab(t), scroll = s.interact(t, url, action);
  await gate;
  await assert.rejects(close, /session changed/);
  await assert.rejects(scroll, /session changed/);
  assert.equal(b.calls.length, 0);
});
