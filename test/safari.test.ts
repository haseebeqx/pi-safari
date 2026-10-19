import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Safari, uploadJS } from '../src/safari.ts';
import { webURL, readJS, linkJS, bound, loadedJS } from '../src/extraction.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';
const reply = (data: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
class Browser implements Transport {
  epoch = 'session-1';
  calls: { name: string; args: Record<string, unknown> }[] = [];
  tabs = [{ handle: 'page-1', url: 'https://example.com/' }];
  dialogs: { message: string }[] = [];
  dialogActions: { action: string; inputText?: string }[] = [];
  current = 'page-1';
  url = 'https://example.com/';
  result: unknown;
  async call(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    switch (name) {
      case 'list_tabs': return reply(this.tabs);
      case 'switch_tab': this.current = String(args.handle); return { content: [{ type: 'text', text: 'Switched to tab.' }] };
      case 'browser_dialogs':
        if (args.action === 'list') return reply({ dialogs: this.dialogs });
        if (this.dialogs.length === 0) throw Error('Safari tool failed: No JavaScript dialog is showing');
        this.dialogActions.push({ action: String(args.action), inputText: args.inputText === undefined ? undefined : String(args.inputText) });
        this.dialogs = [];
        return { content: [{ type: 'text', text: args.action === 'dismiss' ? 'Dialog dismissed' : 'Dialog accepted' }] };
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

test('dialog list is a safe read; respond/dismiss dispatch once and verify without page_info', async () => {
  const b = new Browser(); b.dialogs = [{ message: 'Type secret?' }];
  const s = new Safari(b, () => { throw Error('no approval needed for dialogs'); });
  const listed = await s.dialog(target, 'list');
  assert.equal(listed.action, 'listed');
  assert.deepEqual(listed.dialogs, [{ message: 'Type secret?' }]);
  assert.deepEqual(b.calls.map(c => c.name).slice(0, 3), ['list_tabs', 'switch_tab', 'browser_dialogs']);
  assert.equal(b.calls.filter(c => c.name === 'page_info').length, 0);
  const responded = await s.dialog(target, 'respond', 'hello');
  assert.equal(responded.action, 'respond');
  assert.deepEqual(responded.dialogs, []);
  const b2 = new Browser(); b2.dialogs = [{ message: 'Sure?' }];
  const dismissed = await new Safari(b2, () => {}).dialog(target, 'dismiss');
  assert.equal(dismissed.action, 'dismiss');
  assert.deepEqual(b2.dialogActions, [{ action: 'dismiss', inputText: undefined }]);
  assert.deepEqual(b.dialogActions, [{ action: 'respond', inputText: 'hello' }]);
  assert.equal(b.calls.filter(c => c.name === 'browser_dialogs' && c.args.action === 'respond').length, 1);
});

test('dialog respond/dismiss fail fast without a pending dialog; inputText is respond-only', async () => {
  const b = new Browser(), s = new Safari(b, () => {});
  await assert.rejects(s.dialog(target, 'respond'), /No pending dialog/);
  await assert.rejects(s.dialog(target, 'dismiss'), /No pending dialog/);
  assert.equal(b.dialogActions.length, 0);
  await assert.rejects(s.dialog(target, 'list', 'x'), /inputText is only for respond/);
  await assert.rejects(s.dialog(target, 'dismiss', 'x'), /inputText is only for respond/);
  await assert.rejects(s.dialog(target, 'respond', 'x'.repeat(4001)), /1\.\.4000/);
  await assert.rejects(s.dialog(target, 'bogus' as any), /action must be/);
});

test('open and wait fail fast when a modal dialog blocks the tab', async () => {
  const b = new Browser(); b.dialogs = [{ message: 'Modal!' }];
  const s = new Safari(b, () => {});
  await assert.rejects(s.open('https://example.com/'), /modal JavaScript dialog/);
  assert.equal(b.calls.filter(c => c.name === 'create_tab').length, 1);
  const b2 = new Browser(); b2.dialogs = [{ message: 'Modal!' }];
  const s2 = new Safari(b2, () => {});
  await assert.rejects(s2.wait(target, 'https://example.com/', { text: 'x' }, 1000), /modal JavaScript dialog/);
});

test('load wait validates URL and timeout bounds before transport calls', () => {
  const b = new Browser(), s = new Safari(b, () => {});
  assert.throws(() => s.waitNavigation(target, 'file:///tmp/x'));
  for (const ms of [-1, 10001, 2.5, '5000' as any]) assert.throws(() => s.waitNavigation(target, 'https://example.com/', ms));
  assert.equal(b.calls.length, 0);
});
test('load-wait script enforces exact URL, complete state and bounded title', () => {
  const mk = (href: string, readyState: string, title: string) => ({ location: { href }, document: { title, readyState } });
  const expr = loadedJS('https://example.com/');
  assert.equal(JSON.parse(vm.runInNewContext(expr, mk('https://example.com/', 'complete', 'Done'))).ready, true);
  assert.equal(JSON.parse(vm.runInNewContext(expr, mk('https://example.com/', 'loading', 'Done'))).ready, false);
  assert.equal(JSON.parse(vm.runInNewContext(expr, mk('https://example.com/', 'interactive', 'Done'))).ready, false);
  assert.equal(JSON.parse(vm.runInNewContext(expr, mk('https://other.example/', 'complete', 'Done'))).ready, false);
  const long = JSON.parse(vm.runInNewContext(expr, mk('https://example.com/', 'complete', 't'.repeat(500))));
  assert.equal(long.title.length, 300);
  assert.throws(() => loadedJS('file:///tmp/x'));
});
test('load wait polls until readyState complete and returns final URL and title', async () => {
  const b = new Browser(); let polls = 0;
  const original = b.call.bind(b);
  b.call = async (name, args) => {
    if (name === 'evaluate_javascript') { polls++; return reply(JSON.stringify({ ready: polls > 2, url: 'https://example.com/', title: 'Loaded' })); }
    return original(name, args);
  };
  const s = new Safari(b, () => {});
  const data = await s.waitNavigation(target, 'https://example.com/', 1000);
  assert.equal(polls, 3);
  assert.equal(data.url, 'https://example.com/');
  assert.equal(data.title, 'Loaded');
  assert.match(data.note, /readyState complete/);
  assert.equal(b.calls.some(c => ['navigate_to_url', 'page_interactions', 'create_tab'].includes(c.name)), false);
  assert.equal(b.calls.filter(c => c.name === 'list_tabs').length, b.calls.filter(c => c.name === 'switch_tab').length);
});
test('load wait resolves immediately for an already-complete document', async () => {
  const b = new Browser(), s = new Safari(b, () => {});
  const data = await s.waitNavigation(target, 'https://example.com/');
  assert.equal(data.url, 'https://example.com/');
  assert.equal(data.title, 'Example');
  assert.equal(b.calls.filter(c => c.name === 'evaluate_javascript').length, 1);
});
test('load wait times out reporting the last observed URL and cancels without mutation', async () => {
  const b = new Browser();
  const original = b.call.bind(b);
  b.call = async (name, args) => {
    if (name === 'evaluate_javascript') return reply(JSON.stringify({ ready: false, url: 'https://mid-redirect.example/', title: 'Loading' }));
    return original(name, args);
  };
  const s = new Safari(b, () => {});
  await assert.rejects(s.waitNavigation(target, 'https://example.com/', 0), /timed out[\s\S]*mid-redirect\.example/);
  const ac = new AbortController();
  const pending = s.waitNavigation(target, 'https://example.com/', 10000, ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(pending, /cancelled/);
  assert.equal(b.calls.some(c => ['navigate_to_url', 'page_interactions', 'create_tab'].includes(c.name)), false);
});
test('load wait fails fast when a modal dialog blocks the tab', async () => {
  const b = new Browser(); b.dialogs = [{ message: 'Modal!' }];
  await assert.rejects(new Safari(b, () => {}).waitNavigation(target, 'https://example.com/', 1000), /modal JavaScript dialog/);
  assert.equal(b.calls.filter(c => c.name === 'evaluate_javascript').length, 0);
});

test('evaluate validates URL and bounds and fails closed without the standalone grant', async () => {
  const b = new Browser(), s = new Safari(b, () => {});
  await assert.rejects(s.evaluate(target, 'https://example.com/', '1+1'), /standalone/);
  const s2 = new Safari(b, () => {}, () => {});
  for (const expression of ['', 'x'.repeat(8001), 5 as any]) assert.throws(() => s2.evaluate(target, 'https://example.com/', expression), /1\.\./);
  assert.throws(() => s2.evaluate(target, 'file:///tmp/x', '1+1'));
  await assert.rejects(s2.evaluate({ ...target, epoch: 'old' }, 'https://example.com/', '1+1'), /stale/);
  assert.equal(b.calls.length, 0);
});
test('evaluate checks the exact URL, dispatches once, and reports the post-evaluation URL', async () => {
  const b = new Browser(); b.result = 2;
  const out = await new Safari(b, () => {}, () => {}).evaluate(target, 'https://example.com/', '1+1');
  assert.equal(out.value, '2'); assert.equal(out.truncated, false);
  assert.equal(out.url, 'https://example.com/');
  assert.match(out.note, /executed once/);
  assert.deepEqual(b.calls.map(c => c.name), ['list_tabs', 'switch_tab', 'page_info', 'evaluate_javascript', 'page_info', 'list_tabs']);
  assert.equal(String(b.calls[3].args.expression), 'return (1+1);');
  // Navigation by the expression is reported in url, not an error.
  const b3 = new Browser(), call = b3.call.bind(b3); b3.result = 'nav';
  b3.call = async (name, args) => { const r = await call(name, args); if (name === 'evaluate_javascript') b3.url = 'https://changed.example/'; return r; };
  const moved = await new Safari(b3, () => {}, () => {}).evaluate(target, 'https://example.com/', 'location.href');
  assert.equal(moved.url, 'https://changed.example/');
  // A closed tab is reported; oversized results are truncated with a flag.
  const b4 = new Browser(), call4 = b4.call.bind(b4); b4.result = 'v'.repeat(13000);
  b4.call = async (name, args) => { const r = await call4(name, args); if (name === 'evaluate_javascript') b4.tabs = []; return r; };
  await assert.rejects(new Safari(b4, () => {}, () => {}).evaluate(target, 'https://example.com/', '1'), /closed or lost/);
  const b5 = new Browser(); b5.result = 'v'.repeat(13000);
  const big = await new Safari(b5, () => {}, () => {}).evaluate(target, 'https://example.com/', '1');
  assert.equal(big.value.length, 12000); assert.equal(big.truncated, true);
  // Wrong source URL rejects before any evaluation.
  const b6 = new Browser(); b6.url = 'https://other.example/';
  await assert.rejects(new Safari(b6, () => {}, () => {}).evaluate(target, 'https://example.com/', '1'), /Source URL changed/);
  assert.equal(b6.calls.filter(c => c.name === 'evaluate_javascript').length, 0);
});
test('grant revoked before dispatch is not replayed', async () => {
  const b = new Browser(); b.result = 'x';
  const raw = b.call.bind(b);
  (b as any).call = async (name: string, args: any, _signal?: AbortSignal, before?: () => void) => { before?.(); return raw(name, args); };
  let checks = 0;
  const s = new Safari(b, () => {}, () => { if (++checks > 1) throw Error('retired grant'); });
  await assert.rejects(s.evaluate(target, 'https://example.com/', '1+1'), /retired/);
  assert.equal(b.calls.length, 3); // list_tabs, switch_tab, page_info
  assert.equal(b.calls.filter(c => c.name === 'evaluate_javascript').length, 0);
});
test('upload validates local files and bounds before any transport work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-upload-'));
  const file = join(dir, 'notes.txt'); writeFileSync(file, 'hello upload');
  const b = new Browser(), s = new Safari(b, () => {});
  for (const bad of [[], [file, ...Array(10).fill(file)], ['relative.txt'], ['/does/not/exist.txt'], [dir], [1] as any])
    assert.throws(() => s.upload(target, 'https://example.com/', 'input#f', bad as string[]));
  assert.throws(() => s.upload(target, 'https://example.com/', '', [file]));
  assert.equal(b.calls.length, 0);
  const payload = uploadJS('input#f', 'https://example.com/', [file]);
  assert.ok(payload.includes(Buffer.from('hello upload').toString('base64')));
});

test('upload checks URL, attaches once, and reports the multipart post without retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-upload-'));
  const file = join(dir, 'notes.txt'); writeFileSync(file, 'hello upload');
  const b = new Browser(), s = new Safari(b, () => {});
  b.result = JSON.stringify({ attached: true, submitted: true, files: 1, action: 'https://example.com/upload', status: 200, contentType: 'text/html', body: 'upload-ok' });
  const out = await s.upload(target, 'https://example.com/', 'input#f', [file]);
  assert.equal(out.files, 1); assert.equal(out.submitted, true);
  assert.equal(out.action, 'https://example.com/upload'); assert.equal(out.status, 200); assert.equal(out.response, 'upload-ok');
  assert.match(out.note, /posted once/);
  assert.deepEqual(b.calls.map(c => c.name), ['list_tabs', 'switch_tab', 'page_info', 'evaluate_javascript', 'page_info']);
  b.result = JSON.stringify({ attached: true });
  await assert.rejects(s.upload(target, 'https://example.com/', 'input#f', [file]), /Invalid Safari upload result/);
});

