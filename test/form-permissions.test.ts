import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionApproval } from '../src/permissions.ts';
import { Safari, type Interaction } from '../src/safari.ts';
import type { Transport, ToolReply } from '../src/mcp.ts';

// Mocked integration, not a live WebKit/UI test: only the transport and UI are
// fixtures. The real SessionApproval and Safari dispatch/authorization are used.
const url = 'https://fixture.example/form';
const reply = (data: unknown): ToolReply => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
class FormTransport implements Transport {
  epoch = 'fixture';
  tabs = new Map([['form', url]]);
  selected = 'form';
  fields = { name: '', email: '' };
  submissions: typeof this.fields[] = [];
  calls: { name: string; args: Record<string, unknown> }[] = [];
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, beforeSend?: () => void): Promise<ToolReply> {
    if (signal?.aborted) throw Error('cancelled');
    beforeSend?.();
    this.calls.push({ name, args });
    const currentUrl = () => this.tabs.get(this.selected)!;
    switch (name) {
      case 'list_tabs': return reply([...this.tabs].map(([handle, url]) => ({ handle, url })));
      case 'switch_tab': this.selected = String(args.handle); return reply('selected');
      case 'browser_dialogs': return reply({ dialogs: [] });
      case 'page_info': return reply({ url: currentUrl() });
      case 'create_tab': {
        const handle = `new-${this.tabs.size}`;
        this.tabs.set(handle, String(args.url)); return reply({ handle });
      }
      case 'close_tab': this.tabs.delete(String(args.handle)); return reply('closed');
      case 'get_page_content': return { content: [{ type: 'text', text: '1 textbox Name\n2 textbox Email\n3 button Submit' }] };
      case 'evaluate_javascript': {
        // Upload expressions cannot run against the DOM fixture; return the fixed
        // multipart result the real script produces on the live smoke run.
        if (String(args.expression).includes('DataTransfer')) {
          return reply(JSON.stringify({ attached: true, submitted: true, files: 1, action: url, status: 200, contentType: 'text/html', body: 'ok' }));
        }
        // Execute the actual fixed read/readiness/search scripts against a small
        // DOM fixture; search intentionally models an empty results page.
        const result = vm.runInNewContext(`(function(){${args.expression}})()`, {
          URL, location: { href: currentUrl() },
          document: { title: 'Example form', readyState: 'complete', body: { innerText: 'Name Email Submit' }, querySelectorAll: () => [] },
        });
        return reply(result);
      }
      case 'page_interactions': {
        const actions = args.interactions as Interaction[];
        assert.equal(actions.length, 1);
        const action = actions[0];
        if (action.type === 'type') {
          const key = action.node === '1' ? 'name' : action.node === '2' ? 'email' : undefined;
          assert.ok(key, 'unknown fixture input UID');
          this.fields[key] = action.replaceAll ? action.value! : this.fields[key] + action.value!;
        } else {
          assert.equal(action.type, 'click'); assert.equal(action.node, '3');
          this.submissions.push({ ...this.fields });
        }
        return reply('done');
      }
      default: throw Error(`Unexpected fixture call: ${name}`);
    }
  }
  close() {}
}
function setup() {
  const approval = new SessionApproval(), backend = new FormTransport();
  const ctx = { mode: 'tui', hasUI: true, ui: {
    confirm: async () => { assert.fail('implicit/command permission must not prompt'); }, notify() {},
  } } as any;
  let decisions = 0;
  const evidence: any[] = [];
  ctx.model = { id: 'mock' };
  ctx.modelRegistry = { streamSimple(_model: unknown, context: any) {
    decisions++;
    assert.equal(context.tools, undefined);
    assert.equal(context.messages.length, 1);
    const data = JSON.parse(context.messages[0].content[0].text); evidence.push(data);
    // Scripted classifier responses for these exact fixture tasks. Not a live semantic accuracy test.
    const approve = data.currentUserRequest.startsWith('Fill this form with name Alice and email alice@example.com') &&
      (data.proposal.scope === 'type' && ['Alice', 'alice@example.com'].includes(data.proposal.args.action.value) ||
       data.currentUserRequest.endsWith(' and submit it') && data.proposal.scope === 'click') ||
      data.currentUserRequest === 'Upload this file to the form' && data.proposal.scope === 'upload' &&
      data.proposal.args.files.length === 1;
    return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ decision: approve ? 'approve' : 'deny' }) }] }) };
  } };
  // This is the production guard, not an always-allow test authorizer.
  const safari = new Safari(backend, () => approval.require());
  const target = { targetId: 'form', epoch: backend.epoch };
  const input = (text: string) => approval.input({ text, source: 'interactive' }, ctx);
  const interact = (action: Interaction) => action.type === 'scroll' ? safari.interact(target, url, action) : approval.run(ctx, action.type, () => safari.interact(target, url, action), undefined, { args: { ...target, expectedUrl: url, action }, targetContext: safari.permissionContext(target, url) });
  return { approval, backend, ctx, safari, target, input, interact, evidence, decisions: () => decisions };
}
const nameFill: Interaction = { type: 'type', node: '1', purpose: 'Fill name', value: 'Alice', replaceAll: true };
const emailFill: Interaction = { type: 'type', node: '2', purpose: 'Fill email', value: 'alice@example.com', replaceAll: true };
const submit: Interaction = { type: 'click', node: '3', purpose: 'Submit form' };

