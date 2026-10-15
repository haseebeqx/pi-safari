import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';

test('Pi factory registers six bounded tools and idempotent shutdown without starting Safari', async () => {
  const tools: any[] = [];
  const events = new Map<string, () => Promise<void>>();
  const pi = {
    registerTool(tool: unknown) { tools.push(tool); },
    on(name: string, handler: () => Promise<void>) { events.set(name, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'safari_close', 'safari_follow_link', 'safari_open', 'safari_read', 'safari_search', 'safari_tabs',
  ]);
  assert.deepEqual([...events.keys()], ['session_shutdown']);
  assert.equal(tools.find(tool => tool.name === 'safari_read').parameters.properties.maxChars.maximum, 12000);
  assert.equal(tools.find(tool => tool.name === 'safari_search').parameters.properties.maxResults.maximum, 10);
  assert.equal(tools.find(tool => tool.name === 'safari_close').annotations.destructiveHint, true);
  // Invalid URLs fail before any native transport or permission prompt.
  await assert.rejects(tools.find(tool => tool.name === 'safari_open').execute('call-1', { url: 'file:///etc/passwd' }), /HTTP/);
  await events.get('session_shutdown')!();
  await events.get('session_shutdown')!();
});
