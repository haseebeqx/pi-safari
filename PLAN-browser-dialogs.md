# Plan: expose `browser_dialogs` (safari_dialog)

## Problem

Apple Safari MCP's `evaluate_javascript`, `page_info` and `page_interactions` block while a
native JS modal (`alert`/`confirm`/`prompt`) is up on the active tab. Every wrapper tool that
touches that tab hangs until the 20 s transport timeout kills the whole connection, rejects
all pending calls, and rotates the epoch — so the agent loses the session it needs to recover.
The backend already ships a driver-level `browser_dialogs` tool that works **while the modal
is up**; we simply don't expose it.

## Verified backend behavior (live probe, Safari MCP 1.0.0, `tools/list` + calls)

- Schema (exact, from `tools/list`):
  ```json
  {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["list", "respond", "dismiss"] },
      "inputText": { "type": "string" }
    }
  }
  ```
- **Session-scoped: no tab handle.** It acts on the *active* tab only.
- `list` while a modal is up → `{"dialogs":[{"message":"Type secret?"}]}` — does **not** hang.
  Only `message` is reported: **no dialog type** (alert/confirm/prompt) and no default value.
- `respond` (+ optional `inputText`) → `"Dialog accepted"`; `dismiss` → `"Dialog dismissed"`.
  Afterwards `page_info`/JS work again and `list` returns `{"dialogs":[]}`.
- `list_tabs` also works while a modal is up (driver-level).
- `create_tab` makes the new tab active, so a modal on a just-opened tab is immediately
  visible to `browser_dialogs list`.

### Open questions to resolve by probe **before** implementation (gate)

| # | Question | Affects |
|---|----------|---------|
| P1 | Does `switch_tab` to a tab with a modal up succeed (valid handle)? (My probe passed a malformed handle, so this is unverified.) | Whether `safari_dialog` can operate on an explicit target that isn't already active |
| P2 | Does `close_tab` work on a tab with a modal up? | `withTab`/`safari_open` cleanup path when a dialog fails fast |
| P3 | `respond` with **no** `inputText` on a prompt: accepts default, empty, or errors? | Whether `inputText` must be conditionally required; result wording |
| P4 | `respond`/`inputText` on alert/confirm: ignored or error? | Validation strictness (keep permissive, document) |
| P5 | `respond`/`dismiss` with no dialog pending: backend error shape? | Friendly pre-check error (we plan to `list` first regardless) |
| P6 | Can we `switch_tab` *away from* a frozen tab and work on another? | Documentation of recovery workflow |
| P7 | After a timeout rotates the epoch (new driver connection), does the dialog persist and is it listable/respondable on the new connection? | Post-timeout recovery story in README |

## Design

### 1. `src/backend-schemas.ts`
Add the exact `browser_dialogs` schema above. It enters the conservative
schema-match `supported` set automatically; incompatible drift fails closed
("Safari capability unavailable"). No change to `REQUIRED`.

### 2. `src/safari.ts` — `Safari.dialog(t, action, inputText?, signal?)`

New method; deliberately **does not** reuse `observe`/`checkedBackend`/`atURL` because
they call `page_info`, which hangs while a modal is up.

Flow (all steps non-hanging while a modal is up):
1. Synchronous validation (before any transport work, like `validateInteraction`):
   - `action` ∈ `list | respond | dismiss`; `inputText` only with `respond`;
     string, 1–4000 chars; no unknown fields.
2. `select(t, signal)` — `list_tabs` + `switch_tab` only (driver-level, verified
   pattern), gives the backend the right active tab. Depends on P1.
3. `browser_dialogs { action: 'list' }` pre-check (never hangs):
   - `action === 'list'` → return the bounded list.
   - `respond`/`dismiss` with empty list → clear local error
     "No pending dialog on this tab" (never dispatch respond/dismiss blindly; see P5).
4. Dispatch `mutate('browser_dialogs', { action, ...inputText? }, signal)` — one dispatch,
   no retry. `mutate` (non-infrastructure) so authorization is re-checked just before
   send, and epoch rotation between approval and dispatch fails closed.
5. Post-verification **without `page_info`**:
   - `this.target(t)` (local epoch check),
   - `browser_dialogs list` → expect `[]` (if non-empty, report that other/queued dialogs remain),
   - `list_tabs` → tab still exists.
6. Result: `{ ...t, url? (omitted — we don't page_info), action, dialogsRemaining, note }`,
   `bound()`, note states dialogs are reported for the active tab, no type info,
   and that respond/dismiss each commit a page-flow decision (accept/cancel).