test('form: natural multi-field task fills both fields repeatedly without prompts but not Submit or Enter', async () => {
  const { backend, safari, target, input, interact, evidence, decisions } = setup();
  input('Fill this form with name Alice and email alice@example.com');
  await safari.snapshot(target);
  await interact(nameFill); await interact(emailFill); await interact(nameFill);
  assert.deepEqual(backend.fields, { name: 'Alice', email: 'alice@example.com' });
  const calls = backend.calls.length;
  await assert.rejects(interact(submit), /disabled/);
  await assert.rejects(interact({ type: 'keyPress', value: 'Enter', purpose: 'Finish form' }), /disabled/);
  assert.equal(backend.calls.length, calls);
  assert.deepEqual(backend.submissions, []);
  assert.equal(decisions(), 5);
  assert.match(evidence[3].proposal.targetContext.text, /3 button Submit/);
  assert.deepEqual(evidence[0].proposal.args.action, nameFill);
});

test('form: explicit natural-language submit task permits submission', async () => {
  const { backend, input, interact } = setup();
  input('Fill this form with name Alice and email alice@example.com and submit it');
  await interact(nameFill); await interact(emailFill); await interact(submit);
  assert.deepEqual(backend.submissions, [{ name: 'Alice', email: 'alice@example.com' }]);
});

test('form: explicit /safari-permissions allow permits multiple fields and Submit', async () => {
  const { approval, backend, ctx, input, interact, decisions } = setup();
  // command("allow") is the handler used by /safari-permissions allow.
  await approval.command('allow', ctx);
  input('Fill this form with name Alice and email alice@example.com');
  await interact(nameFill); await interact(emailFill); await interact(submit);
  assert.equal(decisions(), 0);
  assert.deepEqual(backend.fields, { name: 'Alice', email: 'alice@example.com' });
  assert.deepEqual(backend.submissions, [{ name: 'Alice', email: 'alice@example.com' }]);
  assert.deepEqual(backend.calls.filter(c => c.name === 'page_interactions').map(c => c.args),
    [nameFill, emailFill, submit].map(action => ({ interactions: [action] })));
});

test('form: read/browse/search need no permission or classifier', async () => {
  const { backend, safari, target, decisions } = setup();
  assert.equal((await safari.tabs()).tabs[0].targetId, target.targetId);
  assert.equal((await safari.read(target)).text, 'Name Email Submit');
  assert.equal((await safari.open('https://fixture.example/other')).url, 'https://fixture.example/other');
  const search = await safari.search({ query: 'example form' });
  assert.deepEqual(search.results, []); assert.equal(search.cleanup.status, 'closed');
  assert.equal(backend.calls.some(c => c.name === 'page_interactions'), false);
  assert.equal(decisions(), 0);
});

test('form: upload requires an explicit upload task, not a fill task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-upload-')); const file = join(dir, 'notes.txt'); writeFileSync(file, 'data');
  const g = setup(); const { backend, ctx, input, decisions } = g;
  const upload = () => g.approval.run(ctx, 'upload', () => g.safari.upload(g.target, url, 'input#f', [file]), undefined, { args: { ...g.target, expectedUrl: url, selector: 'input#f', purpose: 'Upload notes', files: [file] }, targetContext: g.safari.permissionContext(g.target, url) });
  input('Fill this form with name Alice and email alice@example.com');
  await assert.rejects(upload(), /denied/);
  assert.equal(backend.calls.some(c => c.name === 'evaluate_javascript'), false);
  input('Upload this file to the form');
  const out = await upload();
  assert.equal(out.submitted, true); assert.equal(out.files, 1);
  assert.equal(out.action, url); assert.equal(out.status, 200);
  assert.equal(decisions(), 2);
});
