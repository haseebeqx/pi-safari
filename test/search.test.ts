import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchRequest, searchJS, validateSearch } from '../src/search.ts';
import { Safari } from '../src/safari.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';
const reply = (v: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const request = searchRequest({ query: 'a & b "quoted"', region: 'uk-en', time: 'w', maxResults: 2 });
const visible = { getClientRects: () => [{}] };
function row(url: string, title = 'Example', snippet = 'A useful snippet', hidden = false, ad = false) {
  const anchor = { ...visible, href: url, innerText: title };
  return { getClientRects: () => hidden ? [] : [{}], matches: () => ad, querySelector: (selector: string) => selector === 'a.result__a[href]' ? anchor : { ...visible, innerText: snippet } };
}
function extract(rows: ReturnType<typeof row>[], limit = 2, url = request.url) {
  return JSON.parse(vm.runInNewContext(searchJS(request.url, limit), {
    URL, location: Object.freeze({ href: url }), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: Object.freeze({ querySelectorAll: (selector: string) => { assert.equal(selector, '.result'); return rows; } }),
  }));
}
test('deterministic provider URL construction and strict controls', () => {
  assert.equal(request.url, 'https://html.duckduckgo.com/html/?q=a+%26+b+%22quoted%22&kl=uk-en&df=w');
  assert.equal(searchRequest({ query: ' hello ' }).url, 'https://html.duckduckgo.com/html/?q=hello&kl=wt-wt');
  for (const options of [{ query: '' }, { query: ' ' }, { query: 'x'.repeat(501) }, { query: 'x\n' }, { query: 'x', maxResults: 0 }, { query: 'x', maxResults: 11 }, { query: 'x', maxResults: 1.5 }, { query: 'x', region: 'bogus' }, { query: 'x', time: 'century' }]) assert.throws(() => searchRequest(options));
});
test('fixed DOM extraction ranks unique results, unwraps DDG links, skips unsafe/malformed/hidden/ads', () => {
  const data = extract([
    row('javascript:alert(1)'), row('https://user:pass@example.com/'), row('https://duckduckgo.com/l/?uddg=not-a-url'),
    row('https://html.duckduckgo.com/html/?q=other'), row('https://example.com/hidden', 'Hidden', '', true), row('https://example.com/ad', 'Ad', '', false, true),
    row('https://example.com/empty', '  '), row('https://example.com/' + 'x'.repeat(2048)),
    row('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F', '  First   result  ', '  Some\n snippet '),
    row('https://example.com/', 'Duplicate'), row('https://second.example/', 'x'.repeat(400), 's'.repeat(700)), row('https://third.example/'),
  ]);
  assert.equal(data.truncated, true); assert.equal(data.results.length, 2);
  assert.deepEqual(data.results[0], { rank: 1, title: 'First result', url: 'https://example.com/', snippet: 'Some snippet' });
  assert.equal(data.results[1].rank, 2); assert.equal(data.results[1].title.length, 300); assert.equal(data.results[1].snippet.length, 600);
  assert.deepEqual(validateSearch(data, request.url, 2), { results: data.results, truncated: true });
  assert.throws(() => extract([], 2, 'https://changed.example/'), /URL changed/);
});
test('bounded scanning and empty/challenge pages are explicit, not fabricated results', () => {
  assert.deepEqual(extract([]), { url: request.url, results: [], truncated: false });
  const rows = Array.from({ length: 100 }, () => row('javascript:bad'));
  assert.deepEqual(extract([...rows, row('https://valid.example/')]), { url: request.url, results: [], truncated: true });
});
test('host validation rejects malformed extraction replies, unsafe URLs and excess results', () => {
  const valid = extract([row('https://example.com/')]);
  for (const data of [null, {}, { ...valid, url: 'https://other.example/' }, { ...valid, truncated: 'no' }, { ...valid, results: [...valid.results, ...valid.results] }]) assert.throws(() => validateSearch(data, request.url, 1));
  for (const patch of [{ url: 'javascript:alert(1)' }, { url: 'https://u:p@example.com/' }, { rank: 9 }, { title: '' }, { title: 'x'.repeat(301) }, { snippet: null }, { snippet: 'x'.repeat(601) }, { url: 'https://example.com/' + 'x'.repeat(2048) }]) assert.throws(() => validateSearch({ ...valid, results: [{ ...valid.results[0], ...patch }] }, request.url, 2));
});
class SearchBrowser implements Transport {
  epoch = 'test'; url = ''; calls: string[] = []; redirect = false; changed = false; malformed = false;
  async call(name: string, args: Record<string, unknown>) {
    this.calls.push(name);
    if (name === 'create_tab') { this.url = this.redirect ? 'https://other.example/' : String(args.url); return reply({ handle: 'new' }); }
    if (name === 'list_tabs') return reply([{ handle: 'new', url: this.url }]);
    if (name === 'browser_dialogs') return reply({ dialogs: [] });
    if (name === 'close_tab') { assert.equal(args.handle, 'new'); return { content: [{ type: 'text' as const, text: 'Closed.' }] }; }
    if (name === 'switch_tab') return { content: [{ type: 'text' as const, text: 'OK' }] };
    if (name === 'page_info') return reply({ url: this.url });
    if (name === 'evaluate_javascript') {
      if (!String(args.expression).includes('querySelectorAll')) return reply(true);
      const data = extract([row('https://example.com/')], 2, this.url);
      if (this.changed) this.url = 'https://other.example/';
      return reply(JSON.stringify(this.malformed ? {} : data));
    }
    throw Error('unexpected call');
  }
  close() {}
}
test('search performs one new-tab operation and preserves fail-closed identity/no-replay', async () => {
  const browser = new SearchBrowser(); const safari = new Safari(browser); // No action permission, including own-tab cleanup.
  const data = await safari.search({ query: request.query, region: 'uk-en', time: 'w', maxResults: 2 });
  assert.equal(data.results.length, 1); assert.equal('targetId' in data, false); assert.equal('epoch' in data, false); assert.equal(data.cleanup.status, 'closed');
  assert.equal(browser.calls.at(-1), 'close_tab');
  assert.equal(browser.calls.filter(n => n === 'create_tab').length, 1);
  assert.ok(browser.calls.every(n => ['create_tab', 'list_tabs', 'switch_tab', 'browser_dialogs', 'page_info', 'evaluate_javascript', 'close_tab'].includes(n)));
  for (const flag of ['redirect', 'changed', 'malformed'] as const) {
    const b = new SearchBrowser(); b[flag] = true;
    await assert.rejects(new Safari(b, () => {}).search({ query: request.query, region: 'uk-en', time: 'w', maxResults: 2 }));
    assert.equal(b.calls.filter(n => n === 'create_tab').length, 1);
    assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
  }
});
test('search validates before transport, honors queued cancellation, and recovers queue', async () => {
  const b = new SearchBrowser(), s = new Safari(b, () => {}), c = new AbortController();
  assert.throws(() => s.search({ query: '', maxResults: 10 })); assert.equal(b.calls.length, 0);
  const gate = s.serial(async () => new Promise(r => setTimeout(r, 5)));
  const pending = s.search({ query: 'x' }, c.signal); c.abort();
  await gate; await assert.rejects(pending, /cancelled/); assert.equal(b.calls.length, 0);
  await s.tabs(); assert.equal(b.calls.length, 1);
});

test('search cleanup preserves primary extraction failure when close fails', async () => {
  const b = new SearchBrowser(); b.malformed = true;
  const call = b.call.bind(b);
  b.call = async (name, args) => { if (name === 'close_tab') { b.calls.push(name); throw Error('close failure'); } return call(name, args); };
  await assert.rejects(new Safari(b, () => {}).search({ query: request.query, region: 'uk-en', time: 'w', maxResults: 2 }), (e: any) => {
    assert.match(e.message, /Invalid Safari search result.*cleanup: failed/); assert.match(e.cause.message, /Invalid Safari search result/); return true;
  });
  assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
});
test('search cancellation cleans known tab only while epoch remains current', async () => {
  for (const retire of [false, true]) {
    const b = new SearchBrowser(), c = new AbortController(), call = b.call.bind(b);
    b.call = async (name, args) => {
      const r = await call(name, args);
      if (name === 'create_tab') { c.abort(); if (retire) b.epoch = 'retired'; }
      return r;
    };
    // A transport that retires during create must not bind a new epoch to its reply.
    await assert.rejects(new Safari(b, () => {}).search({ query: 'x' }, c.signal), retire ? /stale.*skipped-retired-epoch/ : /cancel/);
    assert.equal(b.calls.filter(n => n === 'close_tab').length, retire ? 0 : 1);
  }
});
test('unknown create outcome is not retried or closed', async () => {
  const b = new SearchBrowser(), call = b.call.bind(b);
  b.call = async (name, args) => { if (name === 'create_tab') { b.calls.push(name); throw Error('create lost'); } return call(name, args); };
  await assert.rejects(new Safari(b, () => {}).search({ query: 'x' }), /create lost.*unidentified/);
  assert.deepEqual(b.calls, ['create_tab']);
});

test('cancellation during bounded cleanup does not cancel cleanup or return success', async () => {
  const b = new SearchBrowser(), c = new AbortController(), call = b.call.bind(b);
  b.call = async (name, args) => { if (name === 'close_tab') c.abort(); return call(name, args); };
  await assert.rejects(new Safari(b, () => {}).search({ query: request.query, region: 'uk-en', time: 'w', maxResults: 2 }, c.signal), /cancelled.*cleanup: closed/);
  assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
});


test('permission-free search infrastructure does not authorize restricted target actions', async () => {
  const b = new SearchBrowser(), s = new Safari(b);
  await s.search({ query: request.query, region: 'uk-en', time: 'w', maxResults: 2 });
  const before = b.calls.length;
  const t = { targetId: 'new', epoch: 'test' };
  await assert.rejects(s.activate(t), /approval/);
  await assert.rejects(s.navigate(t, b.url, 'https://example.com/'), /approval/);
  await assert.rejects(s.interact(t, b.url, { type: 'click', node: '1', purpose: 'unrequested' }), /approval/);
  assert.equal(b.calls.length, before);
});