Authorization split:
- `list` → permission-free read (like `safari_console`/`safari_snapshot`).
- `respond`/`dismiss` → approved mutations (see 4).

### 3. `src/index.ts` — new tool `safari_dialog`

```
parameters: { ...Target,
  action: Union('list' | 'respond' | 'dismiss'),
  inputText?: String(1..4000) }
annotations: set per branch (see execute below)
```
- `action === 'list'` → plain `execute`, `readOnlyHint: true` semantics, no approval.
- `respond`/`dismiss` → `approval.run(ctx, 'dialog', ...)` with
  `details: { args, targetContext: safari.permissionContext(...) }` so the arbiter
  sees the exact action and inputText.
- Description must state: native alert/confirm/prompt handling; acts on the named tab
  (made active first); `list` is safe while the tab is frozen and reports messages
  only (no type/default); `respond` accepts (use `inputText` for prompts), `dismiss`
  cancels; tab may be frozen by a modal — every other tool against it will time out.

`annotations` are static per tool; since only one tool covers three branches, annotate
`readOnlyHint: false` on the tool and let the description carry the read-only nature of
`list` (consistent with how `safari_interact` documents its scroll exception).

### 4. `src/permissions.ts`
- Add `'dialog'` to `ACTION_SCOPES`.
- `ARBITER_PROMPT` guidance (short paragraph):
  - Dialogs are native page modals; handling them is how a frozen tab is unblocked.
  - `respond` commits the page's forward path; `inputText` is delivered to the page as
    if the user typed it — approve only values that match the user's task.
  - `dismiss` is the cancel path (e.g. confirm→false, leave-site→stay).
  - A frozen tab is not by itself a task; the current user request must justify the
    specific answer or cancellation.

### 5. Fail-fast dialog detection in existing loops (removes the 20 s freeze on the common paths)

- `create()` polling loop (used by `safari_open`, `safari_fetch`, `safari_search`):
  at the top of each poll iteration, call `browser_dialogs { list }` **before**
  `page_info`. Non-empty → throw a clear error:
  "A modal JavaScript dialog is blocking the new tab (message: …). Tab left open;
  relist tabs and use safari_dialog to respond or dismiss."
  `create_tab` is still dispatched exactly once. Cleanup (`withTab`/`closeTarget`)
  then attempts `close_tab` — fine if P2 says it works; if P2 says close hangs on a
  modal, make `cleanup()` skip close when a dialog is present and report
  `{ status: 'failed', note: 'Modal dialog blocks close; use safari_dialog, then safari_close' }`.
- `waitData()` loop (used by `safari_wait` and `safari_fetch` settle): same pre-check,
  fail fast with the same message instead of one poll hanging 20 s and killing the
  whole connection mid-wait.

### 6. `src/mcp.ts` — timeout message
Append to the 20 s abort error: "If the page has a modal JS dialog (alert/confirm/prompt),
relist tabs and use safari_dialog; the dialog survives connection resets (verify P7)."
No behavior change: we do **not** try to rescue the transport on timeout.

### 7. Docs & versioning
- `README.md`:
  - Tool table row for `safari_dialog` (permission column: `list` no; `respond`/`dismiss` yes).
  - New "Modal JS dialogs" section: symptom (every tool call on the tab times out and the
    epoch rotates) → workflow (`safari_dialog` list → respond/dismiss → re-read);
    active-tab-only reporting; no dialog type in list (respond = accept, dismiss = cancel;
    use `inputText` when a prompt is expected); fail-fast errors from open/fetch/wait.
  - Troubleshooting table row (near line 142).
- `package.json` 0.2.1 → 0.3.0 (new user-facing tool). Note: `src/version.ts` says
  `0.1.0` while package.json says 0.2.1 — pre-existing drift; reconcile both to 0.3.0
  (or wire version.ts to the package version) as part of this change.

## Tests

### Unit — `test/safari.test.ts` (extend `Browser` mock with a `browser_dialogs` case)
- `list`: returns bounded `dialogs`; call sequence `list_tabs, switch_tab, browser_dialogs`;
  **no** `page_info` anywhere; runs without authorization (authorize that throws).
- `respond`/`dismiss` with empty list → friendly error, `respond`/`dismiss` never dispatched.
- `respond` happy path: dispatches `browser_dialogs` exactly once with `inputText`;
  post-verifies with `list` + `list_tabs`; never calls `page_info`.
- `dismiss` without `inputText` accepted; `inputText` on `list`/`dismiss` throws;
  `inputText` > 4000 throws; unknown action throws; all before any transport call.
- Stale epoch / missing target rejected (no calls).
- `create()` loop: mock returns a dialog on `browser_dialogs list` → `open()` rejects
  fast (/modal JavaScript dialog/), `create_tab` dispatched exactly once, tab left open.
