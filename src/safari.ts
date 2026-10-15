import { searchRequest, searchJS, validateSearch, type SearchOptions } from './search.ts';
import { SafariMCP, toolJSON, type Transport } from './mcp.ts';
import { bound, webURL, readJS, linkJS, readyJS } from './extraction.ts';
export interface Target { targetId: string; epoch: string }
const HANDLE = /^[A-Za-z0-9_-]{1,200}$/;
export class Safari {
  private queue: Promise<unknown> = Promise.resolve();
  private transport: Transport;
  constructor(transport: Transport = new SafariMCP()) { this.transport = transport; }
  close() { this.transport.close(); }
  serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  private operation<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.serial(async () => {
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
  private async list(signal: AbortSignal): Promise<{ handle: string; url?: string; title?: string }[]> {
    const tabs = await this.call('list_tabs', {}, signal);
    if (!Array.isArray(tabs) || tabs.some(t => !t || typeof t.handle !== 'string' || !HANDLE.test(t.handle) || (t.url !== undefined && typeof t.url !== 'string') || (t.title !== undefined && typeof t.title !== 'string')) || new Set(tabs.map(t => t.handle)).size !== tabs.length) throw Error('Invalid Safari tab list.');
    return tabs;
  }
  private target(t: Target) {
    if (typeof t?.targetId !== 'string' || !HANDLE.test(t.targetId) || typeof t.epoch !== 'string' || t.epoch !== this.transport.epoch) throw Error('Invalid or stale Safari target; use targetId and epoch from safari_tabs/open.');
  }
  private async select(t: Target, signal: AbortSignal) {
    this.target(t);
    if (!(await this.list(signal)).some(tab => tab.handle === t.targetId)) throw Error('Safari target closed or unavailable; relist tabs.');
    this.target(t); // A reconnect invalidates the old epoch even if a handle is reused.
    // Safari returns a plain-text acknowledgement for switch_tab.
    // The transport still validates its envelope and isError flag.
    await this.transport.call('switch_tab', { handle: t.targetId }, signal);
    this.target(t);
  }
  private async closeTarget(t: Target, signal: AbortSignal) {
    this.target(t);
    const exists = (await this.list(signal)).some(tab => tab.handle === t.targetId);
    this.target(t);
    if (!exists) return { status: 'already-absent' as const };
    if (signal.aborted) throw Error('Safari close cancelled.');
    // Apple's close_tab takes a handle and returns an acknowledgement, not JSON.
    await this.transport.call('close_tab', { handle: t.targetId }, signal);
    this.target(t);
    return { status: 'closed' as const };
  }
  closeTab(t: Target, signal?: AbortSignal) {
    return this.operation(s => this.closeTarget(t, s), signal);
  }
  private async cleanupSearch(t?: Target) {
    if (!t) return { status: 'unidentified' as const, note: 'No identified created tab; inspect tabs before retrying.' };
    if (t.epoch !== this.transport.epoch) return { status: 'skipped-retired-epoch' as const, note: 'Connection retired; relist tabs for manual cleanup.' };
    try {
      // Bounded cleanup may finish after cancellation, but never reconnects a retired target.
      return await this.closeTarget(t, AbortSignal.timeout(3000));
    } catch {
      return { status: 'failed' as const, note: 'Cleanup unconfirmed; relist tabs before manual cleanup or retrying.' };
    }
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
    const normalized = webURL(url);
    const epoch = this.transport.epoch;
    const created = await this.call('create_tab', { url: normalized }, signal);
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
  read(t: Target, chars = 8000, links = 20, signal?: AbortSignal) {
    const expression = readJS(chars, links);
    return this.operation(async s => {
      const { data, url } = await this.observe(t, expression, s);
      if (!data || data.url !== url.slice(0, 2048) || typeof data.text !== 'string' || data.text.length > chars || typeof data.title !== 'string' || data.title.length > 300 || !Array.isArray(data.links) || data.links.length > links || typeof data.textTruncated !== 'boolean' || typeof data.linksTruncated !== 'boolean') throw Error('Invalid Safari read result.');
      const result = { ...data, targetId: t.targetId, epoch: t.epoch, identity: 'URL checks only; same-URL document replacement and live DOM changes may go undetected.' };
      bound(result); return result;
    }, signal);
  }
  search(options: SearchOptions, signal?: AbortSignal) {
    const request = searchRequest(options);
    const expression = searchJS(request.url, request.maxResults);
    return this.operation(async s => {
      let created: Target | undefined;
      let result;
      try {
        const tab = await this.create(request.url, s, t => { created = t; });
        const { data, url } = await this.observe(tab, expression, s);
        if (url !== request.url) throw Error('Search URL changed.');
        result = { ...request, ...validateSearch(data, request.url, request.maxResults), note: 'Untrusted provider ranking/content; first HTML page only. Empty results may indicate a challenge or changed markup. URL checks do not guarantee document identity.' };
        bound(result);
        if (s.aborted) throw Error('Safari search cancelled.');
      } catch (error) {
        const cleanup = await this.cleanupSearch(created);
        // Retain the primary error (including its cause) when cleanup also fails.
        const failure = new Error(`${error instanceof Error ? error.message : 'Safari search failed.'} Search cleanup: ${cleanup.status}.${'note' in cleanup ? ` ${cleanup.note}` : ''}`, { cause: error });
        Object.assign(failure, { cleanup });
        throw failure;
      }
      const cleanup = await this.cleanupSearch(created);
      if (s.aborted) {
        const failure = new Error(`Safari search cancelled. Search cleanup: ${cleanup.status}.`);
        Object.assign(failure, { cleanup });
        throw failure;
      }
      // Search results never advertise a usable target, even if cleanup is unconfirmed.
      return { ...result, cleanup };
    }, signal);
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
