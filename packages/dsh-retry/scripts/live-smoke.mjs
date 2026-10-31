// Opt-in model smoke against an authenticated native DSH Web service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const origin = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
let token = process.env.DSH_WEB_TOKEN;
if (!token && origin === 'http://127.0.0.1:3080') {
  const pid = execFileSync('systemctl', ['--user', 'show', 'deepseek-harness.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
  token = execFileSync('journalctl', ['--user', `_PID=${pid}`, '--no-pager', '-o', 'json'], { encoding: 'utf8' }).match(/token=([A-Za-z0-9_-]+)/)?.[1];
}
assert.ok(token, 'set DSH_WEB_TOKEN for a remote test server');
const login = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
assert.equal(login.status, 303);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function rpc(method, args) {
  const response = await fetch(`${origin}/api/${method}`, { method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
  const envelope = await response.json();
  assert.ok(envelope.result?.ok, `${method}: ${JSON.stringify(envelope.result?.error)}`);
  return envelope.result.value;
}
const sessionId = randomUUID();
const request = { sessionId, cwd: process.env.DSH_TEST_CWD ?? process.cwd(), agentPreset: 'minimal' };
await rpc('session/create', { request });
await rpc('session/rename', { request: { sessionId, title: 'Native retry model smoke' } });
await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
  content: [{ type: 'text', text: 'Reply with exactly RETRY_OK and do not use tools.' }] } });
async function settled(count) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const projection = await rpc('session/projections', { request: { sessionId } });
    const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 40 } });
    const events = page.records.flatMap(row => row.event ? [row.event] : []);
    const assistants = events.filter(event => event.type === 'assistant/message');
    if (assistants.length >= count && events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')?.type === 'turn/end') return { events, assistants };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('model smoke timed out; inspect its named test session');
}
const first = await settled(1);
const result = await rpc('commands/execute', { agentId: sessionId, line: `/retry ${first.assistants.at(-1).data.message.id}`, images: [] });
assert.equal(result.result.kind, 'success');
const retried = await settled(2);
assert.ok(retried.events.some(event => event.type === 'developer/message' && event.data.message.source.kind === 'plugin:dsh-retry' && event.data.message.content.length === 0));
assert.ok(!retried.events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin:dsh-retry'));
console.log(JSON.stringify({ sessionId, passed: true, historyRetained: true, retryInstructionAdded: false }));
