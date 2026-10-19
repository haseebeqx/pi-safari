import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { searchRequest, searchJS, genericSearchJS, validateSearch, validateGenericSearch, PAGE_LIMIT } from '../src/search.ts';
import { Safari } from '../src/safari.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';
const reply = (v: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const request = searchRequest({ query: 'a & b "quoted"', region: 'uk-en', time: 'w' });
const genericURL = 'https://results.example/search?q=pi';
const genericRequest = searchRequest({ url: genericURL });
const visible = { getClientRects: () => [{}] };
function row(url: string, title = 'Example', snippet = 'A useful snippet', hidden = false, ad = false) {
  const anchor = { ...visible, href: url, innerText: title };
  return { getClientRects: () => hidden ? [] : [{}], matches: () => ad, querySelector: (selector: string) => selector === 'a.result__a[href]' ? anchor : { ...visible, innerText: snippet } };
}
function extract(rows: ReturnType<typeof row>[], url = request.url) {
  return JSON.parse(vm.runInNewContext(searchJS(request.url), {
    URL, location: Object.freeze({ href: url }), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: Object.freeze({ querySelectorAll: (selector: string) => { assert.equal(selector, '.result'); return rows; } }),
  }));
}
test('deterministic provider URL construction and strict controls', () => {
  assert.equal(request.url, 'https://html.duckduckgo.com/html/?q=a+%26+b+%22quoted%22&kl=uk-en&df=w');
  assert.deepEqual(request, { mode: 'ddg', query: 'a & b "quoted"', region: 'uk-en', time: 'w', url: request.url });
  assert.equal(searchRequest({ query: ' hello ' }).url, 'https://html.duckduckgo.com/html/?q=hello&kl=wt-wt');
  for (const options of [{ query: '' }, { query: ' ' }, { query: 'x'.repeat(501) }, { query: 'x\n' }, { query: 'x', region: 'bogus' }, { query: 'x', time: 'century' }, {}, { query: 'x', url: genericURL }]) assert.throws(() => searchRequest(options));
});
test('url mode normalizes any HTTP(S) search-results page with no query controls', () => {
  const r = searchRequest({ url: ' https://results.example/search?q=pi ' });
  assert.deepEqual(r, { mode: 'generic', url: genericURL });
  assert.equal(searchRequest({ url: genericURL }).url, genericURL);
  for (const options of [{ url: 'javascript:alert(1)' }, { url: 'ftp://example.com/' }, { url: 'https://user:pass@example.com/' }, { url: 'x'.repeat(8193) }, { url: 123 }]) assert.throws(() => searchRequest(options as any));
});
test('selector overrides are generic-mode only, trimmed, bounded and character-checked', () => {
  const s = searchRequest({ url: genericURL, selectors: { item: ' .result ', link: 'a.result__a', title: 'h2 a', snippet: '.result__snippet' } });
  assert.equal(s.mode, 'generic');
  assert.deepEqual(s.selectors, { item: '.result', link: 'a.result__a', title: 'h2 a', snippet: '.result__snippet' });
  const bare = searchRequest({ url: genericURL });
  assert.equal(bare.selectors, undefined);
  for (const options of [
    { query: 'x', selectors: { item: '.result' } },
    { url: genericURL, selectors: {} },
    { url: genericURL, selectors: { item: ' ' } },
    { url: genericURL, selectors: { item: 'x'.repeat(501) } },
    { url: genericURL, selectors: { item: '.result', link: 'x'.repeat(501) } },
    { url: genericURL, selectors: { item: '.result', link: '' } },
    { url: genericURL, selectors: { item: '.result', link: 5 } },
    { url: genericURL, selectors: { item: '.result', title: 0 } },
    { url: genericURL, selectors: ['.result'] },
    { url: genericURL, selectors: 'x'.repeat(8193) },
  ]) assert.throws(() => searchRequest(options as any));
});
test('selector-driven extraction ranks item containers, uses sub-selectors and shared guards', () => {
  const sel = { item: '.result', link: 'a.organic', title: '.t', snippet: '.s' };
  function anchor(href: string, text = 'Anchor label text', box?: string, heading?: string) {
    return { href, innerText: text, getClientRects: () => [{}],
      querySelector: (s: string) => s === 'h1,h2,h3,h4' ? (heading ? { innerText: heading } : null) : null,
      closest: (s: string) => s === 'article,li' ? (box !== undefined ? { innerText: box } : null) : null };
  }
  const items = [
    { link: anchor('https://a.example/one'), title: '  Title one  ', snippet: ' Snippet one ' },
    { link: anchor('https://a.example/one'), title: 'Dup', snippet: 'dup' },
    { link: anchor('javascript:bad'), title: 'Bad', snippet: 'bad' },
    { link: anchor('https://user:pass@example.com/'), title: 'Creds', snippet: 'creds' },
    { hidden: true, link: anchor('https://b.example/hidden'), title: 'Hidden', snippet: 'hidden' },
    { link: null, title: 'No link', snippet: 'nolink' },
    { link: { ...anchor('https://b.example/sub'), getClientRects: () => [] }, title: 'Hidden link', snippet: 'hl' },
    // No title element: falls back to inner heading, then anchor text. No snippet element: falls back to box tail.
    { link: anchor('https://b.example/two', 'short', 'Inner heading here\nTail detail of the box', 'Inner heading here') },
    { link: anchor('https://b.example/three', 'Anchor text used as title'), title: '', snippet: '' },
    // Same-site uddg clickthrough is unwrapped by the shared guard.
    { link: anchor(`https://results.example/l/?uddg=${encodeURIComponent('https://dest.example/uddg')}`), title: 'Unwrapped', snippet: 'u' },
  ].map(r => ({
    getClientRects: () => r.hidden ? [] : [{}],
    querySelector: (s: string) => {
      if (s === sel.link) return r.link ?? null;
      if (s === sel.title) return r.title ? { innerText: r.title } : null;
      if (s === sel.snippet) return r.snippet ? { innerText: r.snippet } : null;
      return null;
    },
  }));
  const pager = [{ href: 'https://page.example/next', innerText: 'Next', getClientRects: () => [{}] }];
  const data = JSON.parse(vm.runInNewContext(genericSearchJS(genericURL, sel), {
    URL, location: Object.freeze({ href: genericURL }), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: Object.freeze({ querySelectorAll: (s: string) => s === sel.item ? items : s === 'a[href]' ? pager : [] }),
  }));
  assert.equal(data.url, genericURL); assert.equal(data.truncated, false); assert.deepEqual(data.pager, ['https://page.example/next']);
  assert.deepEqual(data.results, [
    { rank: 1, title: 'Title one', url: 'https://a.example/one', snippet: 'Snippet one' },
    { rank: 2, title: 'Inner heading here', url: 'https://b.example/two', snippet: 'Tail detail of the box' },
    { rank: 3, title: 'Anchor text used as title', url: 'https://b.example/three', snippet: '' },
    { rank: 4, title: 'Unwrapped', url: 'https://dest.example/uddg', snippet: 'u' },
  ]);
  assert.deepEqual(validateGenericSearch(data, genericURL), { results: data.results, pager: data.pager, truncated: data.truncated });
  assert.throws(() => vm.runInNewContext(genericSearchJS(genericURL, sel), {
    URL, location: Object.freeze({ href: 'https://changed.example/' }), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    document: Object.freeze({ querySelectorAll: () => [] }),
  }), /URL changed/);
});
test('selector-driven extraction bounds items at 300 and results at the page limit', () => {
  const sel = { item: '.result', link: 'a.organic', title: '.t', snippet: '.s' };
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
    getClientRects: () => [{}],
    querySelector: (s: string) => s === sel.link ? { href: `https://p.example/${i}`, innerText: `t${i}`, getClientRects: () => [{}], querySelector: () => null, closest: () => null }
      : s === sel.title ? { innerText: `Title ${i}` } : s === sel.snippet ? { innerText: `S ${i}` } : null,
  }));
  const run = (n: number) => {
    const document = Object.freeze({ querySelectorAll: (s: string) => (s === sel.item ? mk(n) : s === 'a[href]' ? [] : []) });
    return JSON.parse(vm.runInNewContext(genericSearchJS(genericURL, sel), {
      URL, location: Object.freeze({ href: genericURL }), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), document,
    }));
  };
  const full = run(PAGE_LIMIT);
  assert.equal(full.results.length, PAGE_LIMIT); assert.equal(full.truncated, false); assert.deepEqual(full.pager, []);
  const many = run(301);
  assert.equal(many.results.length, PAGE_LIMIT); assert.equal(many.truncated, true);
});
test('selector overrides reject invalid CSS before any transport call', async () => {
  const b = new SearchBrowser(), s = new Safari(b, () => {});
  assert.throws(() => s.search({ url: genericURL, selectors: {} } as any));
  assert.throws(() => s.search({ url: genericURL, selectors: { link: '.a' } } as any), /item is required/);
  assert.throws(() => s.search({ query: 'x', selectors: { item: '.r' } }));
  assert.equal(b.calls.length, 0);
});
test('fixed DOM extraction ranks unique results, unwraps DDG links, skips unsafe/malformed/hidden/ads', () => {
  const data = extract([
    row('javascript:alert(1)'), row('https://user:pass@example.com/'), row('https://duckduckgo.com/l/?uddg=not-a-url'),
    row('https://html.duckduckgo.com/html/?q=other'), row('https://example.com/hidden', 'Hidden', '', true), row('https://example.com/ad', 'Ad', '', false, true),
    row('https://example.com/empty', '  '), row('https://example.com/' + 'x'.repeat(2048)),
    row('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F', '  First   result  ', '  Some\n snippet '),
    row('https://example.com/', 'Duplicate'), row('https://second.example/', 'x'.repeat(400), 's'.repeat(700)), row('https://third.example/'),
  ]);
  assert.equal(data.truncated, false); assert.equal(data.results.length, 3);
  assert.deepEqual(data.results[0], { rank: 1, title: 'First result', url: 'https://example.com/', snippet: 'Some snippet' });
  assert.equal(data.results[1].rank, 2); assert.equal(data.results[1].title.length, 300); assert.equal(data.results[1].snippet.length, 600);
  assert.deepEqual(data.results[2], { rank: 3, title: 'Example', url: 'https://third.example/', snippet: 'A useful snippet' });
  assert.deepEqual(validateSearch(data, request.url), { results: data.results, truncated: false });
  assert.throws(() => extract([], 'https://changed.example/'), /URL changed/);
});
test('DDG extraction is bounded by the page limit and 100-node scan', () => {
  const rows = Array.from({ length: PAGE_LIMIT + 5 }, (_, i) => row(`https://ddg-page.example/${i}`, `Result ${i}`));
  const data = extract(rows);
  assert.equal(data.results.length, PAGE_LIMIT); assert.equal(data.truncated, true);
  assert.deepEqual(extract([]), { url: request.url, results: [], truncated: false });
  assert.deepEqual(extract([...Array.from({ length: 100 }, () => row('javascript:bad')), row('https://valid.example/')]), { url: request.url, results: [], truncated: true });
});
test('host validation rejects malformed extraction replies, unsafe URLs and excess results', () => {
  const valid = extract([row('https://example.com/')]);
  for (const data of [null, {}, { ...valid, url: 'https://other.example/' }, { ...valid, truncated: 'no' }, { ...valid, results: [...valid.results, ...valid.results] }, { ...valid, results: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => ({ ...valid.results[0], rank: i + 1, url: `https://many.example/${i}` })) }]) assert.throws(() => validateSearch(data, request.url));
  for (const patch of [{ url: 'javascript:alert(1)' }, { url: 'https://u:p@example.com/' }, { rank: 9 }, { title: '' }, { title: 'x'.repeat(301) }, { snippet: null }, { snippet: 'x'.repeat(601) }, { url: 'https://example.com/' + 'x'.repeat(2048) }]) assert.throws(() => validateSearch({ ...valid, results: [{ ...valid.results[0], ...patch }] }, request.url));
});
function genericAnchors(list: { href: string; text?: string; hidden?: boolean; in?: string | null; out?: string | null; box?: string; heading?: string; headingParent?: { innerText: string } }[]) {
  const anchors = list.map(a => ({
    href: a.href,
    innerText: a.text ?? 'A plausible search result headline',
    getClientRects: () => a.hidden ? [] : [{}],
    querySelector: () => (a.heading ? { innerText: a.heading } : null),
    closest: (selector: string) => {
      if (selector === 'article,li,main,section,td') return a.in === undefined ? 'article' : a.in;
      if (selector === 'article,li') return a.box !== undefined ? { innerText: a.box } : null;
      if (selector === 'h1,h2,h3,h4') return a.headingParent ?? null;
      return a.out ?? null;
    },
  }));
  const document = Object.freeze({ querySelectorAll: (selector: string) => { assert.equal(selector, 'a[href]'); return anchors; } });
  return (url: string = genericURL) => JSON.parse(vm.runInNewContext(genericSearchJS(genericURL), {
    URL, atob: globalThis.atob, location: Object.freeze({ href: url }), getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), document,
  }));
}
test('generic extractor keeps visible result anchors in DOM order with ranks, dedupes and extracts snippets', () => {
  const data = genericAnchors([
    { href: 'https://result.example/one', box: 'A plausible search result headline\nSome detail text here' },
    { href: 'https://result.example/one', box: 'A plausible search result headline' },
    { href: '/relative/two', text: 'A relative second result', box: 'A relative second result\nSecond detail line' },
    { href: 'https://result.example/three' },
  ])();
  assert.equal(data.url, genericURL); assert.equal(data.truncated, false); assert.deepEqual(data.pager, []);
  assert.deepEqual(data.results, [
    { rank: 1, title: 'A plausible search result headline', url: 'https://result.example/one', snippet: 'Some detail text here' },
    { rank: 2, title: 'A relative second result', url: 'https://results.example/relative/two', snippet: 'Second detail line' },
    { rank: 3, title: 'A plausible search result headline', url: 'https://result.example/three', snippet: '' },
  ]);
});
test('generic extractor rejects hidden, navigation, short, unsafe and oversize anchors', () => {
  const data = genericAnchors([
    { href: 'https://ok.example/a', hidden: true },
    { href: 'https://ok.example/b', out: 'nav' },
    { href: 'https://ok.example/c', out: 'footer' },
    { href: 'https://ok.example/d', out: 'aside' },
    { href: 'https://ok.example/e', out: 'form' },
    { href: 'https://ok.example/f', in: null },
    { href: 'https://ok.example/g', text: 'Short' },
    { href: 'https://ok.example/h', text: ' '.repeat(12) },
    { href: 'https://ok.example/i', text: 'x'.repeat(301) },
    { href: 'https://ok.example/j', text: 'site.examplehttps://site.example/docs' },
    { href: 'https://ok.example/k', text: 'example.com' },
    { href: 'javascript:alert(1)' },
    { href: 'https://user:pass@example.com/' },
    { href: 'https://example.com/' + 'x'.repeat(2048) },
    { href: 'https://example.com/keep' },
  ])();
  assert.deepEqual(data.results, [{ rank: 1, title: 'A plausible search result headline', url: 'https://example.com/keep', snippet: '' }]);
});
test('generic extractor unwraps same-origin a1 base64 clickthrough links', () => {
  const enc = (dest: string) => 'a1' + Buffer.from(dest, 'utf8').toString('base64');
  const padded = enc('https://dest.example/padded');
  const data = genericAnchors([
    { href: `https://results.example/ck/a?p=1&u=${padded}` },
    { href: `https://results.example/ck/a?p=2&u=${enc('https://dest.example/unpadded').replace(/=+$/, '')}` },
    { href: `https://results.example/ck/a?p=3&u=a1!!not-base64!!` },
    { href: `https://other.example/redirect?u=${enc('https://dest.example/other')}` },
    { href: `https://results.example/l/?uddg=${encodeURIComponent('https://dest.example/uddg')}&rut=1` },
  ])();
  assert.deepEqual(data.results.map((r: any) => r.url), [
    'https://dest.example/padded',
    'https://dest.example/unpadded',
    'https://results.example/ck/a?p=3&u=a1!!not-base64!!',
    'https://other.example/redirect?u=a1' + Buffer.from('https://dest.example/other', 'utf8').toString('base64'),
    'https://dest.example/uddg',
  ]);
});
test('generic extractor prefers the inner heading text as the title', () => {
  const data = genericAnchors([
    { href: 'https://site.example/docs', text: 'site.examplehttps://site.example › docs', heading: 'A clean heading title', box: 'A clean heading title\nSome detail after the title' },
  ])();
  assert.deepEqual(data.results, [{ rank: 1, title: 'A clean heading title', url: 'https://site.example/docs', snippet: 'Some detail after the title' }]);
  const noHeading = genericAnchors([ { href: 'https://site.example/x', text: 'site.example › docs' } ])();
  assert.equal(noHeading.results[0].title, 'site.example › docs');
});
test('generic extractor unwraps RU= same-site clickthrough segments (Yahoo-style)', () => {
  const data = genericAnchors([
    { href: `https://r.search.results.example/_ylt=abc;_ylu=xyz/RU=${encodeURIComponent('https://dest.example/y')}/RK=2/RS=token`, text: 'A real result page' },
    { href: `https://r.search.other.example/_ylt=abc/RU=${encodeURIComponent('https://dest.example/z')}/RK=2`, text: 'Different site result' },
  ])();
  assert.deepEqual(data.results.map((r: any) => r.url), [
    'https://dest.example/y',
    `https://r.search.other.example/_ylt=abc/RU=${encodeURIComponent('https://dest.example/z')}/RK=2`,
  ]);
});

