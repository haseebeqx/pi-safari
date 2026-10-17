import { statSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import { queryJS, waitJS, type Query } from './inspection.ts';
import { searchRequest, searchJS, validateSearch, type SearchOptions } from './search.ts';
import { SafariMCP, toolJSON, type Transport } from './mcp.ts';
import { bound, webURL, readJS, linkJS, readyJS } from './extraction.ts';
export interface Target { targetId: string; epoch: string }
export interface FetchOptions { url: string; selector?: string; text?: string; timeoutMs?: number; maxChars?: number; maxLinks?: number }
export type TabCleanup = { status: 'closed' | 'already-absent' } | { status: 'unidentified' | 'skipped-retired-epoch' | 'failed'; note: string }
const HANDLE = /^[A-Za-z0-9_-]{1,200}$/;
export class Safari {
  private generation = 0;
  private observed = new Map<string, { epoch: string; url: string; text: string }>();
  /** Cached observation only: no permission-time browser probes. Untrusted, potentially stale evidence. */
  permissionContext(t: Target, url: string) {
    const data = this.observed.get(t.targetId);
    return data?.epoch === t.epoch && data.url === url ? data : undefined;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private transport: Transport;
  private authorize: () => void;
  constructor(transport: Transport = new SafariMCP(), authorize: () => void = () => { throw Error('Safari mutation requires explicit session approval.'); }) { this.transport = transport; this.authorize = authorize; }
  close() { this.observed.clear(); this.generation++; this.transport.close(); }
  serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  private operation<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const generation = this.generation;
    return this.serial(async () => {
      if (generation !== this.generation) throw Error('Safari session changed; queued operation cancelled.');
      if (signal?.aborted) throw Error('Safari operation cancelled.');
      const deadline = AbortSignal.timeout(20000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      return fn(combined);
    });
  }
  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    if (signal.aborted) throw Error('Safari deadline/cancellation; inspect tabs before retrying an open.');
    return toolJSON(await this.transport.call(name, args, signal));
  }
  private mutate(name: string, args: Record<string, unknown>, signal: AbortSignal, infrastructure = false) {
    if (!infrastructure) this.authorize();
    const epoch = this.transport.epoch;
    return this.transport.call(name, args, signal, () => {
      if (!infrastructure) this.authorize();
      if (epoch !== this.transport.epoch) throw Error('Safari connection changed before action; relist targets. Action not replayed.');
    });
  }
  private async list(signal: AbortSignal): Promise<{ handle: string; url?: string; title?: string }[]> {
    const tabs = await this.call('list_tabs', {}, signal);
    if (!Array.isArray(tabs) || tabs.some(t => !t || typeof t.handle !== 'string' || !HANDLE.test(t.handle) || (t.url !== undefined && typeof t.url !== 'string') || (t.title !== undefined && typeof t.title !== 'string')) || new Set(tabs.map(t => t.handle)).size !== tabs.length) throw Error('Invalid Safari tab list.');
    return tabs;
  }
  private target(t: Target) {
    if (typeof t?.targetId !== 'string' || !HANDLE.test(t.targetId) || typeof t.epoch !== 'string' || t.epoch !== this.transport.epoch) throw Error('Invalid or stale Safari target; use targetId and epoch from safari_tabs/open.');
  }
  private async select(t: Target, signal: AbortSignal, approval = false) {
    this.target(t);
    if (!(await this.list(signal)).some(tab => tab.handle === t.targetId)) throw Error('Safari target closed or unavailable; relist tabs.');
    this.target(t); // A reconnect invalidates the old epoch even if a handle is reused.
    // Safari returns a plain-text acknowledgement for switch_tab.
    // The transport still validates its envelope and isError flag.
    if (approval) this.authorize();
    await (approval ? this.mutate('switch_tab', { handle: t.targetId }, signal) : this.transport.call('switch_tab', { handle: t.targetId }, signal));
    this.target(t);
  }
  private async closeTarget(t: Target, signal: AbortSignal) {
    this.target(t);
    const exists = (await this.list(signal)).some(tab => tab.handle === t.targetId);
    this.target(t);
    if (!exists) return { status: 'already-absent' as const };
    if (signal.aborted) throw Error('Safari close cancelled.');
    // Apple's close_tab takes a handle and returns an acknowledgement, not JSON.
    await this.mutate('close_tab', { handle: t.targetId }, signal, true);
    this.target(t);
    return { status: 'closed' as const };
  }
  closeTab(t: Target, signal?: AbortSignal) {
    return this.operation(s => this.closeTarget(t, s), signal);
  }
  private async cleanup(t?: Target): Promise<TabCleanup> {
    if (!t) return { status: 'unidentified', note: 'No identified created tab; inspect tabs before retrying.' };
    if (t.epoch !== this.transport.epoch) return { status: 'skipped-retired-epoch', note: 'Connection retired; relist tabs for manual cleanup.' };
    try {
      // Bounded cleanup may finish after cancellation, but never reconnects a retired target.
      return await this.closeTarget(t, AbortSignal.timeout(3000));
    } catch {
      return { status: 'failed', note: 'Cleanup unconfirmed; relist tabs before manual cleanup or retrying.' };
    }
  }
  // One closed new-tab pipeline: create, bounded work, then cleanup on every path.
  // Work must use unwrapped private methods only (create/observe/cleanup), never other operations.
  private async withTab<T extends object>(url: string, label: string, signal: AbortSignal, work: (tab: Target) => Promise<T>): Promise<T & { cleanup: TabCleanup }> {
    let created: Target | undefined;
    let result: T;
    try {
      const tab = await this.create(url, signal, t => { created = t; });
      result = await work(tab);
      if (signal.aborted) throw Error(`${label} cancelled.`);
    } catch (error) {
      const cleanup = await this.cleanup(created);
      const failure = new Error(`${error instanceof Error ? error.message : `${label} failed.`} ${label} cleanup: ${cleanup.status}.${'note' in cleanup ? ` ${cleanup.note}` : ''}`, { cause: error });
      Object.assign(failure, { cleanup });
      throw failure;
    }
    const cleanup = await this.cleanup(created);
    if (signal.aborted) {
      const failure = new Error(`${label} cancelled. ${label} cleanup: ${cleanup.status}.`);
      Object.assign(failure, { cleanup });
      throw failure;
    }
    return { ...result, cleanup };
  }
  private async evaluate(expression: string, signal: AbortSignal): Promise<any> {
    const value = await this.call('evaluate_javascript', { expression: `return (${expression});` }, signal);
    if (typeof value !== 'string') throw Error('Unexpected Safari extraction result.');
    try { return JSON.parse(value); } catch { throw Error('Invalid Safari extraction JSON.'); }
  }
  tabs(signal?: AbortSignal) {
    return this.operation(async s => {
      const tabs = await this.list(s);
      const result = { tabs: tabs.slice(0, 100).map(t => ({ targetId: t.handle, epoch: this.transport.epoch, ...(t.url === undefined ? {} : { url: t.url.slice(0, 2048) }), ...(t.title === undefined ? {} : { title: t.title.slice(0, 300) }) })), truncated: tabs.length > 100 };
      bound(result); return result;
    }, signal);
  }
  private async create(url: string, signal: AbortSignal, identified?: (t: Target) => void) {
    // New-tab read infrastructure only; never exposes arbitrary close/navigation/interaction.
    const normalized = webURL(url);
    const epoch = this.transport.epoch;
    const created = toolJSON(await this.mutate('create_tab', { url: normalized }, signal, true));
    if (typeof created?.handle !== 'string' || !HANDLE.test(created.handle)) throw Error('Cannot identify created tab; inspect tabs before retrying.');
    const t = { targetId: created.handle, epoch };
    identified?.(t);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await this.select(t, signal);
      const info = await this.call('page_info', {}, signal);
      if (typeof info?.url !== 'string') throw Error('Invalid Safari page info.');
      if (info.url !== normalized && info.url !== 'about:blank') throw Error('Redirect or URL rewrite rejected; tab left open. Inspect tabs before retrying.');
      if (info.url === normalized) {
        const ready = await this.call('evaluate_javascript', { expression: `return (${readyJS(normalized)});` }, signal);
        if (ready === true) { this.target(t); return { ...t, url: normalized, note: 'New automation tab. No ownership or document identity guarantee. Tab left open.' }; }
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(Error('Safari operation cancelled; tab may remain open.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 200);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw Error('Requested URL did not become ready; tab left open. Inspect tabs before retrying.');
  }
  open(url: string, signal?: AbortSignal) { webURL(url); return this.operation(s => this.create(url, s), signal); }
  private async readData(t: Target, chars: number, links: number, signal: AbortSignal) {
    const { data, url } = await this.observe(t, readJS(chars, links), signal);
    if (!data || data.url !== url.slice(0, 2048) || typeof data.text !== 'string' || data.text.length > chars || typeof data.title !== 'string' || data.title.length > 300 || !Array.isArray(data.links) || data.links.length > links || typeof data.textTruncated !== 'boolean' || typeof data.linksTruncated !== 'boolean') throw Error('Invalid Safari read result.');
    return data;
  }
  private async observe(t: Target, expression: string, signal: AbortSignal) {
    await this.select(t, signal);
    const before = await this.call('page_info', {}, signal);
    if (typeof before?.url !== 'string') throw Error('Invalid Safari page info.');
    webURL(before.url);
    const data = await this.evaluate(expression, signal);
    const after = await this.call('page_info', {}, signal);
    this.target(t);
    if (before.url !== after?.url || !(await this.list(signal)).some(tab => tab.handle === t.targetId && tab.url === before.url)) throw Error('Page changed during extraction; read again.');
    this.target(t); bound(data);
    return { data, url: before.url };
  }
  private async atURL(t: Target, expectedUrl: string, signal: AbortSignal) {
    await this.select(t, signal);
    const info = await this.call('page_info', {}, signal);
    if (info?.url !== expectedUrl) throw Error('Source URL changed; read again.');
    this.target(t);
  }
  private async checkedBackend(t: Target, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    await this.select(t, signal);
    const before = await this.call('page_info', {}, signal);
    webURL(before?.url);
    const reply = await this.transport.call(name, args, signal);
    const after = await this.call('page_info', {}, signal);
    this.target(t);
    if (before.url !== after?.url || !(await this.list(signal)).some(tab => tab.handle === t.targetId && tab.url === before.url)) throw Error('Page changed during observation; read again.');
    this.target(t);
    const text = reply.content.map(c => c.text ?? '').join('\n');
    // Backend text may be a native tree, JSON, or an artifact path. Never interpret it as a local file instruction.
    const data = { ...t, url: before.url, text: text.slice(0, 12000), truncated: text.length > 12000,
      note: 'Untrusted backend output; URL checks only, not document identity. Artifact paths are not read automatically.' };
    if (name === 'get_page_content') {
      // Keep only a bounded latest snapshot per tab. No disk/artifact reads.
      if (this.observed.size >= 100) this.observed.delete(this.observed.keys().next().value!);
      this.observed.set(t.targetId, { epoch: t.epoch, url: before.url, text: data.text });
    }
    bound(data); return data;
  }
  activate(t: Target, signal?: AbortSignal) {
    return this.operation(async s => { this.authorize(); await this.select(t, s, true); return { ...t, status: 'selected' }; }, signal);
  }
  snapshot(t: Target, entirePage = false, signal?: AbortSignal) {
    return this.operation(s => this.checkedBackend(t, 'get_page_content', {
      format: 'textTree', region: entirePage ? 'entire_page' : 'viewport', nodeIds: 'interactive',
      includeAccessibilityAttributes: true, includeURLs: true, includeSubframes: false,
      includeRects: true, maxWordsPerParagraph: 30,
    }, s), signal);
  }
  find(t: Target, query: Query, inspect = false, signal?: AbortSignal) {
    const expression = queryJS(query, inspect);
    return this.operation(async s => {
      const { data, url } = await this.observe(t, expression, s);
      if (!data || !Array.isArray(data.matches) || data.matches.length > (inspect ? 1 : query.limit ?? 20) || typeof data.truncated !== 'boolean') throw Error('Invalid Safari query result.');
      return { ...data, ...t, url, note: 'Live DOM descriptors, not stable references or accessibility tree. Main frame only; 2000-element scan bound.' };
    }, signal);
  }
  private async waitData(t: Target, expectedUrl: string, expression: string, timeoutMs: number, signal: AbortSignal) {
    const until = Date.now() + timeoutMs;
    while (true) {
      const { data, url } = await this.observe(t, expression, signal);
      if (url !== expectedUrl || typeof data?.matched !== 'boolean') throw Error('Invalid Safari wait result.');
      if (data.matched) return { ...t, url, matched: true };
      if (Date.now() >= until) throw Error('Safari wait timed out; no visible match within scan bound.');
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(Error('Safari wait cancelled.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(200, until - Date.now()));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
  }
  wait(t: Target, expectedUrl: string, query: Query, timeoutMs = 5000, signal?: AbortSignal) {
    const expression = waitJS(query, expectedUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000) throw Error('timeoutMs must be 0..10000.');
    return this.operation(s => this.waitData(t, expectedUrl, expression, timeoutMs, s), signal);
  }
  screenshot(t: Target, fullPage = false, signal?: AbortSignal) {
    return this.operation(s => this.checkedBackend(t, 'screenshot', { full_page: fullPage }, s), signal);
  }
  console(t: Target, limit = 100, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('limit must be 1..100.');
    return this.operation(s => this.checkedBackend(t, 'browser_console_messages', { tab_handle: t.targetId, clear: false, limit }, s), signal);
  }
  network(t: Target, urlSubstring = '', signal?: AbortSignal) {
    if (typeof urlSubstring !== 'string' || urlSubstring.length > 500) throw Error('urlSubstring must be at most 500 characters.');
    return this.operation(s => this.checkedBackend(t, 'list_network_requests', { tab_handle: t.targetId, clear: false, filter: { url_substring: urlSubstring } }, s), signal);
  }
  navigate(t: Target, expectedUrl: string, url: string, signal?: AbortSignal) {
    webURL(expectedUrl); const destination = webURL(url);
    return this.operation(async s => {
      this.authorize(); await this.atURL(t, expectedUrl, s); this.authorize();
      this.observed.delete(t.targetId);
      await this.mutate('navigate_to_url', { tab_uuid: t.targetId, url: destination }, s);
      this.target(t);
      const info = await this.call('page_info', {}, s);
      if (info?.url !== destination) throw Error('Navigation changed URL or redirected; navigation may already have occurred. Inspect tabs; do not replay.');
      if (!(await this.list(s)).some(tab => tab.handle === t.targetId && tab.url === destination)) throw Error('Navigation target changed; inspect tabs, do not replay.');
      this.target(t); return { ...t, url: destination, note: 'Navigation sent once. URL checks only, not document identity.' };
    }, signal);
  }
  interact(t: Target, expectedUrl: string, action: Interaction, signal?: AbortSignal) {
    webURL(expectedUrl); validateInteraction(action);
    return this.operation(async s => {
      const permissionFree = action.type === 'scroll';
      if (!permissionFree) this.authorize();
      await this.atURL(t, expectedUrl, s);
      if (!permissionFree) this.authorize();
      // Exactly one action per call. Never retry after a timeout or navigation.
      await this.mutate('page_interactions', { interactions: [action] }, s, permissionFree);
      const info = await this.call('page_info', {}, s); this.target(t);
      if (typeof info?.url !== 'string' || !(await this.list(s)).some(tab => tab.handle === t.targetId && tab.url === info.url)) throw Error('Interaction context changed; inspect tabs, do not replay.');
      this.target(t);
      return { ...t, url: info.url.slice(0, 8192), note: 'Action sent once; may navigate or submit. Inspect before any retry. UID can be stale even at the same URL.' };
    }, signal);
  }
  upload(t: Target, expectedUrl: string, selector: string, paths: string[], signal?: AbortSignal) {
    const expression = uploadJS(selector, expectedUrl, paths); // Validate and read files before any transport work.
    return this.operation(async s => {
      this.authorize();
      await this.atURL(t, expectedUrl, s);
      this.authorize();
      const data = await this.evaluate(expression, s);
      if (!data || typeof data !== 'object' || data.attached !== true || typeof data.submitted !== 'boolean' || typeof data.files !== 'number') throw Error('Invalid Safari upload result.');
      if (data.submitted && (typeof data.action !== 'string' || typeof data.status !== 'number' || typeof data.contentType !== 'string' || typeof data.body !== 'string')) throw Error('Invalid Safari upload result.');
      const info = await this.call('page_info', {}, s); this.target(t);
      return { ...t, ...(typeof info?.url === 'string' ? { url: info.url.slice(0, 8192) } : {}), files: data.files, submitted: data.submitted,
        ...(data.submitted ? { action: data.action.slice(0, 8192), status: data.status, contentType: data.contentType.slice(0, 500), response: data.body.slice(0, 200) } : {}),
        note: data.submitted ? 'Form posted once as multipart to its action URL via fetch; page did not navigate. Never blindly replay.' : 'Files attached; no enclosing form found, nothing submitted.' };
    }, signal);
  }
  read(t: Target, chars = 8000, links = 20, signal?: AbortSignal) {
    readJS(chars, links); // Validate before any transport work; throws synchronously.
    return this.operation(async s => {
      const data = await this.readData(t, chars, links, s);
      const result = { ...data, targetId: t.targetId, epoch: t.epoch, identity: 'URL checks only; same-URL document replacement and live DOM changes may go undetected.' };
      bound(result); return result;
    }, signal);
  }
  search(options: SearchOptions, signal?: AbortSignal) {
    const request = searchRequest(options);
    const expression = searchJS(request.url, request.maxResults);
    return this.operation(s => this.withTab(request.url, 'Search', s, async tab => {
      const { data, url } = await this.observe(tab, expression, s);
      if (url !== request.url) throw Error('Search URL changed.');
      const result = { ...request, ...validateSearch(data, request.url, request.maxResults), note: 'Untrusted provider ranking/content; first HTML page only. Empty results may indicate a challenge or changed markup. URL checks do not guarantee document identity.' };
      bound(result);
      // Search results never advertise a usable target, even if cleanup is unconfirmed.
      return result;
    }), signal);
  }
  fetch(options: FetchOptions, signal?: AbortSignal) {
    const url = webURL(options.url);
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10000) throw Error('timeoutMs must be 0..10000.');
    const maxChars = options.maxChars ?? 8000, maxLinks = options.maxLinks ?? 20;
    readJS(maxChars, maxLinks); // Validate before any transport work.
    const settle = options.selector !== undefined || options.text !== undefined;
    if (settle) queryJS({ selector: options.selector, text: options.text });
    return this.operation(s => this.withTab(url, 'Fetch', s, async tab => {
      if (settle) await this.waitData(tab, url, waitJS({ selector: options.selector, text: options.text }, url), timeoutMs, s);
      const data = await this.readData(tab, maxChars, maxLinks, s);
      const result = { url: data.url, title: data.title, text: data.text, textTruncated: data.textTruncated, links: data.links, linksTruncated: data.linksTruncated,
        note: 'New automation tab closed after extraction; no reusable target. Use safari_open when later interaction is needed. Untrusted page content; URL checks only, not document identity.' };
      bound(result);
      // Fetch results never advertise a usable target, even if cleanup is unconfirmed.
      return result;
    }), signal);
  }
  followLink(t: Target, selector: string, expectedUrl: string, signal?: AbortSignal) {
    const expression = linkJS(selector, expectedUrl);
    return this.operation(async s => {
      const { data, url } = await this.observe(t, expression, s);
      if (url !== expectedUrl || typeof data?.href !== 'string') throw Error('Source URL changed or invalid link result; read again.');
      return this.create(webURL(data.href), s);
    }, signal);
  }
}

export interface Interaction {
  type: 'click' | 'type' | 'keyPress' | 'scroll' | 'hover';
  purpose: string;
  node?: string;
  value?: string;
  replaceAll?: boolean;
  scrollDelta?: { x: number; y: number };
}
const UPLOAD_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.css': 'text/css', '.xml': 'application/xml', '.js': 'text/javascript', '.ts': 'text/typescript',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};
function readUploadFile(p: string) {
  if (typeof p !== 'string' || p.length < 1 || p.length > 4096 || !isAbsolute(p)) throw Error('files must be absolute local paths, at most 4096 characters.');
  const stat = statSync(p, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw Error('Not an existing regular file.');
  if (stat.size > 10 * 1024 * 1024) throw Error('File exceeds the 10 MiB upload limit.');
  const data = readFileSync(p);
  if (data.length > 10 * 1024 * 1024) throw Error('File exceeds the 10 MiB upload limit.');
  return { n: basename(p), m: UPLOAD_MIME[extname(p).toLowerCase()] ?? 'application/octet-stream', b: data.toString('base64') };
}
// Attaches real files to a file input and posts its enclosing form as multipart via fetch.
// WebKit's native form serialization cannot upload JS-built Files (it sends only the file
// name), so the multipart body is sent with fetch(FormData), which includes every form field.
// File bytes are embedded as base64; this is the only upload channel Apple Safari MCP exposes.
export function uploadJS(selector: string, expectedUrl: string, paths: string[]): string {
  if (typeof selector !== 'string' || selector.length < 1 || selector.length > 500) throw Error('CSS selector must be 1..500 characters.');
  webURL(expectedUrl);
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 10) throw Error('files must contain 1..10 absolute paths.');
  const files = paths.map(readUploadFile);
  return `((async()=>{
if(location.href!==${JSON.stringify(expectedUrl)})throw Error('Page URL changed; read again');
const es=document.querySelectorAll(${JSON.stringify(selector)});
if(es.length!==1)throw Error('Selector must match exactly one element');
const input=es[0];
if(!(input instanceof HTMLInputElement)||input.type!=='file')throw Error('Selector must match an <input type=file>');
if(input.disabled)throw Error('File input is disabled');
if(!input.multiple&&${files.length}>1)throw Error('Input accepts only one file');
const dt=new DataTransfer();
for(const f of ${JSON.stringify(files)}){const bin=atob(f.b);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);dt.items.add(new File([bytes],f.n,{type:f.m}))}
input.files=dt.files;
input.dispatchEvent(new Event('change',{bubbles:true}));
const form=input.closest('form');
if(!form)return JSON.stringify({attached:true,submitted:false,files:${files.length}});
if((form.method||'get').toLowerCase()!=='post')throw Error('Form must use method=post for file upload');
const fd=new FormData(form);
const res=await fetch(form.action,{method:'POST',body:fd});
const text=await res.text();
return JSON.stringify({attached:true,submitted:true,files:${files.length},action:form.action,status:res.status,contentType:res.headers.get('content-type')||'',body:text.slice(0,200)})
})())`;
}
export function validateInteraction(a: Interaction) {
  if (!a || !['click', 'type', 'keyPress', 'scroll', 'hover'].includes(a.type) || typeof a.purpose !== 'string' || !a.purpose.length || a.purpose.length > 300) throw Error('Invalid interaction type or purpose.');
  if (Object.keys(a).some(k => !['type','purpose','node','value','replaceAll','scrollDelta'].includes(k))) throw Error('Unknown interaction field.');
  if (a.node !== undefined && (typeof a.node !== 'string' || !/^[0-9]{1,20}$/.test(a.node))) throw Error('node must be a numeric UID from safari_snapshot.');
  if (['click','type','hover'].includes(a.type) && !a.node) throw Error('This action requires a snapshot node UID.');
  if (['type','keyPress'].includes(a.type) && (typeof a.value !== 'string' || a.value.length > 4000 || (a.type === 'keyPress' && (!a.value.length || a.value.length > 100)))) throw Error('Invalid interaction value.');
  if (a.value !== undefined && !['type','keyPress'].includes(a.type)) throw Error('value only applies to type/keyPress.');
  if (a.replaceAll !== undefined && (a.type !== 'type' || typeof a.replaceAll !== 'boolean')) throw Error('replaceAll only applies to type.');
  if (a.scrollDelta !== undefined && (a.type !== 'scroll' || !a.scrollDelta || Object.keys(a.scrollDelta).some(k => !['x','y'].includes(k)) || ![a.scrollDelta.x,a.scrollDelta.y].every(n => Number.isFinite(n) && Math.abs(n) <= 10000))) throw Error('Invalid scroll delta.');
  if (a.type === 'scroll' && !a.scrollDelta) throw Error('scroll requires scrollDelta.');
}
