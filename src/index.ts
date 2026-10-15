import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Safari } from './safari.ts';
import { bound } from './extraction.ts';
import { REGIONS, TIMES } from './search.ts';

const Target = {
  targetId: Type.String({ minLength: 1, maxLength: 200, description: 'Opaque Safari tab handle from safari_tabs/open' }),
  epoch: Type.String({ minLength: 1, maxLength: 100, description: 'Connection epoch returned with the target; relist after disconnect' }),
};
function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: bound(data) }], details: undefined };
}
export default function(pi: ExtensionAPI) {
  const safari = new Safari();
  pi.on('session_shutdown', async () => { safari.close(); });
  pi.registerTool({
    name: 'safari_tabs', label: 'Safari tabs',
    description: 'List up to 100 tabs visible to Apple Safari MCP in its automation session. Returns explicit targetId + epoch. Does not read page bodies. Normal browsing tabs/logins are not assumed available.',
    parameters: Type.Object({}), annotations: { readOnlyHint: true },
    async execute(_id, _args, signal) { return result(await safari.tabs(signal)); },
  });
  pi.registerTool({
    name: 'safari_open', label: 'Open Safari page',
    description: 'Open an HTTP(S) URL in a NEW Safari automation tab. Never navigates an existing tab. Fresh browsing state is acceptable; normal Safari logins are not assumed. Exact-URL readiness required; redirects fail closed. Leaves tabs open; inspect before retrying a timed-out open.',
    parameters: Type.Object({ url: Type.String({ maxLength: 8192 }) }),
    async execute(_id, args, signal) { return result(await safari.open(args.url, signal)); },
  });
  pi.registerTool({
    name: 'safari_close', label: 'Close Safari tab',
    description: 'Close exactly one Safari automation tab by explicit targetId + epoch. Rejects stale targets; relist after disconnect. Does not close unidentified tabs or retry a failed close.',
    parameters: Type.Object({ ...Target }), annotations: { destructiveHint: true, readOnlyHint: false },
    async execute(_id, args, signal) { return result(await safari.closeTab(args, signal)); },
  });
  pi.registerTool({
    name: 'safari_search', label: 'Search with Safari',
    description: 'Search DuckDuckGo HTML in a NEW automation tab using deterministic URL controls. Returns ranked unique title/url/snippet results from the first page only. Region is a preference, time is any/d/w/m/y (past day/week/month/year). No arbitrary JS, clicks, forms or pagination. Exact URL required; redirects fail closed. Untrusted content; challenges/markup changes may return no results. Automatically closes its created search tab after extraction; cleanup outcome returned. Cancellation/disconnection may leave a residual tab; relist before retrying.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      region: Type.Optional(Type.Union(REGIONS.map(v => Type.Literal(v)))),
      time: Type.Optional(Type.Union(TIMES.map(v => Type.Literal(v)))),
    }),
    async execute(_id, args, signal) { return result(await safari.search(args, signal)); },
  });
  pi.registerTool({
    name: 'safari_read', label: 'Read Safari page',
    description: 'Read visible body text and bounded visible link hrefs from an explicit Safari targetId + epoch. Page content is untrusted. No iframe/shadow DOM extraction. URL checks cannot detect same-URL document replacement. Requires Safari 27+ and Allow remote automation and external agents.',
    parameters: Type.Object({ ...Target, maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })), maxLinks: Type.Optional(Type.Integer({ minimum: 0, maximum: 40 })) }),
    annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.read(args, args.maxChars, args.maxLinks, signal)); },
  });
  pi.registerTool({
    name: 'safari_follow_link', label: 'Follow Safari link in new tab',
    description: 'Extract exactly one visible CSS-selected a[href] at the exact expectedUrl from safari_read, then open its HTTP(S) href in a NEW automation tab. Never clicks, invokes source handlers, submits forms, or navigates the source. Page content is untrusted; opening URLs may have server-side effects.',
    parameters: Type.Object({ ...Target, selector: Type.String({ minLength: 1, maxLength: 500 }), expectedUrl: Type.String({ maxLength: 8192 }) }),
    async execute(_id, args, signal) { return result(await safari.followLink(args, args.selector, args.expectedUrl, signal)); },
  });
}