test('generic extractor prefers heading-anchored results over bare UI links', () => {
  const data = genericAnchors([
    { href: 'https://ui.example/?filter=day', text: 'Past day' },
    { href: 'https://ui.example/?filter=week', text: 'Past week' },
    { href: 'https://dest.example/h', text: 'Electronhttps://dest.example › docs First App Tutorial', headingParent: { innerText: 'First App Tutorial' } },
  ])();
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].title, 'First App Tutorial');
  assert.equal(data.results[0].url, 'https://dest.example/h');
});

test('generic extractor truncates at the 30-result page limit', () => {
  const data = genericAnchors(Array.from({ length: 31 }, (_, i) => ({ href: `https://page.example/${i}`, text: `A plausible search result ${i}` })))();
  assert.equal(data.results.length, PAGE_LIMIT); assert.equal(data.truncated, true);
  assert.equal(data.results[PAGE_LIMIT - 1].rank, PAGE_LIMIT);
  const full = genericAnchors(Array.from({ length: PAGE_LIMIT }, (_, i) => ({ href: `https://page.example/${i}`, text: `A plausible search result ${i}` })))();
  assert.equal(full.truncated, false); assert.equal(full.results.length, PAGE_LIMIT);
});
test('generic extractor honors the 2000-element scan bound', () => {
  const data = genericAnchors(Array.from({ length: 2001 }, (_, i) => ({ href: `https://bound.example/${i}`, text: `A plausible search result ${i}` })))();
  assert.equal(data.results.length, PAGE_LIMIT); assert.equal(data.truncated, true);
});
test('generic extractor collects pager links without deduping against results', () => {
  const data = genericAnchors([
    { href: 'https://page.example/next', text: 'Next' },
    { href: 'https://page.example/next2', text: '»' },
    { href: 'https://page.example/p2', text: '2' },
    { href: 'https://page.example/p3', text: '›' },
    { href: 'https://page.example/p4', text: '…' },
    { href: 'https://page.example/keep', text: 'A plausible search result' },
    { href: 'https://page.example/next', text: 'Next' },
    { href: 'https://page.example/next', text: 'Next', hidden: true },
    { href: 'https://page.example/next', text: 'Next', out: 'nav' },
    { href: 'https://page.example/next', text: 'Next', in: null },
    { href: 'javascript:next', text: '»' },
    { href: 'https://user:pass@example.com/p', text: '3' },
    { href: 'https://page.example/text', text: 'Next Page' },
    { href: 'https://page.example/long', text: '1000' },
    { href: 'https://page.example/brand', text: 'Branded next link' },
  ])();
  assert.deepEqual(data.pager, ['https://page.example/next', 'https://page.example/next2', 'https://page.example/p2', 'https://page.example/p3', 'https://page.example/p4', 'https://page.example/text']);
  // Long or branded pager-ish anchors are acceptable heuristic noise in results; exact pager labels (incl. 'next page') are pager-only.
  assert.deepEqual(data.results.map((r: any) => r.url), ['https://page.example/keep', 'https://page.example/brand']);
});
test('generic extractor caps the pager at 12 unique URLs', () => {
  const data = genericAnchors(Array.from({ length: 14 }, (_, i) => ({ href: i < 12 ? `https://page.example/pg${i}` : 'https://page.example/pg0', text: String(i + 1) })))();
  assert.equal(data.pager.length, 12);
  assert.deepEqual(data.pager, Array.from({ length: 12 }, (_, i) => `https://page.example/pg${i}`));
  assert.deepEqual(data.results, []);
});
test('generic extractor fails closed when the document moved', () => {
  assert.throws(() => genericAnchors([])('https://changed.example/'), /URL changed/);
});
test('host generic validation mirrors the fail-closed reply contract', () => {
  const valid = genericAnchors([{ href: 'https://result.example/one', box: 'One title\nDetail' }, { href: 'https://page.example/next', text: 'Next' }])();
  assert.deepEqual(validateGenericSearch(valid, genericURL), { results: valid.results, pager: valid.pager, truncated: valid.truncated });
  const full = genericAnchors(Array.from({ length: PAGE_LIMIT }, (_, i) => ({ href: `https://page.example/${i}`, text: `A plausible search result ${i}` })))();
  const withPager = { ...full, pager: ['https://page.example/p1', 'https://page.example/p2'] };
  for (const data of [null, {}, { ...full, url: 'https://other.example/' }, { ...full, truncated: 'no' }, { ...full, results: [...full.results, ...full.results] }, { ...full, pager: Array.from({ length: 13 }, (_, i) => `https://page.example/p${i}`) }, { ...withPager, pager: [...withPager.pager, withPager.pager[0]] }, { ...full, pager: [...valid.pager, ...valid.pager] }, { ...full, pager: ['https://page.example/a', 'javascript:alert(1)'] }, { ...full, pager: ['https://u:p@example.com/'] }, { ...full, pager: ['x'.repeat(8193)] }, { ...full, pager: ['https://page.example/p1', 'https://page.example/p1'] }]) assert.throws(() => validateGenericSearch(data, genericURL));
  for (const patch of [{ url: 'javascript:alert(1)' }, { url: 'https://u:p@example.com/' }, { rank: 9 }, { title: '' }, { title: 'x'.repeat(301) }, { snippet: null }, { snippet: 'x'.repeat(301) }, { url: 'https://example.com/' + 'x'.repeat(2048) }]) assert.throws(() => validateGenericSearch({ ...full, results: [{ ...full.results[0], ...patch }] }, genericURL));
});
class SearchBrowser implements Transport {
  epoch = 'test'; url = ''; calls: string[] = []; redirect = false; changed = false; malformed = false; genericRows: any[] | undefined;
  async call(name: string, args: Record<string, unknown>) {
    this.calls.push(name);
    if (name === 'create_tab') { this.url = this.redirect ? 'https://other.example/' : String(args.url); return reply({ handle: 'new' }); }
    if (name === 'list_tabs') return reply([{ handle: 'new', url: this.url }]);
    if (name === 'browser_dialogs') return reply({ dialogs: [] });
    if (name === 'close_tab') { assert.equal(args.handle, 'new'); return { content: [{ type: 'text' as const, text: 'Closed.' }] }; }
    if (name === 'switch_tab') return { content: [{ type: 'text' as const, text: 'OK' }] };
    if (name === 'page_info') return reply({ url: this.url });
    if (name === 'evaluate_javascript') {
      const expression = String(args.expression);
      if (!expression.includes('querySelectorAll')) return reply(true);
      const data = expression.includes("'a[href]'")
        ? genericAnchors(this.genericRows ?? [{ href: 'https://example.com/' }, { href: 'https://page.example/next', text: 'Next' }])(this.url)
        : extract([row('https://example.com/')], this.url);
      if (this.changed) this.url = 'https://other.example/';
      return reply(JSON.stringify(this.malformed ? {} : data));
    }
    throw Error('unexpected call');
  }
  close() {}
}
test('search performs one new-tab operation and preserves fail-closed identity/no-replay', async () => {
  const browser = new SearchBrowser(); const safari = new Safari(browser); // No action permission, including own-tab cleanup.
  const data = await safari.search({ query: request.query, region: 'uk-en', time: 'w' });
  assert.equal(data.mode, 'ddg'); assert.equal(data.query, request.query); assert.equal(data.region, 'uk-en'); assert.equal(data.time, 'w');
  assert.equal(data.results.length, 1); assert.equal('pager' in data, false);
  assert.equal('targetId' in data, false); assert.equal('epoch' in data, false); assert.equal(data.cleanup.status, 'closed');
  assert.equal(browser.calls.at(-1), 'close_tab');
  assert.equal(browser.calls.filter(n => n === 'create_tab').length, 1);
  assert.ok(browser.calls.every(n => ['create_tab', 'list_tabs', 'switch_tab', 'browser_dialogs', 'page_info', 'evaluate_javascript', 'close_tab'].includes(n)));
  const generic = await new Safari(new SearchBrowser()).search({ url: genericURL });
  assert.equal(generic.mode, 'generic'); assert.equal(generic.url, genericURL);
  assert.equal('query' in generic, false); assert.equal('region' in generic, false); assert.equal('time' in generic, false);
  assert.equal(generic.results.length, 1); assert.deepEqual((generic as any).pager, ['https://page.example/next']);
  assert.equal('targetId' in generic, false); assert.equal('epoch' in generic, false); assert.equal(generic.cleanup.status, 'closed');
  assert.match(generic.note, /pager/);
  for (const [flag, options] of [['redirect', { query: request.query, region: 'uk-en', time: 'w' }], ['changed', { query: request.query, region: 'uk-en', time: 'w' }], ['malformed', { query: request.query, region: 'uk-en', time: 'w' }], ['redirect', { url: genericURL }], ['changed', { url: genericURL }], ['malformed', { url: genericURL }]] as const) {
    const b = new SearchBrowser(); b[flag] = true;
    await assert.rejects(new Safari(b, () => {}).search(options));
    assert.equal(b.calls.filter(n => n === 'create_tab').length, 1);
    assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
  }
});
test('search validates before transport, honors queued cancellation, and recovers queue', async () => {
  const b = new SearchBrowser(), s = new Safari(b, () => {}), c = new AbortController();
  assert.throws(() => s.search({})); assert.throws(() => s.search({ query: 'x', url: genericURL })); assert.throws(() => s.search({ query: '' })); assert.equal(b.calls.length, 0);
  const gate = s.serial(async () => new Promise(r => setTimeout(r, 5)));
  const pending = s.search({ query: 'x' }, c.signal); c.abort();
  await gate; await assert.rejects(pending, /cancelled/); assert.equal(b.calls.length, 0);
  await s.tabs(); assert.equal(b.calls.length, 1);
});
test('search cleanup preserves primary extraction failure when close fails', async () => {
  const b = new SearchBrowser(); b.malformed = true;
  const call = b.call.bind(b);
  b.call = async (name, args) => { if (name === 'close_tab') { b.calls.push(name); throw Error('close failure'); } return call(name, args); };
  await assert.rejects(new Safari(b, () => {}).search({ query: request.query, region: 'uk-en', time: 'w' }), (e: any) => {
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
  await assert.rejects(new Safari(b, () => {}).search({ query: request.query, region: 'uk-en', time: 'w' }, c.signal), /cancelled.*cleanup: closed/);
  assert.equal(b.calls.filter(n => n === 'close_tab').length, 1);
});
test('permission-free search infrastructure does not authorize restricted target actions', async () => {
  const b = new SearchBrowser(), s = new Safari(b);
  await s.search({ query: request.query, region: 'uk-en', time: 'w' });
  const before = b.calls.length;
  const t = { targetId: 'new', epoch: 'test' };
  await assert.rejects(s.activate(t), /approval/);
  await assert.rejects(s.navigate(t, b.url, 'https://example.com/'), /approval/);
  await assert.rejects(s.interact(t, b.url, { type: 'click', node: '1', purpose: 'unrequested' }), /approval/);
  assert.equal(b.calls.length, before);
});
