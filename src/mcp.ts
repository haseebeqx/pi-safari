import { BACKEND_SCHEMAS, schemaKey } from './backend-schemas.ts';
import { VERSION } from './version.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export const TRANSPORT_LIMIT = 256 * 1024;
export interface ToolReply { content: { type: string; text?: string }[]; isError?: boolean }
export interface Transport {
  readonly epoch: string;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal, beforeSend?: () => void): Promise<ToolReply>;
  close(): void;
}
const REQUIRED = ['list_tabs', 'create_tab', 'switch_tab', 'evaluate_javascript', 'page_info', 'close_tab'];
export class SafariMCP implements Transport {
  epoch = randomUUID();
  private supported = new Set<string>();
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
  private idle?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(privateOptions: { spawn?: typeof spawn; platform?: string; timeout?: number } = {}) { this.options = privateOptions; }
  private options: { spawn?: typeof spawn; platform?: string; timeout?: number };
  private stop(error = Error('Safari connection closed; relist tabs. Inspect tabs before retrying an open.')) {
    const child = this.child; this.child = undefined; this.starting = undefined;
    this.supported.clear();
    clearTimeout(this.idle); this.buffer = Buffer.alloc(0); this.epoch = randomUUID();
    for (const p of this.pending.values()) p.reject(error); this.pending.clear();
    child?.kill('SIGTERM');
  }
  close() { this.stop(); }
  private async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if ((this.options.platform ?? process.platform) !== 'darwin') throw Error('Safari MCP requires macOS and Safari 27+.');
      const child = (this.options.spawn ?? spawn)('/usr/bin/safaridriver', ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      // Keep the extension from holding Pi open; an idle connection is retired.
      child.unref();
      child.stdin.on('error', () => { if (this.child === child) this.stop(Error('Safari MCP input disconnected.')); });
      child.stdout.on('error', () => { if (this.child === child) this.stop(Error('Safari MCP output disconnected.')); });
      child.stderr.on('error', () => {});
      child.stderr.on('data', () => {}); // Never log page or driver payloads.
      child.on('error', () => { if (this.child === child) this.stop(Error('Cannot start Safari MCP. Requires Safari 27+ and Allow remote automation and external agents.')); });
      child.on('exit', () => { if (this.child === child) this.stop(Error('Safari MCP disconnected; enable Allow remote automation and external agents, then relist tabs.')); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.child !== child) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > TRANSPORT_LIMIT) return this.stop(Error('Safari MCP response exceeded 256 KiB.'));
        let end: number;
        while ((end = this.buffer.indexOf(10)) !== -1) {
          const line = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1);
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line);
            if (m.jsonrpc !== '2.0' || typeof m !== 'object') throw Error();
            if (m.id === undefined) continue; // Server notifications.
            const p = this.pending.get(m.id);
            if (!p || (Object.hasOwn(m, 'result') === Object.hasOwn(m, 'error'))) throw Error();
            this.pending.delete(m.id);
            // Avoid echoing arbitrary driver/page error payloads into model output.
            if (m.error) p.reject(Error('Safari MCP rejected the request. Check Safari permissions and session state.'));
            else p.resolve(m.result);
          } catch { this.stop(Error('Malformed or mismatched Safari MCP reply.')); return; }
        }
      });
      const hello = await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pi-safari', version: VERSION } });
      if (hello?.protocolVersion !== '2024-11-05' || hello?.serverInfo?.name !== 'Safari' || !hello?.capabilities?.tools) throw Error('Incompatible Safari MCP protocol.');
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = await this.rpc('tools/list', {});
      if (!Array.isArray(tools?.tools) || REQUIRED.some(name => !tools.tools.some((t: { name: string }) => t.name === name))) throw Error('Safari MCP is missing required tools; update Safari.');
      for (const [name, schema] of Object.entries(BACKEND_SCHEMAS)) {
        if (schemaKey(tools.tools.find((t: any) => t.name === name)?.inputSchema) === schemaKey(schema)) this.supported.add(name);
      }
      const close = tools.tools.find((t: any) => t.name === 'close_tab')?.inputSchema;
      if (close?.type !== 'object' || close.properties?.handle?.type !== 'string' || !Array.isArray(close.required) || !close.required.includes('handle') || close.required.some((key: string) => key !== 'handle')) throw Error('Incompatible Safari close_tab schema.');
    })();
    try { await this.starting; } catch (e) { this.stop(); throw e; }
  }
  private write(message: unknown) {
    if (!this.child) throw Error('Safari MCP unavailable');
    const child = this.child;
    child.stdin.write(JSON.stringify(message) + '\n', e => { if (e && this.child === child) this.stop(Error('Safari MCP write failed.')); });
  }
  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (e) { this.pending.delete(id); reject(e); } });
  }
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal, beforeSend?: () => void): Promise<ToolReply> {
    if (!REQUIRED.includes(name) && !Object.hasOwn(BACKEND_SCHEMAS, name)) return Promise.reject(Error('Unsupported internal Safari operation.'));
    const next = this.queue.then(async () => {
      if (signal?.aborted) throw Error('Safari operation cancelled.');
      clearTimeout(this.idle);
      const abort = () => this.stop(Error('Safari deadline/cancellation; relist tabs and inspect before retrying an open.'));
      const timer = setTimeout(abort, this.options.timeout ?? 20000);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await this.start();
        if (!REQUIRED.includes(name) && !this.supported.has(name)) throw Error('Safari capability unavailable or incompatible schema; update Safari.');
        beforeSend?.(); // Recheck session authorization/epoch after connection startup, immediately before dispatch.
        const reply = await this.rpc('tools/call', { name, arguments: args });
        if (!reply || !Array.isArray(reply.content) || reply.content.some((c: any) => c?.type !== 'text' || typeof c.text !== 'string')) throw Error('Invalid Safari tool result.');
        if (reply.isError) throw Error('Safari operation failed. Check remote automation permission and relist tabs; inspect before retrying an open.');
        return reply as ToolReply;
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.idle = setTimeout(() => this.close(), 5 * 60_000); this.idle.unref();
      }
    });
    this.queue = next.catch(() => {}); return next;
  }
}
export function toolJSON(reply: ToolReply): any {
  if (reply.content.length !== 1 || typeof reply.content[0].text !== 'string') throw Error('Expected a single JSON Safari result.');
  try { return JSON.parse(reply.content[0].text); } catch { throw Error('Safari returned an unexpected result format.'); }
}
