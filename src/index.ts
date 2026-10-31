import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { SessionApproval, EvaluationGrant } from './permissions.ts';
import { Safari } from './safari.ts';
import { bound } from './extraction.ts';
import { REGIONS, TIMES } from './search.ts';
import { DEFAULT_SAFARI_SESSION_STRATEGY, getDefaultSafariSessionStrategyStore, normalizeSafariSessionStrategy, type SafariSessionStrategy } from './session-strategy.ts';

const Target = {
  targetId: Type.String({ minLength: 1, maxLength: 200, description: 'Opaque Safari tab handle from safari_tabs/open' }),
  epoch: Type.String({ minLength: 1, maxLength: 100, description: 'Connection epoch returned with the target; relist after disconnect' }),
};
function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: bound(data) }], details: undefined };
}
/**
 * Fixed at package build time by the entry point. The default (safe) package grants nothing;
 * the unrestricted package (src/index-unrestricted.ts) pre-grants both tiers each session.
 */
export interface SafariPolicy { fullActions?: boolean; evaluate?: boolean; /** Also allow granted tiers in print/JSON/RPC modes. */ noninteractive?: boolean }

export default createSafariExtension();

export function createSafariExtension(policy: SafariPolicy = {}) {
  return (pi: ExtensionAPI) => registerSafari(pi, policy);
}