- `wait()` loop: dialog present → rejects /dialog/, does not hang.
- `mutate` re-check: authorization revoked between pre-check and dispatch → rejected,
  nothing dispatched (mirrors existing queued-approval test).

### `test/mcp.test.ts` / `test/extension.test.ts`
- `BACKEND_SCHEMAS.browser_dialogs` present; `SafariMCP` accepts it via `supported`
  matching and rejects a drifted schema (fail-closed path already covered generically).
- `safari_dialog` registered: parameter shape, `list` branch executes without ctx/approval,
  `respond`/`dismiss` branch requires approval (deny path → /permission/ error, no call).

### `test/permission-arbiter.test.ts`
- `'dialog'` in `ACTION_SCOPES`; a `dialog` proposal with `inputText` is denied without a
  matching user request (uses existing harness).

### Live smoke — `scripts/live-smoke.ts`
Add fixture routes `/dialog-prompt` (prompt 300 ms after load, records answer to
`#state`) and `/dialog-confirm` (confirm; button result recorded). New checks:
- `open('/dialog-prompt')` rejects within ~1 s (not 20 s) mentioning dialog; tab left open.
- `safari_dialog(list)` on that tab shows the message.
- `safari_dialog(respond, inputText:'smoke')` → page unblocked, `find('#state')` shows
  the accepted value; no epoch rotation (assert `native.epoch` unchanged).
- `/dialog-confirm`: `dismiss` → unblocked, page shows the cancel branch.
- P1/P2/P6/P7 assertions fold in here (switch to modal tab, close modal tab,
  switch away, fresh connection after kill).

## Out of scope (document, don't build)
- Auto-handling dialogs on the agent's behalf (no implicit dismiss anywhere).
- Reporting dialog type/default value (backend limitation).
- Cross-tab dialog discovery (backend is active-tab-only).
- Changing the 20 s transport timeout or trying to salvage a timed-out connection.

## Implementation order
1. Probe P1–P7 (single throwaway script, disposable automation tabs only).
2. `backend-schemas.ts` + `Safari.dialog` + unit tests (mock transport).
3. `safari_dialog` tool in `index.ts` + `permissions.ts` scope/prompt + arbiter tests.
4. Fail-fast detection in `create()`/`waitData()` + mcp timeout message + unit tests.
5. Live-smoke fixture routes + checks; run `npm run check` and `npm run test:live -- --run`.
6. README + version bump.

---

## Implementation complete (2026-10-18)

Probe results that shaped the final design:

- **P1/P6:** `switch_tab` to/from a modal tab works with raw handles; other tabs stay usable.
- **P2:** `close_tab` on a modal tab works.
- **P3:** `respond` without `inputText` accepts (prompt takes its default).
- **P4 (critical):** `respond` *with* `inputText` on a confirm/alert **errors and leaves the dialog up**. `inputText` is prompt-only.
- **P5:** `respond`/`dismiss` with no pending dialog → backend error "No JavaScript dialog is showing."
- **P7:** Killing the safaridriver process closes all automation tabs, so a dialog cannot outlive the driver session.
- **New finding:** a dialog that fires while its tab is **not the active tab** is dropped by the backend — never reported, never blocking. Only active-tab dialogs exist.

Final decisions (lighter touch than the original plan):

- No `'dialog'` arbiter scope; `respond`/`dismiss` are infrastructure mutations like `close_tab` (local-only, never replayed). `list` is a plain read. All documented as always-allowed in the README.
- `Safari.dialog(target, action, inputText?)`: validate → pre-check `browser_dialogs list` after `select` → fail fast on empty list → single `mutate` dispatch → post-verify with `browser_dialogs list` + `list_tabs` only (no `page_info`; result omits URL).
- Fail-fast dialog check in `create()` (open/fetch/search) and `waitData()` (wait/fetch settle): a non-empty dialog list throws immediately instead of hanging 20 s; created tab is left open for `safari_dialog`.
- `inputText` 1–4000 chars, `respond` only. `list` messages truncated to 300 chars.
- Timeout/abort message in `mcp.ts` now mentions modal JS dialogs and points at `safari_dialog`.
- Version reconciled and bumped to **0.3.0** (`package.json` + `src/version.ts`).

Verified: `npm run check` (75 unit tests + tsc) green; `npm run test:live -- --run` green across 3 runs including new checks `dialog.open-fails-fast` (~150 ms), `dialog.list+respond` (prompt answered with `inputText`), `dialog.dismiss` (confirm cancelled) and `dialog.none-pending` (local fail-fast).
