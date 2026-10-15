import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { SafariMCP, toolJSON, TRANSPORT_LIMIT } from '../src/mcp.ts';
const names = ['list_tabs', 'create_tab', 'switch_tab', 'evaluate_javascript', 'page_info', 'close_tab'];
function driver(handle?: (m: any, respond: (result: unknown) => void, child: any) => void) {
  const calls: any[] = [];
  const children: any[] = [];
  const fake = ((file: string, args: string[]) => {
    assert.equal(file, '/usr/bin/safaridriver'); assert.deepEqual(args, ['--mcp']);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, unref() {}, kill() { this.killed = true; return true; } });
    children.push(child);
    child.stdin.on('data', (chunk: Buffer) => {
      const m = JSON.parse(chunk.toString()); calls.push(m);
      const respond = (result: unknown) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
      queueMicrotask(() => {
        if (handle) return handle(m, respond, child);
        if (m.method === 'initialize') respond({ protocolVersion: '2024-11-05', serverInfo: { name: 'Safari' }, capabilities: { tools: {} } });
        if (m.method === 'tools/list') respond({ tools: names.map(name => ({ name, ...(name === 'close_tab' ? { inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] } } : {}) })) });
        if (m.method === 'tools/call') respond({ content: [{ type: 'text', text: '[]' }] });
      });
    });
    return child;
  }) as unknown as typeof spawn;
  return { fake, calls, children };
}
test('initializes, discovers required tools, and reuses one local child', async () => {
  const d = driver(), m = new SafariMCP({ spawn: d.fake, platform: 'darwin' });
  try {
    assert.deepEqual(toolJSON(await m.call('list_tabs', {})), []);
    await m.call('list_tabs', {});
    assert.deepEqual(d.calls.map(c => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
    assert.equal(d.children.length, 1);
    await assert.rejects(m.call('page_interactions', {}), /Unsupported/);
  } finally { m.close(); }
});
test('platform and pre-cancel checks do not spawn', async () => {
  const d = driver(), m = new SafariMCP({ spawn: d.fake, platform: 'linux' });
  await assert.rejects(m.call('list_tabs', {}), /macOS/);
  await assert.rejects(m.call('list_tabs', {}, AbortSignal.abort()), /cancelled/);
  assert.equal(d.children.length, 0); m.close();
});
test('deadline stops child, invalidates epoch, and never replays creation', async () => {
  const d = driver(() => {}), m = new SafariMCP({ spawn: d.fake, platform: 'darwin', timeout: 10 });
  const epoch = m.epoch;
  await assert.rejects(m.call('create_tab', { url: 'https://example.com/' }), /deadline/);
  assert.notEqual(m.epoch, epoch); assert.equal(d.children.length, 1); assert.equal(d.children[0].killed, true);
  assert.equal(d.calls.filter(c => c.method === 'tools/call').length, 0); m.close();
});
test('malformed, unmatched and oversized replies terminate transport', async () => {
  for (const raw of ['not json\n', '{"jsonrpc":"2.0","id":999,"result":{}}\n', 'x'.repeat(TRANSPORT_LIMIT + 1)]) {
    const d = driver((_m, _r, child) => child.stdout.write(raw));
    const m = new SafariMCP({ spawn: d.fake, platform: 'darwin' });
    await assert.rejects(m.call('list_tabs', {}), /Malformed|exceeded/); assert.equal(d.children[0].killed, true); m.close();
  }
});
test('version mismatch and missing tools fail handshake', async () => {
  for (const version of ['bad', '2024-11-05']) {
    const d = driver((m, respond) => {
      if (m.method === 'initialize') respond({ protocolVersion: version, serverInfo: { name: 'Safari' }, capabilities: { tools: {} } });
      if (m.method === 'tools/list') respond({ tools: [] });
    });
    const m = new SafariMCP({ spawn: d.fake, platform: 'darwin' });
    await assert.rejects(m.call('list_tabs', {}), /Incompatible|missing/); m.close();
  }
});
test('tool errors are sanitized and toolJSON rejects non-JSON replies', async () => {
  const d = driver((m, respond) => {
    if (m.method === 'initialize') respond({ protocolVersion: '2024-11-05', serverInfo: { name: 'Safari' }, capabilities: { tools: {} } });
    if (m.method === 'tools/list') respond({ tools: names.map(name => ({ name, ...(name === 'close_tab' ? { inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] } } : {}) })) });
    if (m.method === 'tools/call') respond({ isError: true, content: [{ type: 'text', text: 'secret-page-body' }] });
  });
  const m = new SafariMCP({ spawn: d.fake, platform: 'darwin' });
  await assert.rejects(m.call('list_tabs', {}), e => e instanceof Error && !e.message.includes('secret-page-body'));
  assert.throws(() => toolJSON({ content: [{ type: 'text', text: 'not JSON' }] }), /unexpected/); m.close();
});
test('cancelling an in-flight create kills the connection without replay and allows a fresh handshake', async () => {
  let notifyCreate!: () => void;
  const started = new Promise<void>(resolve => { notifyCreate = resolve; });
  const d = driver((m, respond) => {
    if (m.method === 'initialize') respond({ protocolVersion: '2024-11-05', serverInfo: { name: 'Safari' }, capabilities: { tools: {} } });
    if (m.method === 'tools/list') respond({ tools: names.map(name => ({ name, ...(name === 'close_tab' ? { inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] } } : {}) })) });
    if (m.method === 'tools/call' && m.params.name === 'create_tab') notifyCreate();
    if (m.method === 'tools/call' && m.params.name === 'list_tabs') respond({ content: [{ type: 'text', text: '[]' }] });
  });
  const m = new SafariMCP({ spawn: d.fake, platform: 'darwin' }), controller = new AbortController();
  const epoch = m.epoch;
  const create = m.call('create_tab', { url: 'https://example.com/' }, controller.signal);
  await started; controller.abort();
  await assert.rejects(create, /cancellation/);
  assert.notEqual(m.epoch, epoch); assert.equal(d.children[0].killed, true);
  assert.deepEqual(toolJSON(await m.call('list_tabs', {})), []);
  assert.equal(d.children.length, 2);
  assert.equal(d.calls.filter(c => c.method === 'tools/call' && c.params.name === 'create_tab').length, 1);
  m.close();
});

test('close compatibility rejects mismatched handle schema before browser work', async () => {
  const d = driver((m, respond) => {
    if (m.method === 'initialize') respond({ protocolVersion: '2024-11-05', serverInfo: { name: 'Safari' }, capabilities: { tools: {} } });
    if (m.method === 'tools/list') respond({ tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: { handle: { type: 'number' } }, required: ['handle'] } })) });
  });
  const m = new SafariMCP({ spawn: d.fake, platform: 'darwin' });
  await assert.rejects(m.call('close_tab', { handle: 'page-1' }), /Incompatible.*close_tab/);
  assert.equal(d.calls.some(c => c.method === 'tools/call'), false); m.close();
});