class MediaBrowser extends Browser {
  media: 'screen' | 'print' = 'screen';
  failTool: string | undefined;
  skipSets: number[] = [];
  setCount = 0;
  async call(name: string, args: Record<string, unknown>) {
    if (name === 'set_emulated_media') {
      this.calls.push({ name, args });
      this.setCount++;
      if (!this.skipSets.includes(this.setCount)) this.media = args.media === 'print' ? 'print' : 'screen';
      return { content: [{ type: 'text', text: 'Emulated media set.' }] };
    }
    if (name === 'get_page_content') {
      this.calls.push({ name, args });
      if (this.failTool) throw Error('backend failed');
      return reply({ content: this.media === 'print' ? 'PRINT TREE' : 'SCREEN TREE' });
    }
    if (name === 'evaluate_javascript' && String(args.expression ?? '').includes('matchMedia')) {
      this.calls.push({ name, args });
      return reply(JSON.stringify(this.media));
    }
    return super.call(name, args);
  }
}
test('media snapshot emulates print, captures, and restores before returning', async () => {
  const b = new MediaBrowser();
  const r = await new Safari(b, () => {}).snapshot(target, true, 'print');
  assert.equal(r.text, JSON.stringify({ content: 'PRINT TREE' }));
  assert.equal(b.media, 'screen');
  assert.deepEqual(b.calls.map(c => c.name), ['list_tabs', 'switch_tab', 'evaluate_javascript', 'set_emulated_media', 'evaluate_javascript', 'list_tabs', 'switch_tab', 'page_info', 'get_page_content', 'page_info', 'list_tabs', 'set_emulated_media', 'evaluate_javascript']);
  assert.match(String(b.calls[2].args.expression), /matchMedia\('print'\)/);
  assert.deepEqual(b.calls.filter(c => c.name === 'set_emulated_media').map(c => c.args), [{ media: 'print' }, { media: 'screen' }]);
});
test('media snapshot matching the current media performs no emulation calls', async () => {
  const b = new MediaBrowser(); b.media = 'print';
  const r = await new Safari(b, () => {}).snapshot(target, false, 'print');
  assert.equal(r.text, JSON.stringify({ content: 'PRINT TREE' }));
  assert.equal(b.calls.filter(c => c.name === 'set_emulated_media').length, 0);
  assert.equal(b.calls.filter(c => c.name === 'evaluate_javascript' && String(c.args.expression).includes('matchMedia')).length, 1);
  const b2 = new MediaBrowser();
  await new Safari(b2, () => {}).snapshot(target, false);
  assert.equal(b2.calls.filter(c => c.name === 'set_emulated_media').length, 0);
  assert.deepEqual(b2.calls.map(c => c.name), ['list_tabs', 'switch_tab', 'page_info', 'get_page_content', 'page_info', 'list_tabs']);
});
test('media snapshot restores emulation when capture fails and surfaces the capture error', async () => {
  const b = new MediaBrowser(); b.failTool = 'get_page_content';
  await assert.rejects(new Safari(b, () => {}).snapshot(target, false, 'print'), /backend failed/);
  assert.equal(b.media, 'screen');
  assert.deepEqual(b.calls.filter(c => c.name === 'set_emulated_media').map(c => c.args), [{ media: 'print' }, { media: 'screen' }]);
});
test('media snapshot rejects when emulation does not apply and skips capture', async () => {
  const b = new MediaBrowser(); b.skipSets = [1];
  await assert.rejects(new Safari(b, () => {}).snapshot(target, false, 'print'), /did not switch/);
  assert.equal(b.media, 'screen');
  assert.equal(b.calls.some(c => c.name === 'get_page_content'), false);
});
test('media snapshot surfaces a failed restore instead of leaking print emulation', async () => {
  const b = new MediaBrowser(); b.skipSets = [2];
  await assert.rejects(new Safari(b, () => {}).snapshot(target, false, 'print'), /could not be restored/);
  assert.equal(b.media, 'print');
});