function registerSafari(pi: ExtensionAPI, policy: SafariPolicy) {
  const approval = new SessionApproval();
  const evaluation = new EvaluationGrant();
  const safari = new Safari(undefined, () => approval.require(), () => evaluation.require());
  const strategyStore = getDefaultSafariSessionStrategyStore();
  pi.registerFlag('safariSession', { type: 'string', description: 'Safari session strategy for this run: per-session, per-project, or global.' });
  let activeStrategy: SafariSessionStrategy = DEFAULT_SAFARI_SESSION_STRATEGY;
  const flagStrategy = (): SafariSessionStrategy | undefined => {
    const value = pi.getFlag('safariSession');
    return typeof value === 'string' && value.trim().length > 0 ? normalizeSafariSessionStrategy(value) : undefined;
  };
  const resolveStrategy = (cwd: string | undefined): SafariSessionStrategy => {
    const fromFlag = flagStrategy();
    if (fromFlag) return fromFlag;
    return strategyStore.load(cwd);
  };
  const teardownSafari = () => { if (activeStrategy !== 'global') safari.close(); };
  // Policy grants are reapplied on every reset so session switch/fork keep them; /safari-permissions revoke and
  // /safari-evaluate revoke still clear them until the next session starts.
  const resetSessionGrants = () => {
    approval.reset(); evaluation.reset();
    if (policy.fullActions) approval.grant({ noninteractive: policy.noninteractive });
    if (policy.evaluate) evaluation.grant({ noninteractive: policy.noninteractive });
  };
  const safariSessionCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const value = args.trim();
    if (value !== 'per-session' && value !== 'per-project' && value !== 'global' && value !== 'reset') throw Error('Usage: /safari-session per-session|per-project|global|reset');
    const strategy = value === 'reset' ? DEFAULT_SAFARI_SESSION_STRATEGY : normalizeSafariSessionStrategy(value);
    let persistFailed = false;
    try {
      if (value === 'reset') { strategyStore.clear(ctx.cwd); strategyStore.clear(undefined); } else strategyStore.save(value === 'global' ? undefined : ctx.cwd, strategy);
    } catch { persistFailed = true; }
    activeStrategy = strategy;
    if (persistFailed) ctx.ui.notify('Could not save the Safari session strategy; it applies to this run only.', 'warning');
    ctx.ui.notify(value === 'reset' ? 'Safari session strategy reset to per-session.' : `Safari session strategy set to ${strategy}${value === 'global' ? ' (machine-wide)' : ` for ${ctx.cwd ?? 'this project'}`}.`, 'info');
  };
  pi.registerCommand('safari-session', {
    description: 'Set the Safari session strategy: per-session (default), per-project (saved per project), or global (saved machine-wide); reset clears the saved choice.',
    handler: (args, ctx) => safariSessionCommand(args, ctx),
  });
  pi.registerCommand('safari-permissions', {
    description: 'allow grants full Safari action permission for this session; revoke clears all grants',
    handler: (args, ctx) => approval.command(args, ctx),
  });
  pi.registerCommand('safari-evaluate', {
    description: 'allow enables standalone JavaScript expression evaluation for this session (not covered by /safari-permissions); revoke clears it',
    handler: (args, ctx) => evaluation.command(args, ctx),
  });
  pi.on('input', (event, ctx) => { approval.input(event, ctx); });
  pi.on('agent_end', async () => { approval.endRequest(); });
  pi.on('session_start', async (_event, ctx) => {
    activeStrategy = resolveStrategy(ctx?.cwd); resetSessionGrants(); teardownSafari();
    if ((policy.fullActions || policy.evaluate) && ctx?.hasUI) {
      const tiers = [policy.fullActions && 'restricted actions', policy.evaluate && 'JavaScript evaluation'].filter(Boolean).join(' and ');
      ctx.ui.notify(`pi-safari-unrestricted: ${tiers} pre-approved for this session (no task classifier). Revoke per session with /safari-permissions revoke and /safari-evaluate revoke.`, 'warning');
    }
  });
  pi.on('session_before_switch', async () => { resetSessionGrants(); });
  pi.on('session_before_fork', async () => { resetSessionGrants(); });
  pi.on('session_shutdown', async () => { resetSessionGrants(); teardownSafari(); });
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
    async execute(_id, args, signal, _update, ctx) { return result(await safari.open(args.url, signal)); },
  });
  pi.registerTool({
    name: 'safari_close', label: 'Close Safari tab',
    description: 'Close exactly one Safari automation tab by explicit targetId + epoch. No extension permission required. Rejects stale targets; relist after disconnect. Does not close unidentified tabs or retry a failed close.',
    parameters: Type.Object({ ...Target }), annotations: { destructiveHint: true, readOnlyHint: false },
    async execute(_id, args, signal) { return result(await safari.closeTab(args, signal)); },
  });
  pi.registerTool({
    name: 'safari_search', label: 'Search with Safari',
    description: 'Search in a NEW self-closing automation tab. Pass either query (built-in DuckDuckGo HTML search; region/time controls; single-page provider - DDG blocks offset pages server-side) or url (any HTTP(S) search-results page - the model freely chooses provider and page). Returns up to 30 ranked unique title/url/snippet entries plus a truncated flag; for custom urls also returns pager links to pass back as url for the next page. Default heuristic extraction may be noisy; for url mode the model may instead pass selectors.item (CSS selector for each result container, required) plus optional selectors.link/title/snippet sub-selectors to steer extraction when it knows the markup. Selectors are CSS only - no arbitrary JS, clicks or forms. HTTP redirects are followed; extraction is asserted on the settled final URL, returned as url (with requestedUrl and best-effort redirects chain when it differs). Untrusted content; URL checks do not guarantee document identity. Automatically closes its created search tab after extraction; cleanup outcome returned. Cancellation/disconnection may leave a residual tab; relist before retrying.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
      region: Type.Optional(Type.Union(REGIONS.map(v => Type.Literal(v)))),
      time: Type.Optional(Type.Union(TIMES.map(v => Type.Literal(v)))),
      selectors: Type.Optional(Type.Object({
        item: Type.String({ minLength: 1, maxLength: 500 }),
        link: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        snippet: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      })),
    }),
    async execute(_id, args, signal, _update, ctx) { return result(await safari.search(args, signal)); },
  });
  pi.registerTool({
    name: 'safari_fetch', label: 'Fetch Safari page',
    description: 'Read a HTTP(S) page in one self-closing call: opens a NEW automation tab, optionally waits for a visible selector/text, extracts bounded title/text/visible links, then closes the tab. Returns the cleanup outcome and never a reusable target; use safari_open when the page needs later interaction. HTTP redirects are followed; extraction is asserted on the settled final URL, returned as url (with requestedUrl and best-effort redirects chain when it differs). Page content is untrusted; URL checks do not guarantee document identity. Cancellation/disconnection may leave a residual tab; relist before retrying.',
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 8192 }),
      selector: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
      maxLinks: Type.Optional(Type.Integer({ minimum: 0, maximum: 40 })),
    }),
    async execute(_id, args, signal) { return result(await safari.fetch(args, signal)); },
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
    async execute(_id, args, signal, _update, ctx) { return result(await safari.followLink(args, args.selector, args.expectedUrl, signal)); },
  });
  pi.registerTool({
    name: 'safari_activate', label: 'Activate Safari tab',
    description: 'Explicitly select an automation target. Independently checked against the current user task; /safari-permissions allow bypasses task checks. Does not guarantee OS window focus.',
    parameters: Type.Object({ ...Target }),
    async execute(_id, args, signal, _update, ctx) { return approval.run(ctx, 'activate', async usage => ({ ...result(await safari.activate(args, signal)), usage }), signal, { args }); },
  });
  pi.registerTool({
    name: 'safari_snapshot', label: 'Safari structured snapshot',
    description: 'Read native WebKit textTree with interactive node UIDs, accessibility attributes and rects. Default viewport, optional entire page. media print captures the @media print layout: emulation is applied to this tab for the call only, verified, and always restored. Use this tool, not safari_screenshot, for print layout; screenshot rasterization does not reflect emulated media. Up to 12000 backend characters; native large extractions may return an artifact path instead of inline tree. Main frame only. Untrusted content; UIDs are live, not document identity.',
    parameters: Type.Object({ ...Target, entirePage: Type.Optional(Type.Boolean()), media: Type.Optional(Type.Union([Type.Literal('screen'), Type.Literal('print')], { description: 'CSS media to emulate for this snapshot only; the prior media is restored before returning. Default: no emulation.' })) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.snapshot(args, args.entirePage, args.media, signal)); },
  });
  const Query = {
    selector: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  };
  pi.registerTool({
    name: 'safari_find', label: 'Find Safari elements',
    description: 'Find visible main-frame DOM elements by CSS selector and/or case-insensitive text substring (combined with AND). Supply at least one. Scan at most 2000 elements; returns bounded descriptors, not native UIDs. No shadow roots; names are approximations, not full accessible names.',
    parameters: Type.Object({ ...Target, ...Query, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.find(args, args, false, signal)); },
  });
  pi.registerTool({
    name: 'safari_inspect', label: 'Inspect Safari element',
    description: 'Inspect exactly one visible CSS match in main frame. Returns bounded attributes, approximate name, state and rectangle. No input values, HTML or computed-style dump. Limited to first 2000 selector matches; rejects ambiguous/truncated results.',
    parameters: Type.Object({ ...Target, selector: Type.String({ minLength: 1, maxLength: 500 }) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.find(args, { selector: args.selector }, true, signal)); },
  });
  pi.registerTool({
    name: 'safari_wait', label: 'Wait for Safari content',
    description: 'Poll for a visible selector and/or text match at exact expectedUrl. Same bounded main-frame query as safari_find. timeoutMs 0..10000, default 5000; cancellable. URL changes fail, no navigation or mutation. Presence only, not absence.',
    parameters: Type.Object({ ...Target, ...Query, expectedUrl: Type.String({ maxLength: 8192 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.wait(args, args.expectedUrl, args, args.timeoutMs, signal)); },
  });
  pi.registerTool({
    name: 'safari_wait_for_navigation', label: 'Wait for Safari load',
    description: 'Block until the named tab reaches readyState complete at the exact expectedUrl - e.g. right after safari_navigate, or through multi-stage redirects that land on the expected URL while still loading. Returns the final URL + title. Polls the target only; no navigation or mutation. timeoutMs 0..10000, default 5000; cancellable. A modal JS dialog fails fast.',
    parameters: Type.Object({ ...Target, expectedUrl: Type.String({ maxLength: 8192 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.waitNavigation(args, args.expectedUrl, args.timeoutMs, signal)); },
  });
  pi.registerTool({
    name: 'safari_navigate', label: 'Navigate Safari tab',
    description: 'Navigate explicit existing target once, after exact expectedUrl check. HTTP(S) only, redirects rejected after navigation (no rollback). Independently checked against the current user task; /safari-permissions allow bypasses task checks. Timeouts may already have navigated: inspect, never blindly replay.',
    parameters: Type.Object({ ...Target, expectedUrl: Type.String({ maxLength: 8192 }), url: Type.String({ maxLength: 8192 }) }),
    async execute(_id, args, signal, _update, ctx) { return approval.run(ctx, 'navigate', async usage => ({ ...result(await safari.navigate(args, args.expectedUrl, args.url, signal)), usage }), signal, { args }); },
  });
  pi.registerTool({
    name: 'safari_interact', label: 'Interact with Safari page',
    description: 'One native WebKit interaction at exact expectedUrl. Scroll needs no extension permission; other actions are independently checked against the current user task; /safari-permissions allow bypasses task checks. Use numeric node UID from fresh safari_snapshot for click/type/hover; type with replaceAll=true fills. keyPress uses backend key names; scroll requires bounded scrollDelta. May submit/navigate. Never retried; same-URL document replacement/UID staleness can go undetected. No selector/text fallback.',
    parameters: Type.Object({ ...Target, expectedUrl: Type.String({ maxLength: 8192 }), action: Type.Object({
      type: Type.Union((['click','type','keyPress','scroll','hover'] as const).map(v => Type.Literal(v))),
      purpose: Type.String({ minLength: 1, maxLength: 300 }),
      node: Type.Optional(Type.String({ pattern: '^[0-9]{1,20}$' })),
      value: Type.Optional(Type.String({ maxLength: 4000 })), replaceAll: Type.Optional(Type.Boolean()),
      scrollDelta: Type.Optional(Type.Object({ x: Type.Number({ minimum: -10000, maximum: 10000 }), y: Type.Number({ minimum: -10000, maximum: 10000 }) })),
    }) }),
    async execute(_id, args, signal, _update, ctx) {
      if (args.action.type === 'scroll') return result(await safari.interact(args, args.expectedUrl, args.action, signal));
      return approval.run(ctx, args.action.type, async usage => ({ ...result(await safari.interact(args, args.expectedUrl, args.action, signal)), usage }), signal, { args, targetContext: safari.permissionContext(args, args.expectedUrl) }); },
  });
  pi.registerTool({
    name: 'safari_upload', label: 'Upload files to Safari form',
    description: 'Attach existing local files (absolute paths) to a single <input type=file> matched by a CSS selector at exact expectedUrl, then post its enclosing form as multipart (all form fields included) to the form action URL via fetch. The form must use method=post; the page does not navigate and the response is returned. Up to 10 files, 10 MiB each. Independently checked against the current user task; /safari-permissions allow bypasses task checks. Never retried; inspect before retrying.',
    parameters: Type.Object({ ...Target, expectedUrl: Type.String({ maxLength: 8192 }), selector: Type.String({ minLength: 1, maxLength: 500 }), purpose: Type.String({ minLength: 1, maxLength: 300 }), files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 10 }) }),
    annotations: { readOnlyHint: false },
    async execute(_id, args, signal, _update, ctx) {
      return approval.run(ctx, 'upload', async usage => ({ ...result(await safari.upload(args, args.expectedUrl, args.selector, args.files, signal)), usage }), signal, { args, targetContext: safari.permissionContext(args, args.expectedUrl) }); },
  });
  pi.registerTool({
    name: 'safari_evaluate', label: 'Evaluate Safari JavaScript',
    description: 'Run one caller-supplied JavaScript expression in the target page at the exact expectedUrl and return its result. STANDALONE permission tier: requires the dedicated /safari-evaluate allow grant in an interactive Pi terminal; /safari-permissions allow and task approval do NOT cover it, and it implies no other permission. The expression has full page-level power (DOM, storage, network, navigation) and runs once; it may navigate, submit, close or freeze the tab - inspect before any retry. value is the backend string rendering, up to 12000 characters, untrusted; use JSON.stringify inside the expression for structured data.',
    parameters: Type.Object({ ...Target, expectedUrl: Type.String({ maxLength: 8192 }), expression: Type.String({ minLength: 1, maxLength: 8000 }) }),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async execute(_id, args, signal, _update, ctx) {
      evaluation.require(ctx);
      return result(await safari.evaluate(args, args.expectedUrl, args.expression, signal));
    },
  });
  pi.registerTool({
    name: 'safari_screenshot', label: 'Safari screenshot',
    description: 'Capture viewport or full page PNG using verified native Safari capability. Returns backend temporary file path text, not inline image. No caller-supplied save path or element crop. Does not read the artifact automatically.',
    parameters: Type.Object({ ...Target, fullPage: Type.Optional(Type.Boolean()) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.screenshot(args, args.fullPage, signal)); },
  });
  pi.registerTool({
    name: 'safari_console', label: 'Safari console messages',
    description: 'Read buffered native console messages without clearing; pass clear to reset the buffer first. Optional levelFilter (debug|info|warn|error) restricts returned levels. Maximum 100 entries and 12000 backend characters. May contain sensitive untrusted page data. Not a persistent subscription.',
    parameters: Type.Object({ ...Target, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), clear: Type.Optional(Type.Boolean()), levelFilter: Type.Optional(Type.Array(Type.Union((['debug', 'info', 'warn', 'error'] as const).map(v => Type.Literal(v))))) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.console(args, args.limit, signal, args.clear, args.levelFilter)); },
  });
  pi.registerTool({
    name: 'safari_network', label: 'Safari network summaries',
    description: 'Read native Inspector network summaries without clearing; optional URL substring, method, statusMin/statusMax range and since filter. Up to 12000 backend characters; 256 KiB transport cap may reject larger buffers. No request bodies, request interception, or complete historical coverage promised.',
    parameters: Type.Object({ ...Target, urlSubstring: Type.Optional(Type.String({ maxLength: 500 })), clear: Type.Optional(Type.Boolean()), method: Type.Optional(Type.String({ maxLength: 500 })), statusMin: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })), statusMax: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })), since: Type.Optional(Type.String({ maxLength: 64 })) }), annotations: { readOnlyHint: true },
    async execute(_id, args, signal) { return result(await safari.network(args, args.urlSubstring, signal, args.clear, args.method, args.statusMin, args.statusMax, args.since)); },
  });
  pi.registerTool({
    name: 'safari_dialog', label: 'Handle Safari JS dialogs',
    description: 'List or handle native JavaScript dialogs (alert/confirm/prompt) that freeze a tab: while one is up, every other call against that tab hangs until timeout. Acts on the named tab (made active first); dialogs are reported for the active tab only. list is a safe read and returns messages without dialog type or default value. respond accepts the dialog (alert accepts, confirm true, prompt accepts the default); add inputText only for prompts to answer with a specific value - inputText is rejected by confirm/alert and leaves them up. dismiss cancels (confirm false, prompt cancel). No extension permission required, like safari_close. Each call dispatches once; relist tabs after a connection reset.',
    parameters: Type.Object({ ...Target, action: Type.Union((['list', 'respond', 'dismiss'] as const).map(v => Type.Literal(v))), inputText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })) }),
    annotations: { readOnlyHint: false },
    async execute(_id, args, signal) { return result(await safari.dialog(args, args.action, args.inputText, signal)); },
  });

}
