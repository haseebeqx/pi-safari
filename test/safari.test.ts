import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Safari } from '../src/safari.ts';
import { webURL, readJS, linkJS, bound } from '../src/extraction.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';
const reply = (data: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
class Browser implements Transport {
  epoch = 'session-1';
  calls: { name: string; args: Record<string, unknown> }[] = [];
  tabs = [{ handle: 'page-1', url: 'https://example.com/' }];
  current = 'page-1';
  url = 'https://example.com/';
  result: unknown;
  async call(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    switch (name) {
      case 'list_tabs': return reply(this.tabs);
      case 'switch_tab': this.current = String(args.handle); return { content: [{ type: 'text', text: 'Switched to tab.' }] };
      case 'page_info': return reply({ url: this.url, title: 'Example' });
      case 'create_tab': this.url = String(args.url); this.tabs.push({ handle: 'page-2', url: this.url }); return reply({ handle: 'page-2' });
      case 'evaluate_javascript':
        if (this.result !== undefined) return reply(this.result);
        return reply(vm.runInNewContext(`(()=>{${args.expression}})()`, {
          URL, location: { href: this.url },
          document: { title: 'Example', readyState: 'complete', body: { innerText: 'abcdef' }, querySelectorAll: () => [] },
        }));
      default: throw Error('unexpected tool');
    }
  }
  close() { this.epoch = 'closed'; }
}
const target = { targetId: 'page-1', epoch: 'session-1' };
test('validates URL, selector and bounds before transport calls', async () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com']) assert.throws(() => webURL(url));
  const b = new Browser(), s = new Safari(b, () => {});
  assert.throws(() => s.open('file:///tmp/x'));
  assert.throws(() => s.read(target, 12001, 0));
  assert.throws(() => s.read(target, 1, 41));
  assert.throws(() => s.followLink(target, '', 'https://example.com/'));
  assert.equal(b.calls.length, 0);
  assert.throws(() => bound('😀'.repeat(20000)), /48 KiB/);
});
test('tabs return bounded explicit handles with session epoch', async () => {
  const b = new Browser(); b.tabs = Array.from({ length: 110 }, (_, i) => ({ handle: `page-${i}`, url: 'https://example.com/' }));
  const listed = await new Safari(b, () => {}).tabs();
  assert.equal(listed.tabs.length, 100); assert.equal(listed.truncated, true);
  assert.deepEqual(listed.tabs[0], { targetId: 'page-0', epoch: 'session-1', url: 'https://example.com/' });
});
test('reads fixed JS after explicit selection and preserves truncation', async () => {
  const b = new Browser(); const data = await new Safari(b, () => {}).read(target, 3, 0);
  assert.equal(data.text, 'abc'); assert.equal(data.textTruncated, true);
  assert.deepEqual(b.calls.map(c => c.name), ['list_tabs', 'switch_tab', 'page_info', 'evaluate_javascript', 'page_info', 'list_tabs']);
});
test('rejects malformed, disconnected, missing and reconnected targets', async () => {
  const b = new Browser(), s = new Safari(b, () => {});
  await assert.rejects(s.read({ targetId: 1 } as any), /Invalid/);
  await assert.rejects(s.read({ ...target, epoch: 'old' }), /stale/);
  await assert.rejects(s.read({ ...target, targetId: 'missing' }), /closed/);
  const call = b.call.bind(b);
  b.call = async (name, args) => { b.epoch = 'new-session'; return call(name, args); };
  await assert.rejects(s.read(target), /stale/);
  assert.equal(b.calls.filter(c => c.name === 'switch_tab').length, 0);
});
test('open uses returned handle and rejects redirects without retrying creation', async () => {
  const b = new Browser(); const opened = await new Safari(b, () => {}).open('https://example.com');
  assert.equal(opened.targetId, 'page-2');
  assert.equal(b.calls.filter(c => c.name === 'create_tab').length, 1);
  const redirected = new Browser(), call = redirected.call.bind(redirected);
  redirected.call = async (name, args) => { const r = await call(name, args); if (name === 'create_tab') redirected.url = 'https://other.example/'; return r; };
  await assert.rejects(new Safari(redirected, () => {}).open('https://example.com/'), /Redirect/);
  assert.equal(redirected.calls.filter(c => c.name === 'create_tab').length, 1);
});
test('link following opens only validated extracted URLs and never navigates source', async () => {
  for (const href of ['javascript:alert(1)', 'https://u:p@example.com', undefined]) {
    const b = new Browser(); b.result = JSON.stringify({ href });
    await assert.rejects(new Safari(b, () => {}).followLink(target, 'a', 'https://example.com/'));
    assert.equal(b.calls.filter(c => c.name === 'create_tab').length, 0);
  }
  const b = new Browser(), call = b.call.bind(b);
  b.call = async (name, args) => name === 'evaluate_javascript' && String(args.expression).includes('querySelectorAll') ? reply(JSON.stringify({ href: 'https://destination.example/' })) : call(name, args);
  assert.equal((await new Safari(b, () => {}).followLink(target, 'a', 'https://example.com/')).targetId, 'page-2');
  assert.equal(b.calls.filter(c => c.name === 'create_tab').length, 1);
  assert.equal(b.calls.some(c => ['navigate_to_url', 'page_interactions', 'close_tab'].includes(c.name)), false);
});
test('navigation during observation fails before follow creates a tab', async () => {
  const b = new Browser(), call = b.call.bind(b); b.result = JSON.stringify({ href: 'https://destination.example/' });
  b.call = async (name, args) => { const r = await call(name, args); if (name === 'evaluate_javascript') b.url = 'https://changed.example/'; return r; };
  await assert.rejects(new Safari(b, () => {}).followLink(target, 'a', 'https://example.com/'), /changed/);
  assert.equal(b.calls.some(c => c.name === 'create_tab'), false);
});
test('operations serialize, cancelled queued work does not execute, queue recovers', async () => {
  const b = new Browser(), s = new Safari(b, () => {}), controller = new AbortController();
  const gate = s.serial(async () => new Promise(r => setTimeout(r, 5)));
  const cancelled = s.tabs(controller.signal); controller.abort();
  const next = s.tabs(); await gate; await assert.rejects(cancelled, /cancelled/); await next;
  assert.equal(b.calls.length, 1);
});
test('extraction fixtures enforce visibility, limits, exact URL and no source mutation', () => {
  let mutations = 0;
  const guard = { set() { mutations++; throw Error('mutation'); } };
  const anchor = new Proxy({ href: 'https://destination.example/', innerText: 'Link', matches: () => true, getClientRects: () => [{}], click: () => assert.fail('click') }, guard);
  const context = { URL, location: new Proxy({ href: 'https://example.com/' }, guard), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), document: new Proxy({ title: 't'.repeat(500), readyState: 'complete', body: { innerText: 'abcdef' }, querySelectorAll: () => [anchor, { ...anchor, getClientRects: () => [] }] }, guard) };
  const read = JSON.parse(vm.runInNewContext(readJS(3, 1), context));
  assert.equal(read.text, 'abc'); assert.equal(read.title.length, 300); assert.equal(read.links.length, 1); assert.equal(read.linksTruncated, false);
  assert.throws(() => vm.runInNewContext(linkJS('a', 'https://example.com/'), context), /exactly one/);
  const single = { ...context, document: { ...context.document, querySelectorAll: () => [anchor] } };
  assert.equal(JSON.parse(vm.runInNewContext(linkJS('a', 'https://example.com/'), single)).href, anchor.href);
  assert.throws(() => vm.runInNewContext(linkJS('a', 'https://changed.example/'), single), /URL changed/);
  assert.equal(mutations, 0);
});

test('close uses explicit handle without switching, rejects stale and handles absent target', async () => {
  const b = new Browser(), s = new Safari(b), call = b.call.bind(b);
  b.call = async (name, args) => {
    if (name === 'close_tab') { b.calls.push({ name, args }); return { content: [{ type: 'text', text: 'Closed.' }] }; }
    return call(name, args);
  };
  await assert.rejects(s.closeTab({ ...target, epoch: 'old' }), /stale/);
  assert.equal(b.calls.length, 0);
  assert.equal((await s.closeTab({ ...target, targetId: 'missing' })).status, 'already-absent');
  assert.equal((await s.closeTab(target)).status, 'closed');
  assert.deepEqual(b.calls.at(-1), { name: 'close_tab', args: { handle: 'page-1' } });
  assert.equal(b.calls.some(c => c.name === 'switch_tab'), false);
  await assert.rejects(s.closeTab(target, AbortSignal.abort()), /cancelled/);
});


test('new-tab reading is permission-free without enabling arbitrary tab mutations', async () => {
  const b = new Browser(), s = new Safari(b);
  await s.open('https://example.com/');
  const before = b.calls.length;
  await assert.rejects(s.activate(target), /approval/);
  assert.equal(b.calls.length, before);
});
