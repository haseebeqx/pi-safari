import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Safari } from '../src/safari.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';
const reply = (v: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const text = (t: string): ToolReply => ({ content: [{ type: 'text', text: t }] });
const readFixture = (url: string) => ({ url, title: 'Example', readyState: 'complete', text: 'Hello body', textTruncated: false, links: [{ index: 0, text: 'Home', href: 'https://example.com/' }], linksTruncated: false });
class FetchBrowser implements Transport {
  epoch = 'test'; url = ''; calls: string[] = []; waits = 0;
  redirect = false; changeOnRead = false; failClose = false; hops: string[] = [];
  async call(name: string, args: Record<string, unknown>) {
    this.calls.push(name);
    if (name === 'create_tab') { this.url = this.redirect ? 'https://other.example/' : (this.hops.length ? this.hops[this.hops.length - 1] : String(args.url)); return reply({ handle: 'new' }); }
    if (name === 'list_tabs') return reply([{ handle: 'new', url: this.url }]);
    if (name === 'browser_dialogs') return reply({ dialogs: [] });
    if (name === 'close_tab') { if (this.failClose) throw Error('close failure'); assert.equal(args.handle, 'new'); return text('Closed.'); }
    if (name === 'switch_tab') return text('OK');
    if (name === 'page_info') return reply({ url: this.hops.length ? this.hops.shift()! : this.url });
    if (name === 'evaluate_javascript') {
      const expr = String(args.expression);
      if (expr.includes('document.body')) { if (this.changeOnRead) this.url = 'https://other.example/'; return reply(JSON.stringify(readFixture(this.url))); }
      if (expr.includes('matched')) { this.waits++; return reply(JSON.stringify({ matched: true, truncated: false })); }
      if (expr.includes('document.readyState')) return reply(expr.includes(JSON.stringify(this.url)));
      return reply(true);
    }
    throw Error('unexpected call');
  }
  close() {}
}
test('fetch performs one self-closing new-tab operation and returns no target', async () => {
  const browser = new FetchBrowser(); const safari = new Safari(browser); // No action permission, including own-tab cleanup.
  const data = await safari.fetch({ url: 'https://example.com/' });
  assert.equal(data.url, 'https://example.com/'); assert.equal(data.title, 'Example'); assert.equal(data.text, 'Hello body');
  assert.equal(data.links.length, 1); assert.equal(data.textTruncated, false); assert.equal(data.linksTruncated, false);
  assert.equal('targetId' in data, false); assert.equal('epoch' in data, false);
  assert.equal(data.cleanup.status, 'closed');
  assert.equal(browser.calls.at(-1), 'close_tab');
  assert.equal(browser.calls.filter(n => n === 'create_tab').length, 1);
  assert.ok(browser.calls.every(n => ['create_tab', 'list_tabs', 'switch_tab', 'browser_dialogs', 'page_info', 'evaluate_javascript', 'close_tab'].includes(n)));
});
test('optional settle wait polls visible presence before extraction', async () => {
  const browser = new FetchBrowser(); const safari = new Safari(browser);
  const data = await safari.fetch({ url: 'https://example.com/', selector: 'article', timeoutMs: 1000 });
  assert.equal(browser.waits, 1); assert.equal(data.cleanup.status, 'closed');
  const data2 = await new Safari(browser).fetch({ url: 'https://example.com/', text: 'Hello' });
  assert.equal(browser.waits, 2); assert.equal(data2.cleanup.status, 'closed');
});
test('fetch follows HTTP redirects and reports the settled final URL', async () => {
  const b = new FetchBrowser(); b.redirect = true; const safari = new Safari(b, () => {});
  const data = await safari.fetch({ url: 'https://example.com/' });
  assert.equal(data.url, 'https://other.example/');
  assert.equal(data.requestedUrl, 'https://example.com/');
  assert.equal(data.title, 'Example'); assert.equal(data.text, 'Hello body');
  assert.deepEqual(data.redirects, ['https://example.com/', 'https://other.example/']);
  assert.equal(data.cleanup.status, 'closed');
  assert.equal(b.calls.filter(n => n === 'create_tab').length, 1);
  assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
});
test('redirects settle on optional selector/text waits before extraction', async () => {
  const b = new FetchBrowser(); b.redirect = true; const safari = new Safari(b, () => {});
  const data = await safari.fetch({ url: 'https://example.com/', selector: 'article', timeoutMs: 1000 });
  assert.equal(b.waits, 1); assert.equal(data.url, 'https://other.example/'); assert.equal(data.cleanup.status, 'closed');
});
test('multi-hop redirects report the observed chain in order', async () => {
  const b = new FetchBrowser(); b.hops = ['https://mid.example/', 'https://final.example/'];
  const data = await new Safari(b, () => {}).fetch({ url: 'https://start.example/' });
  assert.equal(data.url, 'https://final.example/');
  assert.equal(data.requestedUrl, 'https://start.example/');
  assert.deepEqual(data.redirects, ['https://start.example/', 'https://mid.example/', 'https://final.example/']);
  assert.equal(data.cleanup.status, 'closed');
});
test('page changes and non-web redirect targets fail closed and still close the created tab', async () => {
  {
    const b = new FetchBrowser(); b.changeOnRead = true;
    await assert.rejects(new Safari(b, () => {}).fetch({ url: 'https://example.com/' }));
    assert.equal(b.calls.filter(n => n === 'create_tab').length, 1);
    assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
  }
  {
    const b = new FetchBrowser(); const call = b.call.bind(b);
    b.call = async (name, args) => { if (name === 'page_info') { b.calls.push(name); return reply({ url: 'data:text/html,hi' }); } return call(name, args); };
    await assert.rejects(new Safari(b, () => {}).fetch({ url: 'https://example.com/' }), /Only HTTP\(S\)/);
    assert.equal(b.calls.filter(n => n === 'create_tab').length, 1);
    assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
  }
});
test('fetch validates options before transport', () => {
  const b = new FetchBrowser(), s = new Safari(b, () => {});
  for (const options of [{}, { url: 'not a url' }, { url: 'https://u:p@example.com/' }, { url: 'https://example.com/', timeoutMs: -1 }, { url: 'https://example.com/', timeoutMs: 10001 }, { url: 'https://example.com/', timeoutMs: 1.5 }, { url: 'https://example.com/', maxChars: 0 }, { url: 'https://example.com/', maxChars: 12001 }, { url: 'https://example.com/', maxLinks: 41 }, { url: 'https://example.com/', selector: 'x'.repeat(501) }, { url: 'https://example.com/', text: '' }]) assert.throws(() => s.fetch(options as any));
  assert.equal(b.calls.length, 0);
});
test('fetch cleanup failure preserves the primary extraction error', async () => {
  const b = new FetchBrowser(); b.changeOnRead = true; b.failClose = true;
  await assert.rejects(new Safari(b, () => {}).fetch({ url: 'https://example.com/' }), (e: any) => {
    assert.match(e.message, /Page changed during extraction.*Fetch cleanup: failed/); assert.match(e.cause.message, /Page changed during extraction/); return true;
  });
  assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
});
test('unknown create outcome is not retried or closed', async () => {
  const b = new FetchBrowser(), call = b.call.bind(b);
  b.call = async (name, args) => { if (name === 'create_tab') { b.calls.push(name); throw Error('create lost'); } return call(name, args); };
  await assert.rejects(new Safari(b, () => {}).fetch({ url: 'https://example.com/' }), /create lost.*unidentified/);
  assert.deepEqual(b.calls, ['create_tab']);
});
test('cancellation during create cleans the known tab', async () => {
  const b = new FetchBrowser(), c = new AbortController(), call = b.call.bind(b);
  b.call = async (name, args) => { const r = await call(name, args); if (name === 'create_tab') c.abort(); return r; };
  await assert.rejects(new Safari(b, () => {}).fetch({ url: 'https://example.com/' }, c.signal), /cancel/);
  assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
});
test('fetch honors queued cancellation and recovers queue', async () => {
  const b = new FetchBrowser(), s = new Safari(b, () => {}), c = new AbortController();
  const gate = s.serial(async () => new Promise(r => setTimeout(r, 5)));
  const pending = s.fetch({ url: 'https://example.com/' }, c.signal); c.abort();
  await gate; await assert.rejects(pending, /cancelled/); assert.equal(b.calls.length, 0);
  await s.tabs(); assert.equal(b.calls.length, 1);
});
test('permission-free fetch infrastructure does not authorize restricted target actions', async () => {
  const b = new FetchBrowser(), s = new Safari(b);
  await s.fetch({ url: 'https://example.com/' });
  const before = b.calls.length;
  const t = { targetId: 'new', epoch: 'test' };
  await assert.rejects(s.activate(t), /approval/);
  await assert.rejects(s.navigate(t, b.url, 'https://second.example/'), /approval/);
  await assert.rejects(s.interact(t, b.url, { type: 'click', node: '1', purpose: 'unrequested' }), /approval/);
  assert.equal(b.calls.length, before);
});
