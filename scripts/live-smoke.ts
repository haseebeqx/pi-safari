// Explicitly opt-in. Uses only freshly created automation tabs and loopback fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, lstat, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Safari, type Target, type Interaction } from '../src/safari.ts';
import { SafariMCP, toolJSON, type Transport } from '../src/mcp.ts';
import { searchRequest } from '../src/search.ts';

if (!process.argv.includes('--run')) throw Error('Opt in with npm run test:live -- --run (opens disposable Safari automation tabs).');
const results: { name: string; status: string; detail?: unknown }[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  try { const detail = await fn(); results.push({ name, status: 'PASS', detail }); }
  catch (e) { results.push({ name, status: 'FAIL', detail: String(e) }); }
  console.log(JSON.stringify(results.at(-1)));
}
const fixture = `<!doctype html><meta charset="utf-8"><title>Pi Safari disposable fixture</title>
<style>body{font:18px sans-serif}button,input,a{display:block;margin:12px}#spacer{height:2400px}</style>
<h1>Safari fixture ready</h1><a id="next" href="/next">Fixture next</a>
<form id="up" action="/upload" method="post"><input id="file" type="file" name="doc"></form>
<button id="click">Fixture click</button><input id="input" aria-label="Fixture input" value="seed">
<button id="hover">Fixture hover</button><output id="state">initial</output><div id="spacer"></div><p>Bottom marker</p>
<script>
const out=document.querySelector('#state'), input=document.querySelector('#input');
function state(s){out.textContent=s}
document.querySelector('#click').onclick=()=>{state('clicked');fetch('/probe?clicked')};
document.querySelector('#hover').onmouseenter=()=>state('hovered');
input.oninput=()=>state('input:'+input.value);
input.onkeydown=e=>{if(e.key==='Enter')state('key:Enter')};
onscroll=()=>{document.body.dataset.scrolled='yes';state('scrolled:'+Math.round(scrollY))};
setTimeout(()=>{const p=document.createElement('p');p.id='delayed';p.textContent='Delayed marker';document.body.prepend(p)},600);
console.log('pi-safari-fixture-console');fetch('/probe').then(r=>r.text()).then(()=>console.log('pi-safari-fixture-fetch'));
</script>`;
let upload: { type: string; body: string } | undefined;
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && req.url?.startsWith('/upload')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { upload = { type: String(req.headers['content-type'] ?? ''), body }; res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>uploaded</title><p>upload-ok</p>'); });
    return;
  }
  if (req.url?.startsWith('/dialog-prompt')) {
    res.end(`<!doctype html><title>dialog-prompt</title><h1>dialog fixture</h1><output id="state">initial</output><script>var v=prompt("Fixture prompt","dflt");document.querySelector('#state').textContent='prompt:'+v</script>`);
    return;
  }
  if (req.url?.startsWith('/dialog-confirm')) {
    res.end(`<!doctype html><title>dialog-confirm</title><h1>dialog fixture</h1><output id="state">initial</output><script>var v=confirm("Fixture confirm");document.querySelector('#state').textContent='confirm:'+v</script>`);
    return;
  }
  res.setHeader('Content-Type', req.url?.startsWith('/probe') ? 'text/plain' : 'text/html'); res.end(req.url?.startsWith('/probe') ? 'probe-ok' : fixture);
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const address = server.address(); assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const urls = new Set([base + '/', base + '/next', base + '/navigated', base + '/dialog-prompt', base + '/dialog-confirm']);
const search = { query: 'Safari web browser', maxResults: 3 };
const searchURL = searchRequest(search).url;
const owned = new Map<string, Target>(); const createdURLs = new Map<string, string>(); let selected: string | undefined; let backend: unknown;
const native = new SafariMCP({ spawn: ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args); let buffer = '';
  child.stdout?.on('data', chunk => { buffer += chunk.toString(); let end: number; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0,end); buffer = buffer.slice(end+1); try { const m = JSON.parse(line); if (m.result?.serverInfo) backend = m.result.serverInfo; } catch {} } });
  return child;
}) as typeof spawn });
// Test-only authorizer injection does not alter production approval. Guard every dispatch
// as well, so accidental selection/closure of pre-existing tabs is impossible.
const guarded: Transport = {
  get epoch() { return native.epoch; }, close() { native.close(); },
  async call(name, args, signal, beforeSend) {
    const guard = () => {
      beforeSend?.();
      if (name === 'create_tab') assert(urls.has(String(args.url)) || args.url === searchURL, 'URL outside fixture/search');
      else if (name !== 'list_tabs') {
        const id = String(args.handle ?? args.tab_uuid ?? args.tab_handle ?? selected);
        assert(owned.get(id)?.epoch === native.epoch, 'Not a fresh identified tab in current epoch');
        if (name === 'navigate_to_url') assert(urls.has(String(args.url)), 'Navigation outside fixture');
        if (name === 'navigate_to_url' || name === 'page_interactions') assert(urls.has(createdURLs.get(id) ?? ''), 'Mutations only on fixture tabs');
      }
    };
    const reply = await native.call(name, args, signal, guard);
    if (name === 'create_tab') { const data = toolJSON(reply); assert.equal(typeof data.handle, 'string'); owned.set(data.handle, { targetId: data.handle, epoch: native.epoch }); createdURLs.set(data.handle, String(args.url)); selected = data.handle; }
    if (name === 'switch_tab') selected = String(args.handle);
    if (name === 'close_tab') owned.delete(String(args.handle));
    return reply;
  }
};
const safari = new Safari(guarded, () => {});
let tab: Target | undefined;
async function mainTab() { assert(tab, 'open prerequisite failed'); return tab; }
async function state(expected: string) { const r = await safari.find(await mainTab(), { selector: '#state' }, true); assert.match(r.matches[0].name, new RegExp(expected)); return r.matches[0].name; }
async function node(label: string) {
  const r = await safari.snapshot(await mainTab(), true);
  const tree = JSON.parse(r.text).content as string;
  const line = tree.split('\n').find(l => l.includes(label)); assert(line, `No snapshot line for ${label}`);
  const uid = line.match(/(?:uid[= :"']+|\[)(\d+)/i)?.[1]; assert(uid, `No numeric UID in ${line}`); return uid;
}
async function action(a: Interaction) { return safari.interact(await mainTab(), base + '/', a); }
try {
  await check('tabs', async () => { const r = await safari.tabs(); return { count: r.tabs.length, backend }; });
  await check('open', async () => { tab = await safari.open(base + '/'); return tab; });
  await check('read', async () => { const r = await safari.read(await mainTab()); assert.match(r.text, /Safari fixture ready/); assert(r.links.some((l: {href: string}) => l.href === base + '/next')); return { title: r.title }; });
  await check('activate', async () => { const other = await safari.open(base + '/next'); const r = await safari.activate(await mainTab()); assert.equal(r.status, 'selected'); assert.equal(toolJSON(await guarded.call('page_info', {})).url, base + '/'); await safari.closeTab(other); return 'Selected original fixture instead of second disposable tab'; });
  await check('snapshot', async () => { const r = await safari.snapshot(await mainTab(), true); assert.match(r.text, /Fixture click/); return r.text; });
  await check('find', async () => { const r = await safari.find(await mainTab(), { selector: 'button' }); assert.equal(r.matches.length, 2); return r.matches.map((m: {id:string}) => m.id); });
  await check('inspect', async () => { const r = await safari.find(await mainTab(), { selector: '#input' }, true); assert.equal(r.matches[0].tag, 'input'); return r.matches[0]; });
  await check('wait', async () => { const r = await safari.wait(await mainTab(), base + '/', { selector: '#delayed' }); assert(r.matched); await assert.rejects(safari.wait(await mainTab(), base + '/', { selector: '#absent' }, 0), /timed out/); return r; });
  await check('network.prime', async () => { return (await safari.network(await mainTab(), '/probe')).text; });
  await check('interact.click', async () => { await action({ type:'click', purpose:'Click local fixture only', node:await node('Fixture click') }); return state('^clicked$'); });
  await check('interact.type/fill', async () => { await action({ type:'type', purpose:'Fill local fixture only', node:await node('Fixture input'), value:'fixture-filled', replaceAll:true }); return state('^input:fixture-filled$'); });
  await check('interact.type/append', async () => { await action({ type:'type', purpose:'Append local fixture only', node:await node('Fixture input'), value:'-tail', replaceAll:false }); return state('^input:fixture-filled-tail$'); });
  await check('interact.key', async () => { await action({ type:'keyPress', purpose:'Enter in local non-form fixture', value:'Enter' }); return state('^key:Enter$'); });
  await check('interact.hover', async () => { await action({ type:'hover', purpose:'Hover local fixture', node:await node('Fixture hover') }); return state('^hovered$'); });
  await check('interact.scroll', async () => { await action({ type:'scroll', purpose:'Scroll local fixture', scrollDelta:{x:0,y:500} }); await new Promise(r=>setTimeout(r,300)); return state('^scrolled:[1-9]'); });
  await check('console', async () => { const r = await safari.console(await mainTab()); assert.match(r.text, /pi-safari-fixture-console/); return r.text; });
  await check('network', async () => { const r = await safari.network(await mainTab(), '/probe'); assert.match(r.text, /\/probe/); return r.text; });
  await check('screenshot', async () => { const r = await safari.screenshot(await mainTab()); console.log(JSON.stringify({ screenshot:r.text })); const path = r.text.match(/(?:\/[^\n"']+\.(?:png|jpg|jpeg))/i)?.[0]; assert(path, 'No screenshot artifact path'); assert.match(path, /^\/var\/folders\/[^\n]+\/T\/com\.apple\.WebDriver\/safari-mcp-[A-F0-9-]+\.png$/i, 'Unexpected artifact location'); const info = await lstat(path); assert(info.isFile() && info.size > 8); const bytes = await readFile(path); assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(0,3).equals(Buffer.from([255,216,255])), 'Not PNG/JPEG'); return { path, bytes:info.size }; });
  await check('screenshot.fullPage', async () => { const r = await safari.screenshot(await mainTab(), true); const path = r.text.match(/\/var\/folders\/[^\n"']+\/T\/com\.apple\.WebDriver\/safari-mcp-[A-F0-9-]+\.png/i)?.[0]; assert(path); const info = await lstat(path); assert(info.isFile()); const bytes = await readFile(path); assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))); const height = bytes.readUInt32BE(20); assert(height > 2000, 'Full page should include tall fixture'); return { path, bytes:info.size, width:bytes.readUInt32BE(16), height }; });
  await check('follow', async () => { const followed = await safari.followLink(await mainTab(), '#next', base+'/'); const r = await safari.read(followed); assert.equal(r.url, base+'/next'); assert.equal((await safari.read(await mainTab())).url, base+'/'); return followed; });
  await check('navigate', async () => { const r = await safari.navigate(await mainTab(), base+'/', base+'/navigated'); assert.equal((await safari.read(await mainTab())).url, base+'/navigated'); return r; });
  await check('upload', async () => {
    const file = join(tmpdir(), `pi-safari-live-upload-${Date.now()}.txt`);
    writeFileSync(file, 'pi-safari live upload bytes');
    try {
      // Runs on the navigated fixture page (same document, form present). The post goes
      // to the loopback /upload endpoint via fetch and the page does not navigate.
      const r = await safari.upload(await mainTab(), base + '/navigated', '#file', [file]);
      assert.equal(r.submitted, true); assert.equal(r.files, 1);
      assert.equal(r.action, base + '/upload'); assert.equal(r.status, 200);
      for (let i = 0; i < 30 && !upload; i++) await new Promise(res => setTimeout(res, 100));
      assert(upload, 'No multipart request received');
      assert.match(upload.type, /^multipart\/form-data/);
      assert.ok(upload.body.includes('name="doc"') && upload.body.includes('pi-safari live upload bytes'), 'File content missing from multipart body');
      return { submitted: r.submitted, status: r.status, bytes: upload.body.length };
    } finally { await rm(file, { force: true }); }
  });
  await check('close', async () => { const t = await mainTab(); assert.equal((await safari.closeTab(t)).status, 'closed'); assert(!(await safari.tabs()).tabs.some(x=>x.targetId===t.targetId)); return 'confirmed absent'; });
  await check('search', async () => { const r = await safari.search(search); assert.equal(r.cleanup.status, 'closed'); assert(r.results.length > 0, 'Provider returned no results (challenge/markup/network possible)'); return r; });
  await check('dialog.open-fails-fast', async () => {
    const started = Date.now();
    await assert.rejects(safari.open(base + '/dialog-prompt'), /modal JavaScript dialog/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, `Did not fail fast before the transport deadline (${elapsed}ms)`);
    return { elapsed };
  });
  await check('dialog.list+respond', async () => {
    const t = (await safari.tabs()).tabs.find(x => x.url === base + '/dialog-prompt'); assert(t, 'dialog tab was not left open');
    const listed = await safari.dialog(t, 'list');
    assert.equal(listed.dialogs.length, 1); assert.match(listed.dialogs[0].message, /Fixture prompt/);
    const responded = await safari.dialog(t, 'respond', 'smoke');
    assert.deepEqual(responded.dialogs, []);
    const r = await safari.find(t, { selector: '#state' }, true);
    assert.match(r.matches[0].name, /prompt:smoke/);
    await safari.closeTab(t); return r.matches[0].name;
  });
  await check('dialog.dismiss', async () => {
    await assert.rejects(safari.open(base + '/dialog-confirm'), /modal JavaScript dialog/);
    const t = (await safari.tabs()).tabs.find(x => x.url === base + '/dialog-confirm'); assert(t, 'confirm tab was not left open');
    const r = await safari.dialog(t, 'dismiss');
    assert.deepEqual(r.dialogs, []);
    const state = await safari.find(t, { selector: '#state' }, true);
    assert.match(state.matches[0].name, /confirm:false/);
    await safari.closeTab(t); return state.matches[0].name;
  });
  await check('dialog.none-pending', async () => { const t = await safari.open(base + '/next'); await assert.rejects(safari.dialog(t, 'respond'), /No pending dialog/); await safari.closeTab(t); return 'no dialog'; });
} finally {
  for (const t of [...owned.values()]) await check('cleanup:'+t.targetId, async () => { const r = await safari.closeTab(t); assert(!(await safari.tabs()).tabs.some(x=>x.targetId===t.targetId)); return r; });
  safari.close(); await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));
  console.log(JSON.stringify({ backend, results }, null, 2));
  if (results.some(r=>r.status === 'FAIL')) process.exitCode = 1;
}
