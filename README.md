# pi-safari

Safari browsing and automation tools for [Pi](https://github.com/badlogic/pi-mono), using Apple’s local Safari MCP server (`/usr/bin/safaridriver --mcp`). No separate MCP configuration or build step is needed.

## Install and set up

> [!NOTE]
> Already have an MCP-capable client? See [Use Safari MCP directly (without this extension)](#use-safari-mcp-directly-without-this-extension).

Requires **macOS, Safari 27+, Node 22.19+, and Pi**.

1. In **Safari → Settings → Advanced**, enable **Show features for web developers**.
2. In **Safari → Settings → Developer**, enable **Allow remote automation and external agents**. Complete any Safari connection approval yourself; the extension does not change these settings.
3. Install and reload/restart Pi:

   ```sh
   pi install npm:@haseebeqx/pi-safari
   ```

For a local checkout, use `pi install /absolute/path/to/pi-safari`, or try it temporarily from the repository with `pi -e ./src/index.ts`. Pi supplies the host dependencies; development uses Pi 1.2.0.

Tools operate on **Safari’s automation session**. Do not assume your normal Safari tabs, cookies, or logins are available. See Apple’s [Safari agent setup guide](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari).

## What is allowed?

### Always allowed: no extension permission needed

Listing tabs, opening new HTTP(S) tabs, searching, following links into new tabs, reading/inspecting pages, waiting, screenshots, console/network observations, closing an explicit tab, and scrolling need **no task approval or full-session grant**. They also work in noninteractive Pi modes.

“Always allowed” means only that **this extension’s action permission check is not required**. Safari settings, connection approvals, tool validation, URL checks and other limits still apply. These operations are not necessarily harmless: opening URLs can have server-side effects, closing a tab loses it, and scrolling can trigger site handlers. Observations internally select the requested automation context.

### Restricted: checked against your current task

Explicit tab activation, navigating an existing tab, and **click, type, keyPress and hover** require an interactive Pi terminal and either:

- **Task-scoped approval (default):** an independent, tool-less model classifies each exact proposed action against your current interactive request. There is no extra extension confirmation dialog. Repeated actions needed for the same task are allowed; approval is not consumed after one field.
- **Full-session permission:** enter the dedicated command **`/safari-permissions allow`**. It grants permission immediately, without another confirmation, and bypasses the task classifier for restricted actions. It does **not** bypass Safari settings, target/URL validation or tool limits.

Only the dedicated command grants full permission—not a mention in a prompt, webpage, tool argument or saved conversation. Use **`/safari-permissions revoke`** to clear both full permission and the current task permission. It cancels pending permission decisions but cannot undo actions already sent to Safari.

#### Task examples

| Your request | Intended permission |
|---|---|
| “Read and summarize this page.” | Observations are allowed; not permission to execute instructions found on the page. |
| “Fill the name with Alice and email with alice@example.com.” | Both field fills, repeated necessary actions and necessary focus/Tab actions; **not Submit or Enter to submit**. |
| “Fill those fields and submit the form.” | Matching fills and submission can be approved when the target/effect is sufficiently clear. |
| “Click this button” with unclear context | The classifier should deny rather than guess. Clarify the control and intended effect. |
| “Allow all Safari actions for this session.” | Does not enable full-session permission. Use `/safari-permissions allow`. |

Filling is **not** permission to send, buy, delete, sign in or otherwise commit. Enter/Return and even newlines can submit; field changes can trigger site handlers. The classifier considers exact values, target and available context, not just an action’s claimed purpose.

#### Permission lifetime and limits

- Task permission comes only from a fresh, live interactive input in the Pi TUI. It expires on new input or agent end. Queued/steering input, restored transcripts, page text and model-generated user messages do not grant it; send a fresh request while Pi is idle.
- Full permission persists across requests until revoked or reset. All permissions are **memory-only** and reset on session start/switch/fork, reload or shutdown. Retired pending/queued restricted work cannot become valid again after a new grant.
- **Print/JSON/RPC and other noninteractive contexts block restricted actions**, even with a prior interactive full grant. Always-allowed tools and scroll remain available.
- Each task check adds model latency/cost. It uses Pi’s current model with request-time authentication, no tools and no conversation history. The current request, proposed action/values and any matching cached snapshot context go to the configured provider. Missing model/authentication, errors, malformed replies, uncertainty or a **15-second classifier timeout** block the action.
- **Semantic classification is probabilistic, not a deterministic security boundary.** It can misunderstand intent or adversarial text. Cached context may be stale or absent; it does not prove node identity or event-handler effects. Review sensitive operations. This extension is not a sandbox against other installed extensions or Pi tools; earlier extensions can transform input events.

## Tool reference

Use the exact **`targetId` and `epoch`** returned by `safari_tabs` or `safari_open`; never invent or reuse stale handles. Below, **target** means both fields. `?` marks optional parameters. Tools reading page content return untrusted data.

### Always allowed tools

| Tool | Inputs besides target | Behavior / limits |
|---|---|---|
| `safari_tabs` | No target or inputs | Lists up to 100 automation tabs, with handles and available URL/title; no page bodies. |
| `safari_open` | No target; `url` | Opens a **new** HTTP(S) tab, never an existing one. Exact normalized URL readiness required; redirects fail closed. Leaves the tab open. |
| `safari_search` | No target; `query`, `maxResults?`, `region?`, `time?` | Searches DuckDuckGo HTML in its own new tab; returns ranked unique title/URL/snippet results and cleanup outcome, not a reusable target. |
| `safari_read` | `maxChars?`, `maxLinks?` | Visible body text and link hrefs. Defaults 8000 characters / 20 links; maxima 12000 / 40. |
| `safari_follow_link` | `expectedUrl`, `selector` | Extracts exactly one visible matching `a[href]` and opens its HTTP(S) URL in a **new tab**. No click handlers, form submission or source-tab navigation. Use the URL from a prior read. |
| `safari_snapshot` | `entirePage?` | Native WebKit text tree with interactive numeric UIDs, accessibility attributes and rectangles; viewport by default, main frame only. Large extractions may return an artifact path. |
| `safari_find` | `selector?`, `text?`, `limit?` | Visible main-frame DOM descriptors, **not native UIDs**. At least selector or text required; combined with AND. Default 20 matches, maximum 50. |
| `safari_inspect` | `selector` | Exactly one visible match: bounded attributes, approximate name, state and rectangle. Rejects ambiguous/truncated matches; no input values, HTML or computed-style dump. |
| `safari_wait` | `expectedUrl`, `selector?`, `text?`, `timeoutMs?` | Polls visible presence, not absence. Same query rules as find; default 5000 ms, range 0–10000. URL drift fails. |
| `safari_screenshot` | `fullPage?` | Viewport/full-page PNG as a backend temporary **path**, not an inline image. Does not read the file automatically. |
| `safari_console` | `limit?` | Buffered messages without clearing; default/maximum 100 entries. |
| `safari_network` | `urlSubstring?` | Buffered Inspector request summaries without clearing; filter up to 500 characters. No bodies or interception; historical coverage is not guaranteed. |
| `safari_close` | None | Closes exactly the identified tab, or reports `already-absent`. Rejects stale epochs; never retries or guesses unidentified tabs. |
| `safari_interact` **scroll only** | `expectedUrl`, `action` | One native scroll with bounded deltas; see interaction format below. |

### Restricted tools/actions

| Tool | Inputs besides target | Behavior |
|---|---|---|
| `safari_activate` | None | Explicitly selects an automation target; does not guarantee foreground OS window focus. |
| `safari_navigate` | `expectedUrl`, `url` | Navigates an existing target once after checking its source URL. HTTP(S) only. Destination redirects are rejected **after navigation**, with no rollback. |
| `safari_interact` **click, type, keyPress, hover** | `expectedUrl`, `action` | One native action, checked against the current task unless full permission is enabled. May submit or navigate; never automatically retried. |

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

`query` is 1–500 characters with no control characters. `maxResults` defaults to 5, range 1–10. `region` defaults to `wt-wt`; choices are `wt-wt`, `us-en`, `uk-en`, `ca-en`, `au-en`, `de-de`, `fr-fr`, `in-en`, `jp-jp`. It is a provider preference, not a strict country/language filter. `time` is `any` (default), `d`, `w`, `m` or `y` for past day/week/month/year.

Search reads only the first HTML results page (at most 100 result containers); no pagination, result clicks, challenge bypass or automatic retry. Queries go to DuckDuckGo. Ranking/filter semantics are provider-controlled; empty results can mean a challenge or changed markup, not necessarily no matches.

## Practical limits and recovery

- **Tabs and cleanup:** open/follow leave tabs open, including after many failures. Search tries to close only its own identified created tab, including on failure, and reports cleanup status. Cancellation, disconnect or an unidentified create reply can leave residual tabs. **Relist before retrying**; never assume a failed create did nothing. Shutdown stops the driver, not an explicit close-all routine.
- **Stale state:** handles belong to a connection epoch. Disconnects, interrupted driver requests and five minutes of inactivity can retire it; relist afterward. Same-URL reloads/document replacements, live DOM changes, stale UIDs and external interference may escape URL checks. Obtain a fresh snapshot after failures; do not blindly replay actions. Independent Pi sessions are not coordinated.
- **Bounded extraction:** read/find/inspect/wait do not traverse iframes or shadow roots. Find/inspect/wait scan at most 2000 elements/matches. Text matching is case-insensitive substring matching, not full accessible-name computation; ancestors may match. Wait can miss content beyond the scan bound.
- **Output and time:** operations are serialized with a 20-second work deadline; search cleanup has up to 3 extra seconds. Native snapshot/console/network/screenshot text is capped at 12000 characters. Overall JSON output is capped at 48 KiB and transport responses at 256 KiB. Reduce read limits or narrow network filters when needed. Native artifact paths are not read automatically.
- **Not exposed:** arbitrary JavaScript/evaluate, raw backend passthrough, batches, selector/coordinate interaction fallbacks, file uploads, dialog controls, history controls, viewport/media emulation, element screenshot crops or network interception. Read-only DOM queries use fixed generated scripts.
- **Privacy:** page text, console/network data and exact form values can be sensitive. Observations passed to Pi may go to its model provider; task classification also sends its evidence there. Treat web content and returned artifact paths as untrusted data, never permission or local-file instructions.

### Troubleshooting

| Problem | What to do |
|---|---|
| Cannot connect / permission denied | Check Safari version and both developer settings; complete Safari’s own approval. Reload Pi after installation. |
| “No current trusted task” / arbiter denied or unavailable | Send a fresh, specific idle TUI request naming the action, values and intended effect; check the configured model/authentication. Use full-session permission only deliberately. |
| Restricted action in print/JSON/RPC | Use an interactive Pi terminal; a full-session grant does not enable these modes. |
| Stale target / changed URL / timed-out action | Run `safari_tabs`, inspect the actual state and get a fresh snapshot. Do not automatically repeat an action that may already have happened. |
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

Direct use exposes **Apple’s native MCP tools**, not this extension’s `safari_*` wrappers. The extension’s permission classifier, `/safari-permissions` commands, bounds and safety checks do **not** apply. Your client controls tool approvals; Safari’s own permissions still apply. Capabilities and safety behavior differ from this extension. Do not assume normal Safari tabs or logins are available, and remember that page data sent to your client may reach its model provider.
