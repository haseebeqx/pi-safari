# pi-safari

Six bounded Safari tools for Pi, backed by **Apple’s built-in local Safari MCP server**. The extension manages the MCP connection and launches `/usr/bin/safaridriver --mcp`, communicating over standard input/output.

Already using an MCP-capable client? [You can also use Apple’s Safari MCP server directly, without this extension](#use-safari-mcp-directly-without-this-extension).

## Requirements and installation

- macOS with **Safari 27 or later** and Node **22.19+**.
- In Safari → Settings → Advanced, enable **Show features for web developers**.
- In Safari → Settings → Developer, enable **Allow remote automation and external agents**. Complete any connection approval Safari presents yourself.
- Install from npm with `pi install npm:@haseebeqx/pi-safari`, then reload/restart Pi. For a local checkout, use `pi install /absolute/path/to/pi-safari` or try it temporarily with `pi -e ./src/index.ts` from this repository.
- The package ships TypeScript source; no build step or separate MCP configuration is needed. Pi supplies its host dependencies. Development is checked against Pi 1.2.0; compatibility with every Pi version is not guaranteed.

Enable Safari’s MCP automation permission as described above; the package leaves system settings unchanged. Fresh automation browsing state is supported and expected: do not rely on normal Safari tabs, profile cookies, or existing logins being available. Apple documents isolated windows for WebDriver; the exact scope exposed by MCP is managed by Safari and should not be inferred from a normal Safari window.

Apple documents the integration in [Connecting an AI agent to Safari](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari) and describes the [Safari MCP server](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/). Safari MCP runs locally; page observations passed to Pi may subsequently be sent to the model provider configured in Pi.

## Tools

- `safari_tabs {}` lists at most 100 tabs exposed by the automation session, returning `targetId` and `epoch`, plus available URL/title metadata. No page bodies.
- `safari_open {"url":"https://example.com/"}` creates a **new automation tab**, waits up to approximately 12 seconds for the exact normalized URL to finish loading, and returns its target. Redirects and URL rewrites fail closed. Existing tabs are never navigated.
- `safari_search {"query":"Safari automation","maxResults":5,"region":"us-en","time":"m"}` searches DuckDuckGo HTML in a **new tab** and returns ranked, deduplicated `{rank,title,url,snippet}` results plus the search URL, `truncated` and `cleanup` outcome (no reusable target). Defaults: 5 results, worldwide (`wt-wt`), any time. Limits: 1–500 query characters (no control characters), 1–10 results.
- `safari_close {"targetId":"page-…","epoch":"…"}` closes exactly that automation tab, rejecting stale epochs. An absent tab returns `already-absent`; close is never retried.
- `safari_read {"targetId":"page-…","epoch":"…","maxChars":8000,"maxLinks":20}` extracts body `innerText` and visible link hrefs from that explicit tab. Defaults are 8000 characters/20 links; maxima are 12000/40. Includes truncation flags.
- `safari_follow_link {"targetId":"page-…","epoch":"…","expectedUrl":"https://example.com/","selector":"a.more"}` checks the exact source URL, extracts the href of exactly one visible matching `a[href]`, validates HTTP(S), and opens it in a **new tab**. It never invokes click handlers, submits forms, or navigates the source.

Use the exact target and epoch returned by tabs/open; do not invent them. Read a page before following a CSS-selected link, and supply its returned source URL. Output is capped at 48 KiB of JSON; reduce read limits if escaping causes an oversized-result error.

### Search controls and limitations

`region` is one of `wt-wt`, `us-en`, `uk-en`, `ca-en`, `au-en`, `de-de`, `fr-fr`, `in-en`, `jp-jp`. It sets DuckDuckGo's `kl` region preference, not a strict country/language restriction. `time` is `any`, `d`, `w`, `m`, or `y` (past day/week/month/year), using the provider's `df` filter. Ranking and filter enforcement belong to DuckDuckGo; no custom sorting, arbitrary provider parameters, strict site restriction, safe-search override, or pagination is promised. Query operators can be typed as query text but their semantics are provider-controlled.

The URL is constructed deterministically; no form is submitted and no result is clicked or fetched. Fixed selectors inspect the first 100 result containers, skip recognized ads/hidden or unsafe links, unwrap recognized DuckDuckGo result redirects, and deduplicate canonical URL strings. Ranks are contiguous provider DOM order after filtering, not independent relevance scores. Titles/snippets are limited to 300/600 characters, URLs to 2048. `truncated` means more eligible results or the 100-container scan bound was reached; text fields can also be shortened. Empty output does **not** prove no matches: challenges, blocked requests or changed provider markup may yield no recognized results. There is no challenge bypass or automatic retry. Redirects/URL rewrites fail closed, including provider changes. Search queries go to DuckDuckGo; returned content remains untrusted. No live provider test is part of the automated suite.

### Tab lifecycle

Open/follow operations leave tabs open until the agent calls `safari_close` (or you close them). Search automatically closes only the tab identified by its own create reply, after extracting results and on readiness/extraction failures. It returns `cleanup.status`: `closed`, `already-absent`, `failed`, `unidentified`, or `skipped-retired-epoch`. Search never returns a usable target. Errors retain the original failure as cause and append cleanup outcome.

Cleanup has a separate three-second budget and may run after cancellation only while the original connection epoch remains current. An interrupted driver request retires its epoch; cleanup never reconnects using that old handle. A lost/malformed create reply can leave an unidentified tab; no list-difference guessing, create replay, or unrelated-tab closure is attempted. Failed/unconfirmed cleanup and retired connections may leave residual tabs: relist for manual cleanup before retrying. Shutdown stops the driver, not a tab-closing routine; Safari controls session teardown.

Handles are scoped to a persistent driver connection. A disconnect, cancellation that interrupts a driver request, shutdown, or five minutes of inactivity retires that connection; relist tabs afterward. Do not reuse a saved epoch after reconnection.

## Safety and limits

The Pi-facing surface supports bounded read/extract/open/close. Internally the adapter allows just six Apple MCP tools: tab listing, tab creation, explicit tab switching, tab closing by handle, page information, and JavaScript evaluation with fixed package-generated read/readiness/link/search scripts. The model cannot supply JavaScript or invoke Apple’s broader interaction, navigation, screenshot, or network-inspection tools through this package. Extraction excludes frames and shadow roots. It does not modify source DOM, use identity markers, or claim ownership of pages.

Operations are serialized per Pi extension instance, with a 20-second work deadline (plus up to three seconds for search cleanup), cancellation, a 256-KiB transport response limit, protocol negotiation, required-tool discovery and a `close_tab` input-schema check, and session-scoped handles. A failed or cancelled create is **never retried automatically**. A tab may already exist when a timeout is reported; inspect tabs before retrying. Failed opens and smoke tests leave their tabs open for manual inspection. Shutdown stops the driver process, not a sequence of tab-close commands; Safari controls its session lifecycle.

Safari’s MCP extraction APIs operate on a current browsing context. The adapter selects an explicit handle before extraction and checks URLs and tab presence afterward. These are best-effort stale-read checks: same-URL reloads/replacements, a context switch to another page with the same URL, live DOM changes, or external interference may go undetected. Tab handles do not identify documents or authorize mutation. Concurrent independent Pi sessions are not coordinated by this package.

Web content is untrusted data. Opening a URL can have server-side effects, including in accounts signed into within the automation session. Safari’s isolation does not make every visited website or requested action safe.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the unit tests, TypeScript check and npm tarball dry-run assertions; it never starts Safari. The same checks run before `npm publish`. Host Pi and TypeBox packages are peer dependencies, also pinned as development dependencies for reproducible local checks. Automated tests mock the driver’s JSON-RPC stream and execute the actual extraction scripts in VM/DOM fixtures. They cover handshake compatibility, bounds, malformed replies, stale targets, cancellation, serialization, redirect rejection, and creation without replay.

An explicit real-Safari smoke test opens two disposable local fixture tabs, exercises `safari_tabs`, `safari_open`, `safari_read` and `safari_follow_link` (not `safari_close` or external search), checks visibility and preservation of the source URL, and leaves the tabs open:

```sh
PI_SAFARI_LIVE_TEST=1 npm run test:safari
```

Requires informed manual enablement of Safari remote automation. It does not change settings, sign into sites, or navigate/close existing tabs. The local fixture server stops when the test finishes.

### Validation boundaries

Automated fixtures do not establish live Safari or DuckDuckGo reliability. The opt-in smoke test does not validate search or tab closing. Manual checks still needed for a release include clean permission setup/denial, Safari restart/disconnect and idle expiry, tab replacement/reordering, concurrent Pi clients, authentication within automation state, and Safari updates. Required-tool discovery does not validate every Apple tool schema; changes to Safari APIs or provider markup can break operations.

## Use Safari MCP directly (without this extension)

If your AI client supports local MCP servers over **stdio**, you can connect to Apple’s Safari MCP server without installing Pi or this extension.

1. Use macOS with **Safari 27 or later** and enable both Safari developer settings listed in [Requirements and installation](#requirements-and-installation). Complete any Safari connection approval yourself.
2. Add a server to your client’s MCP configuration with command `/usr/bin/safaridriver` and argument `--mcp`. For clients using the common `mcpServers` JSON format:

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

3. Reload your client’s MCP configuration (or restart the client), then enable the Safari tools it discovers. Your client launches the server and manages the stdio connection; you do not need to run it separately in a terminal.

Configuration file locations and formats vary by client; consult your client’s MCP setup instructions. Node and this npm package are not required for direct use. See Apple’s [Connecting an AI agent to Safari](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari) for the official setup guide.

Direct connections expose Apple’s tools, **not** this extension’s `safari_*` interface or its bounds and safety checks. Review your client’s tool permissions before allowing browser actions. Do not assume normal Safari tabs or logins are available; page content sent to your AI client may be forwarded to its model provider.

## License

[MIT](LICENSE).
