import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Safari, uploadJS } from '../src/safari.ts';
import { webURL, readJS, linkJS, bound } from '../src/extraction.ts';
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