test('upload script requires one enabled file input, decodes bytes, and posts the form multipart once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-upload-'));
  const file = join(dir, 'notes.txt'); writeFileSync(file, 'hello upload');
  const payload = uploadJS('input#f', 'https://example.com/', [file]);
  const made: any[] = [];
  let withForm = true;
  class VmFile { name = ''; type = ''; bytes: any;
    constructor(parts: any[], name: string, opts: any) { this.name = name; this.type = opts && opts.type ? opts.type : ''; this.bytes = parts[0]; } get size() { return this.bytes.length; } }
  class VmDataTransfer { added: any[] = []; items: any;
    constructor() { this.items = { added: this.added, add: (f: any) => this.added.push(f) }; } get files() { return this.added; } }
  class VmEvent { type: string; init: any;
    constructor(type: string, init?: any) { this.type = type; this.init = init; } }
  class VmFormData { map = new Map();
    constructor(form: any) { for (const el of form.elements) this.map.set(el.name, el.type === 'file' ? el.files[0] : el.value); }
    get(name: string) { return this.map.get(name); } }
  class VmInput {
    type = 'file'; multiple = false; disabled = false; name = 'doc';
    files: any[] = []; dispatched: string[] = []; form: any;
    constructor() { made.push(this); this.form = { method: 'post', action: 'https://example.com/upload', elements: [this, { name: 'note', type: 'text', value: 'hello-note' }] }; }
    dispatchEvent(e: any) { this.dispatched.push(e.type); }
    closest(sel: string) { return sel === 'form' && withForm ? this.form : null; }
  }
  let fetched: any;
  const context: any = {
    URL, location: { href: 'https://example.com/' },
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    File: VmFile, DataTransfer: VmDataTransfer, Event: VmEvent, HTMLInputElement: VmInput, FormData: VmFormData,
    document: { querySelectorAll: (sel: string) => { assert.equal(sel, 'input#f'); return [new VmInput()]; } },
    fetch: (url: string, opts: any) => {
      assert.equal(url, 'https://example.com/upload');
      assert.equal(opts.method, 'POST');
      fetched = { url, file: opts.body.get('doc'), note: opts.body.get('note') };
      return Promise.resolve({ status: 200, headers: { get: (k: string) => (k === 'content-type' ? 'text/html' : null) }, text: () => Promise.resolve('upload-ok') });
    },
  };
  const run = (overrides: any = {}) => vm.runInNewContext(payload, { ...context, ...overrides });
  await assert.rejects(run({ location: { href: 'https://changed.example/' } }), /URL changed/);
  await assert.rejects(run({ document: { querySelectorAll: () => [new VmInput(), new VmInput()] } }), /exactly one/);
  const textInput = new VmInput(); textInput.type = 'text';
  await assert.rejects(run({ document: { querySelectorAll: () => [textInput] } }), /type=file/);
  const good = JSON.parse(await run());
  assert.deepEqual(good, { attached: true, submitted: true, files: 1, action: 'https://example.com/upload', status: 200, contentType: 'text/html', body: 'upload-ok' });
  const input = made.at(-1);
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0].name, 'notes.txt');
  assert.equal(input.files[0].type, 'text/plain');
  assert.deepEqual(Buffer.from(input.files[0].bytes), Buffer.from('hello upload'));
  assert.deepEqual(input.dispatched, ['change']);
  assert.equal(fetched.file.size, 12); assert.equal(fetched.file.name, 'notes.txt');
  assert.equal(fetched.note, 'hello-note');
  withForm = false;
  assert.equal((JSON.parse(await run())).submitted, false);
  withForm = true;
  const getForm = new VmInput(); getForm.form = { method: 'get', action: 'https://example.com/' };
  await assert.rejects(run({ document: { querySelectorAll: () => [getForm] } }), /method=post/);
  const second = join(dir, 'more.txt'); writeFileSync(second, 'again');
  await assert.rejects(vm.runInNewContext(uploadJS('input#f', 'https://example.com/', [file, second]), context), /only one file/);
});
