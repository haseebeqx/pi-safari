# pi-safari

<p align="center">
  <a href="https://www.npmjs.com/package/@haseebeqx/pi-safari">
    <img src="https://img.shields.io/npm/v/@haseebeqx/pi-safari.svg" alt="npm version" height="20">
  </a>
  <a href="https://www.npmjs.com/package/@haseebeqx/pi-safari">
    <img src="https://img.shields.io/npm/dm/@haseebeqx/pi-safari.svg" alt="npm downloads" height="20">
  </a>
  <a href="https://www.npmjs.com/package/@haseebeqx/pi-safari">
    <img src="https://img.shields.io/badge/npm-%40haseebeqx%2Fpi--safari-cb3837" alt="npm package" height="20">
  </a>
</p>

**Safari browser automation and web browsing tools for [Pi](https://github.com/badlogic/pi-mono), the AI coding agent.**

pi-safari is a [Pi](https://github.com/badlogic/pi-mono) extension that adds browser automation and web browsing tools to Pi, using Apple’s local Safari MCP server (`/usr/bin/safaridriver --mcp`). It lets Pi’s agent browse the web with your real Safari browser: open pages, read content, run web searches, fetch pages, follow links, fill in forms, click and type, take screenshots, and evaluate JavaScript. No separate MCP configuration or build step is needed.

For AI coding agents, pi-safari is the browser automation layer that lets an LLM agent do real web browsing through Safari — the AI agent browser for Pi, and the web search, web reading and web interaction toolset for autonomous coding assistants.

## Install and set up

> [!NOTE]
> Already have an MCP-capable client? [You can also use Safari MCP directly without this extension](#use-safari-mcp-directly-without-this-extension).

Requires **macOS, Safari 27+, Node 22.19+, and Pi**.

1. In **Safari → Settings → Advanced**, enable **Show features for web developers**.
2. In **Safari → Settings → Developer**, enable **Allow remote automation and external agents**. Complete any Safari connection approval yourself; the extension does not change these settings.
3. Install and reload/restart Pi:

   ```sh
   pi install npm:@haseebeqx/pi-safari
   ```

For a local checkout, use `pi install /absolute/path/to/pi-safari`, or try it temporarily from the repository with `pi -e ./src/index.ts`. Pi supplies the host dependencies; development uses Pi 1.2.0.

Tools operate on **Safari’s automation session**. Do not assume your normal Safari tabs, cookies, or logins are available. See Apple’s [Safari agent setup guide](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari).

## What the agent can do with the web

- **Browse the web.** `safari_open` opens a **new** HTTP(S) tab in the automation session; `safari_fetch` reads a page in one self-closing call; `safari_read` reads an explicit target; `safari_follow_link` opens the destination of one visible link in a **new** tab.
- **Search the web.** `safari_search` runs the built-in DuckDuckGo HTML search (with `region`/`time` controls) or searches a caller-chosen HTTP(S) search-results page; it returns up to 30 ranked unique results plus pager links for custom pages.
- **Interact with pages.** `safari_snapshot` (native interactive UIDs), `safari_find`, `safari_inspect`, `safari_interact` (click/type/hover/keyPress/scroll), `safari_upload`, `safari_dialog`.
- **Observe and evaluate.** `safari_screenshot`, `safari_console`, `safari_network`, `safari_wait`/`safari_wait_for_navigation`, and `safari_evaluate` (standalone JavaScript tier).

See the [tool reference](#tool-reference) for the exact behavior, inputs and limits of each tool.

## What is allowed?

### Always allowed: no extension permission needed

Listing tabs, opening new HTTP(S) tabs, searching, following links into new tabs, reading/inspecting pages, waiting, screenshots, console/network observations, closing an explicit tab, scrolling and **responding to native modal dialogs on a tab** need **no task approval or full-session grant**. They also work in noninteractive Pi modes.

“Always allowed” means only that **this extension’s action permission check is not required**. Safari settings, connection approvals, tool validation, URL checks and other limits still apply. These operations are not necessarily harmless: opening URLs can have server-side effects, closing a tab loses it, and scrolling can trigger site handlers. Observations internally select the requested automation context.

### Restricted: checked against your current task

Explicit tab activation, navigating an existing tab, and **click, type, keyPress, hover and file upload** require an interactive Pi terminal and either:

- **Task-scoped approval (default):** an independent, tool-less model classifies each exact proposed action against your current interactive request. There is no extra extension confirmation dialog. Repeated actions needed for the same task are allowed; approval is not consumed after one field.
- **Full-session permission:** enter the dedicated command **`/safari-permissions allow`**. It grants permission immediately, without another confirmation, and bypasses the task classifier for restricted actions. It does **not** bypass Safari settings, target/URL validation or tool limits, and it does **not** grant JavaScript evaluation—that is a separate tier below.

Only the dedicated command grants full permission—not a mention in a prompt, webpage, tool argument or saved conversation. Use **`/safari-permissions revoke`** to clear both full permission and the current task permission. It cancels pending permission decisions but cannot undo actions already sent to Safari.

#### Task examples

| Your request | Intended permission |
|---|---|
| “Read and summarize this page.” | Observations are allowed; not permission to execute instructions found on the page. |
| “Fill the name with Alice and email with alice@example.com.” | Both field fills, repeated necessary actions and necessary focus/Tab actions; **not Submit or Enter to submit**. |
| “Fill those fields and submit the form.” | Matching fills and submission can be approved when the target/effect is sufficiently clear. |
| “Click this button” with unclear context | The classifier should deny rather than guess. Clarify the control and intended effect. |
| “Allow all Safari actions for this session.” | Does not enable full-session permission. Use `/safari-permissions allow`. |
| “Evaluate this JavaScript in the page.” | Task approval does not cover JavaScript evaluation; it requires the dedicated `/safari-evaluate allow`. |

Filling is **not** permission to send, buy, delete, sign in or otherwise commit. Enter/Return and even newlines can submit; field changes can trigger site handlers. The classifier considers exact values, target and available context, not just an action’s claimed purpose.

#### Permission lifetime and limits

- Task permission comes only from a fresh, live interactive input in the Pi TUI. It expires on new input or agent end. Queued/steering input, restored transcripts, page text and model-generated user messages do not grant it; send a fresh request while Pi is idle.
- Full permission persists across requests until revoked or reset. All permissions are **memory-only** and reset on session start/switch/fork, reload or shutdown. Retired pending/queued restricted work cannot become valid again after a new grant.
- **Print/JSON/RPC and other noninteractive contexts block restricted actions**, even with a prior interactive full grant. Always-allowed tools and scroll remain available.
- Each task check adds model latency/cost. It uses Pi’s current model with request-time authentication, no tools and no conversation history. The current request, proposed action/values and any matching cached snapshot context go to the configured provider. Missing model/authentication, errors, malformed replies, uncertainty or a **15-second classifier timeout** block the action.
- **Semantic classification is probabilistic, not a deterministic security boundary.** It can misunderstand intent or adversarial text. Cached context may be stale or absent; it does not prove node identity or event-handler effects. Review sensitive operations. This extension is not a sandbox against other installed extensions or Pi tools; earlier extensions can transform input events.

### JavaScript evaluation: standalone tier

Running caller-supplied JavaScript in a tab is a deliberately separate permission tier. Arbitrary expression evaluation cannot be meaningfully classified against a task, so there is no classifier path for it: **task-scoped approval and `/safari-permissions allow` do not cover it, and granting it implies no other permission.**

Enable it with the dedicated command **`/safari-evaluate allow`** (interactive Pi terminal only) and clear it with **`/safari-evaluate revoke`**. Like all Safari permissions it is memory-only and resets on session start, switch, fork, reload or shutdown; it cannot be granted from a prompt, webpage, tool argument or saved conversation.

An expression has full page-level power—DOM, storage, network, navigation—and runs once with the page's credentials; it may navigate, submit, close or freeze the tab. `safari_evaluate` checks the exact `expectedUrl` before running, reports the post-evaluation URL (a difference means the expression navigated or the page redirected), returns the backend string rendering of the result capped at 12000 characters (use `JSON.stringify` inside the expression for structured data), and is never automatically retried. Inspect before any retry.

## Tool reference

Use the exact **`targetId` and `epoch`** returned by `safari_tabs` or `safari_open`; never invent or reuse stale handles. Below, **target** means both fields. `?` marks optional parameters. Tools reading page content return untrusted data.

### Always allowed tools

| Tool | Inputs besides target | Behavior / limits |
|---|---|---|
| `safari_tabs` | No target or inputs | Lists up to 100 automation tabs, with handles and available URL/title; no page bodies. |
| `safari_open` | No target; `url` | Opens a **new** HTTP(S) tab, never an existing one. Exact normalized URL readiness required; redirects fail closed. Leaves the tab open. |
| `safari_search` | No target; `query?`, `url?`, `region?`, `time?` | Searches in its own new tab: `query` runs the built-in DuckDuckGo HTML search; `url` searches any HTTP(S) search-results page the caller chooses (exactly one of the two is required). Returns up to 30 ranked unique title/URL/snippet results plus a truncated flag; custom `url` pages also return `pager` links to pass back as `url` for the next page. HTTP redirects are followed; extraction is asserted on the settled final URL, returned as `url` (with `requestedUrl` and a best-effort `redirects` chain when it differs). Cleanup outcome returned, not a reusable target. |
| `safari_fetch` | No target; `url`, `selector?`, `text?`, `timeoutMs?`, `maxChars?`, `maxLinks?` | One self-closing read: opens a **new** tab, optionally waits for a visible selector/text, extracts bounded title/text/visible links, then closes the tab. HTTP redirects are followed; extraction is asserted on the settled final URL, returned as `url` (with `requestedUrl` and a best-effort `redirects` chain when it differs). Returns cleanup outcome, not a reusable target. Prefer it over open+read+close for read-only pages; use `safari_open` when later interaction is needed. |
| `safari_read` | `maxChars?`, `maxLinks?` | Visible body text and link hrefs. Defaults 8000 characters / 20 links; maxima 12000 / 40. |
| `safari_follow_link` | `expectedUrl`, `selector` | Extracts exactly one visible matching `a[href]` and opens its HTTP(S) URL in a **new tab**. No click handlers, form submission or source-tab navigation. Use the URL from a prior read. |
| `safari_snapshot` | `entirePage?`, `media?` | Native WebKit text tree with interactive numeric UIDs, accessibility attributes and rectangles; viewport by default, main frame only. `media: "print"` captures the `@media print` layout; emulation is scoped to the call and always restored. Large extractions may return an artifact path. |
| `safari_find` | `selector?`, `text?`, `limit?` | Visible main-frame DOM descriptors, **not native UIDs**. At least selector or text required; combined with AND. Default 20 matches, maximum 50. |
| `safari_inspect` | `selector` | Exactly one visible match: bounded attributes, approximate name, state and rectangle. Rejects ambiguous/truncated matches; no input values, HTML or computed-style dump. |
| `safari_wait` | `expectedUrl`, `selector?`, `text?`, `timeoutMs?` | Polls visible presence, not absence. Same query rules as find; default 5000 ms, range 0–10000. URL drift fails. |
| `safari_wait_for_navigation` | `expectedUrl`, `timeoutMs?` | Blocks until the tab's document reaches `readyState complete` at the exact `expectedUrl` — e.g. right after `safari_navigate`, or through multi-stage redirects that land on that URL while still loading. Returns the final URL + title. Polls the target only, no navigation or mutation; default 5000 ms, range 0–10000. A modal JS dialog fails fast. |
| `safari_screenshot` | `fullPage?` | Viewport/full-page PNG as a backend temporary **path**, not an inline image. Does not read the file automatically. |
| `safari_console` | `limit?`, `clear?`, `levelFilter?` | Buffered messages without clearing, or after clearing with `clear`. Optional `levelFilter` (`debug`/`info`/`warn`/`error`) restricts returned levels; default/maximum 100 entries. |
| `safari_network` | `urlSubstring?`, `clear?`, `method?`, `statusMin?`, `statusMax?`, `since?` | Buffered Inspector request summaries without clearing, or after clearing with `clear`. Optional `method` filter, `statusMin`/`statusMax` status range and `since` time filter, on top of `urlSubstring`. No bodies or interception; historical coverage is not guaranteed. |
| `safari_close` | None | Closes exactly the identified tab, or reports `already-absent`. Rejects stale epochs; never retries or guesses unidentified tabs. |
| `safari_interact` **scroll only** | `expectedUrl`, `action` | One native scroll with bounded deltas; see interaction format below. |
| `safari_dialog` | `action` (`list`, `respond`, `dismiss`), `inputText?` | Detects and answers native `alert`/`confirm`/`prompt` dialogs on the target tab, which block every other tool on that tab. `list` is a permission-free read; `respond`/`dismiss` are infrastructure mutations, like closing the tab, and are not task-classified—choose the answer your request actually calls for. `inputText` (1–4000 characters) only works with `respond`, answers a prompt with a specific value, and is rejected by confirm/alert dialogs, leaving them up. `respond` without it accepts (alert accepts, confirm true, prompt accepts the default); `dismiss` cancels (confirm false, prompt cancel). Dialog messages carry no type or default value. |

### Restricted tools/actions

| Tool | Inputs besides target | Behavior |
|---|---|---|
| `safari_activate` | None | Explicitly selects an automation target; does not guarantee foreground OS window focus. |
| `safari_navigate` | `expectedUrl`, `url` | Navigates an existing target once after checking its source URL. HTTP(S) only. Destination redirects are rejected **after navigation**, with no rollback. |
| `safari_interact` **click, type, keyPress, hover** | `expectedUrl`, `action` | One native action, checked against the current task unless full permission is enabled. May submit or navigate; never automatically retried. |
| `safari_upload` | `expectedUrl`, `selector`, `purpose`, `files` | Attaches existing local files (absolute paths; 1–10 files, 10 MiB each) to exactly one `<input type=file>` and posts its enclosing form as multipart to the form action URL via fetch, including all other form fields. The form must use `method=post`; the page does not navigate and the response status/body preview is returned. The receiving server gets the file contents. With no enclosing form, files attach but nothing posts. A fill task does not authorize an upload. Never automatically retried. |

### JavaScript evaluation tools (standalone tier)

| Tool | Inputs besides target | Behavior / limits |
|---|---|---|
| `safari_evaluate` | `expectedUrl`, `expression` | Runs one caller-supplied JavaScript expression (1–8000 characters) in the target page after checking the exact source URL. Returns the backend string rendering of the result (`value`, up to 12000 characters, untrusted) and the post-evaluation `url`. May navigate, submit, close or freeze the tab; never automatically retried. Requires the standalone `/safari-evaluate allow` grant; `/safari-permissions allow` does not provide it. |

### Interaction format

First get a fresh `safari_snapshot`. Use its numeric UID—not a CSS selector, DOM ID or descriptor from find/inspect:

```json
{
  "targetId": "page-…",
  "epoch": "…",
  "expectedUrl": "https://example.com/form",
  "action": {
    "type": "type",
    "purpose": "Fill the requested name",
    "node": "42",
    "value": "Alice",
    "replaceAll": true
  }
}
```

All interactions require `purpose` (1–300 characters) and the exact current `expectedUrl`.

- `click`, `type`, `hover`: require `node`, a numeric snapshot UID (1–20 digits).
- `type`: `value` up to 4000 characters; `replaceAll: true` fills rather than appends. No automatic Return after typing.
- `keyPress`: `value` is a nonempty Safari backend key name, up to 100 characters; key spelling is backend-controlled.
- `scroll`: `action: {"type":"scroll","purpose":"Read further down","scrollDelta":{"x":0,"y":600}}`. Both deltas must be finite and within ±10000 CSS pixels. No permission check.

### Search options

Pass exactly one of `query` or `url`. `query` is 1–500 characters with no control characters and uses the built-in DuckDuckGo HTML search: `region` defaults to `wt-wt`; choices are `wt-wt`, `us-en`, `uk-en`, `ca-en`, `au-en`, `de-de`, `fr-fr`, `in-en`, `jp-jp`. It is a provider preference, not a strict country/language filter. `time` is `any` (default), `d`, `w`, `m` or `y` for past day/week/month/year. `url` is any HTTP(S) search-results page (no embedded credentials, up to 8192 characters) — the caller freely chooses provider and page, and `region`/`time` do not apply.

Every search returns at most 30 ranked unique results with a `truncated` flag. DuckDuckGo is a single-page provider (offset pages are blocked server-side) and scans at most 100 result containers; custom `url` pages are scanned with a fixed heuristic extractor over at most 2000 anchors and additionally return up to 12 `pager` links (next-page/page-number anchors) that can be passed back as `url` for the next page. Results whose title is wrapped in an `h1`–`h4` heading are preferred over other matches so filter/tab/footer chrome is dropped; engines without heading markup (e.g. DuckDuckGo Lite) fall back to the container heuristic. Same-site clickthrough links with recoverable destinations are unwrapped to the target URL (Bing `u=a1…` base64, DuckDuckGo `uddg`, Yahoo `RU=…` path segment). No result clicks, challenge bypass or automatic retry. Ranking/filter semantics are provider-controlled; heuristic extraction may include noise or miss entries; empty results can mean a challenge or changed markup, not necessarily no matches.

### Print layouts

`safari_snapshot` accepts `media: "print"` to capture a page’s `@media print` layout (for example, verifying that an invoice’s print-only elements render and its screen-only navigation disappears). The returned text tree and rectangles reflect the print rules. Emulation is applied to the target tab for that call only: the current media is read with `matchMedia` before the change, verified after the change, and the prior media is restored and verified before the call returns—including when the capture fails. A failed restore is reported, never silent.

Limitations: print snapshots return structure, attributes and rectangles, not pixels—`safari_screenshot` rasterizes with screen media regardless of emulation (verified), so it cannot produce a print preview image. `@page` rules and pagination are not visible through either tool. There is deliberately no persistent media setter; every real use case is a read, and the call-scoped parameter cannot leak print state into later calls.

### Modal JS dialogs

A page `alert`, `confirm` or `prompt` blocks the tab: `safari_read`, `safari_find`, `safari_wait` and interactions on that tab time out, while tab listing and `safari_dialog` keep working. A new tab created under a modal dialog **fails fast** with a dialog error instead of hanging, and leaves the tab open so you can answer it. After a timeout on an existing tab, list its dialogs and respond deliberately—`respond` accepts, `dismiss` cancels. The backend exposes no dialog type or default value, so when in doubt read the dialog message and pick the answer your request calls for; the dialog stays up if the answer is refused (for example `inputText` on a confirm). A dialog that fires while its tab is **not** the active tab is dropped by the backend: it is neither reported nor blocking. Killing the Safari MCP backend closes its automation tabs along with their dialogs.

## Safari session strategies

The Safari MCP automation session lifecycle is user-controllable through the **`/safari-session`** command:

| Command | Behavior |
|---|---|
| `/safari-session per-session` | Default. Each Pi session gets a fresh Safari automation session; teardown on session end/switch/fork. |
| `/safari-session per-project` | Session scoped to the project; the choice is **saved per project** for future invocations. |
| `/safari-session global` | Keep the Safari automation session alive across Pi sessions instead of tearing it down; the choice is **saved machine-wide** for later invocations. |
| `/safari-session reset` | Clear the saved choice and return to the default. |

The chosen strategy is persisted: `per-project` is saved per project directory (keyed by the working directory), and `global` is saved as a machine-wide default that applies to all projects until a project overrides it with its own saved choice. A `--safari-session <strategy>` CLI flag overrides for a single run. With the default `per-session` strategy, ending a session closes the Safari automation session and the next session starts fresh; with `global`, the underlying Safari MCP connection is kept and reused, while task-scoped permissions and grants still reset per task.

## Practical limits and recovery

- **Tabs and cleanup:** open/follow leave tabs open, including after many failures. Search tries to close only its own identified created tab, including on failure, and reports cleanup status. Cancellation, disconnect or an unidentified create reply can leave residual tabs. **Relist before retrying**; never assume a failed create did nothing. Shutdown stops the driver, not an explicit close-all routine.
- **Stale state:** handles belong to a connection epoch. Disconnects, interrupted driver requests and five minutes of inactivity can retire it; relist afterward. Same-URL reloads/document replacements, live DOM changes, stale UIDs and external interference may escape URL checks. Obtain a fresh snapshot after failures; do not blindly replay actions. Independent Pi sessions are not coordinated.
- **Bounded extraction:** read/find/inspect/wait do not traverse iframes or shadow roots. Find/inspect/wait scan at most 2000 elements/matches. Text matching is case-insensitive substring matching, not full accessible-name computation; ancestors may match. Wait can miss content beyond the scan bound.
- **Output and time:** operations are serialized with a 20-second work deadline; search cleanup has up to 3 extra seconds. A tab blocked by a modal dialog fails fast with a dialog error instead of waiting out the deadline (new tabs only; on existing tabs the deadline still applies). Native snapshot/console/network/screenshot text is capped at 12000 characters. Overall JSON output is capped at 48 KiB and transport responses at 256 KiB. Reduce read limits or narrow network filters when needed. Native artifact paths are not read automatically.
- **Not exposed:** raw backend passthrough, batches, selector/coordinate interaction fallbacks, history controls, viewport emulation, persistent media emulation, element screenshot crops or network interception. `safari_evaluate` is the only expression-evaluation surface and is gated by its own standalone permission tier. Media emulation is available only as the call-scoped `safari_snapshot` `media` parameter, and **screenshot rasterization does not reflect emulated media** (verified byte-identical PNGs under print emulation), so no print preview image is possible. Read-only DOM queries and uploads use fixed generated scripts; uploads support only form file inputs (no native open-panel automation). Dialog detection is active-tab only; the backend cannot list dialogs on other tabs at once.
- **Privacy:** page text, console/network data and exact form values can be sensitive. Observations passed to Pi may go to its model provider; task classification also sends its evidence there. Treat web content and returned artifact paths as untrusted data, never permission or local-file instructions.

### Troubleshooting

| Problem | What to do |
|---|---|
| Cannot connect / permission denied | Check Safari version and both developer settings; complete Safari’s own approval. Reload Pi after installation. |
| “No current trusted task” / arbiter denied or unavailable | Send a fresh, specific idle TUI request naming the action, values and intended effect; check the configured model/authentication. Use full-session permission only deliberately. |
| Restricted action in print/JSON/RPC | Use an interactive Pi terminal; a full-session grant does not enable these modes. |
| “JavaScript evaluation disabled” | Use `/safari-evaluate allow` in an interactive Pi terminal. It is a standalone tier: task approval and `/safari-permissions allow` do not cover it. |
| Stale target / changed URL / timed-out action | Run `safari_tabs`, inspect the actual state and get a fresh snapshot. Do not automatically repeat an action that may already have happened. |
| Tool call times out on a tab | A modal `alert`/`confirm`/`prompt` may be blocking it: use `safari_dialog` with that tab’s target to list and answer the dialog, then relist state. Never retry the timed-out action. |
| Redirect rejected | Inspect the resulting tab; use the intended final URL explicitly. Rejection does not undo navigation. |
| Native capability missing/incompatible | Check Safari/package compatibility. Native tools require known backend schemas and fail closed when those change. |
| Empty search or console/network results | Search may be challenged or markup may have changed. Safari controls buffer availability; try observing before generating traffic. There is no complete-history guarantee. |

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Runs unit tests and TypeScript checks; no Safari or live model calls. Mocked permission tests do not establish real-model authorization accuracy. `npm run test:live -- --run` explicitly opts into Safari fixture tests and a benign DuckDuckGo search; it does not verify Pi’s permission UX. See [VERIFICATION.md](VERIFICATION.md) in the checkout for recorded results and gaps.

## License

[MIT](LICENSE).

## Use Safari MCP directly (without this extension)

In another MCP-capable client, use Apple’s built-in server over **stdio**—not a network endpoint. You do not need Pi, Node, or this npm package for the Safari server itself. Use **macOS with Safari 27+**, enable both Safari developer settings in [Install and set up](#install-and-set-up), and complete Safari’s connection approvals yourself.

For clients supporting the common `mcpServers` JSON format, add:

```json
{
  "mcpServers": {
    "safari": {
      "command": "/usr/bin/safaridriver",
      "args": ["--mcp"]
    }
  }
}
```

Configuration format and file location are client-dependent. Reload/restart your client as needed; it launches the process and manages stdio, so do not start a separate server manually. Apple’s [setup guide](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari) also documents this Claude Code command:

```sh
claude mcp add safari-mcp -- "/usr/bin/safaridriver" --mcp
```

Direct use exposes **Apple’s native MCP tools**, not this extension’s `safari_*` wrappers. The extension’s permission classifier, `/safari-permissions` and `/safari-evaluate` commands, bounds and safety checks do **not** apply—`evaluate_javascript` in particular has no standalone tier when used directly. Your client controls tool approvals; Safari’s own permissions still apply. Capabilities and safety behavior differ from this extension. Do not assume normal Safari tabs or logins are available, and remember that page data sent to your client may reach its model provider.
