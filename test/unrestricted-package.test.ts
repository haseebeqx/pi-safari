import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import safeExtension from '../src/index.ts';
import unrestrictedExtension from '../src/index-unrestricted.ts';
import { EvaluationGrant, SessionApproval } from '../src/permissions.ts';
import { createSafariSessionStrategyStore, setDefaultSafariSessionStrategyStore } from '../src/session-strategy.ts';

const context = (mode = 'tui', notes: [string, string][] = []) => ({ mode, hasUI: mode === 'tui', ui: { notify(m: string, l: string) { notes.push([m, l]); } } }) as any;

function load(extension: (pi: ExtensionAPI) => void) {
  const events = new Map<string, any>();
  setDefaultSafariSessionStrategyStore(createSafariSessionStrategyStore());
  extension({ registerTool() {}, registerCommand() {}, registerFlag() {}, getFlag() { return undefined; }, on(n: string, h: any) { events.set(n, h); } } as unknown as ExtensionAPI);
  return events;
}

test('grant() skips the task classifier but keeps the interactive requirement; reset clears it', async () => {
  const approval = new SessionApproval();
  // No user request and no model: without a grant this must fail closed.
  await assert.rejects(approval.run(context(), 'click', async () => 'ran', undefined, { args: {} }), /disabled/);
  approval.grant();
  assert.equal(await approval.run(context(), 'click', async () => { approval.require(); return 'ran'; }, undefined, { args: {} }), 'ran');
  await assert.rejects(approval.run(context('rpc'), 'click', async () => 'ran'), /noninteractive/);
  approval.reset();
  await assert.rejects(approval.run(context(), 'click', async () => 'ran', undefined, { args: {} }), /disabled/);

  const evaluation = new EvaluationGrant();
  assert.throws(() => evaluation.require(context()), /disabled/);
  evaluation.grant();
  evaluation.require(context());
  assert.throws(() => evaluation.require(context('rpc')), /noninteractive/);
});

test('grant({ noninteractive }) also allows print/JSON/RPC modes; reset and a manual allow drop it', async () => {
  const approval = new SessionApproval();
  approval.grant({ noninteractive: true });
  for (const mode of ['print', 'json', 'rpc', 'tui']) {
    assert.equal(await approval.run(context(mode), 'click', async () => { approval.require(context(mode)); return 'ran'; }), 'ran');
  }
  approval.reset();
  await assert.rejects(approval.run(context('rpc'), 'click', async () => 'ran'), /noninteractive/);
  approval.grant({ noninteractive: true });
  await approval.command('allow', context()); // a manual session grant keeps the interactive requirement
  await assert.rejects(approval.run(context('rpc'), 'click', async () => 'ran'), /noninteractive/);

  const evaluation = new EvaluationGrant();
  evaluation.grant({ noninteractive: true });
  for (const mode of ['print', 'json', 'rpc', 'tui']) evaluation.require(context(mode));
  evaluation.reset();
  assert.throws(() => evaluation.require(context('rpc')), /disabled/);
});

test('unrestricted entry announces pre-approved grants on session start; safe entry stays silent', async () => {
  const unrestrictedNotes: [string, string][] = [];
  await load(unrestrictedExtension).get('session_start')({}, context('tui', unrestrictedNotes));
  assert.equal(unrestrictedNotes.length, 1);
  assert.equal(unrestrictedNotes[0][1], 'warning');
  assert.match(unrestrictedNotes[0][0], /restricted actions and JavaScript evaluation pre-approved/);
  // The unrestricted entry grants in every mode; the notice is only shown where there is a UI.
  const printNotes: [string, string][] = [];
  await load(unrestrictedExtension).get('session_start')({}, context('print', printNotes));
  assert.deepEqual(printNotes, []);

  const safeNotes: [string, string][] = [];
  await load(safeExtension).get('session_start')({}, context('tui', safeNotes));
  assert.deepEqual(safeNotes, []);
});

test('stage-unrestricted builds a separately named package with the same version and unrestricted entry point', () => {
  const root = new URL('..', import.meta.url).pathname;
  const out = mkdtempSync(join(tmpdir(), 'pi-safari-unrestricted-'));
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/stage-unrestricted.ts'), out], { stdio: 'pipe' });
    const safe = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const unrestricted = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
    assert.equal(unrestricted.name, '@haseebeqx/pi-safari-unrestricted');
    assert.equal(unrestricted.version, safe.version);
    assert.deepEqual(unrestricted.pi.extensions, ['./src/index-unrestricted.ts']);
    assert.deepEqual(unrestricted.peerDependencies, safe.peerDependencies);
    assert.equal(unrestricted.scripts, undefined);
    assert.equal(unrestricted.devDependencies, undefined);
    assert.ok(existsSync(join(out, 'src/index-unrestricted.ts')));
    assert.ok(existsSync(join(out, 'LICENSE')));
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    assert.match(readme, /unrestricted variant/);
    assert.match(readme, /pi install npm:@haseebeqx\/pi-safari-unrestricted/);
    assert.doesNotMatch(readme, /pi-safari-unrestricted-unrestricted/);
    assert.ok(safe.files.includes('!src/index-unrestricted.ts'), 'safe package must not ship the unrestricted entry point');
  } finally { rmSync(out, { recursive: true, force: true }); }
});
