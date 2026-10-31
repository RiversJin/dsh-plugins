import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessage, createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { chooseTier, resolveConfig, compatibleK3History, isSmallContextOverflow,
  SMALL, LARGE, PROVIDER, SMALL_WINDOW } from '../lib/index.js';
import { harness, response, failure, text } from './harness.mjs';

const config = resolveConfig();
const state = (model, overflowPromptTokens = null) => ({ model, promptTokens: 0, reason: 'initial', overflowPromptTokens });
const route = (promptTokens, previous = null, maxTokens) => chooseTier({ promptTokens, previous, ...(maxTokens === undefined ? {} : { maxTokens }) }, config);
function strictReplay(h) {
  const artifact = JSON.parse(JSON.stringify({ header: { ...h.agent.session.header, delegationDepth: 0 }, events: h.events() }));
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(artifact.header, 0), { recovery: 'strict', validation: 'current' });
  for (const event of artifact.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
  assert.equal(restore.finish().events.length, artifact.events.length);
}

test('8K total headroom, asymmetric promotion/demotion and explicit output reservations', () => {
  assert.equal(config.reserveTokens + config.safetyTokens, 8192);
  assert.equal(route(SMALL_WINDOW - 8193), SMALL);
  assert.equal(route(SMALL_WINDOW - 8192), LARGE);
  assert.equal(route(210000, state(LARGE)), LARGE);
  assert.equal(route(196608, state(LARGE)), SMALL);
  assert.equal(route(210000, state(SMALL)), SMALL);
  assert.equal(route(200000, null, 100000), LARGE);
  assert.equal(route(0), SMALL);
  assert.equal(route(NaN), LARGE);
  assert.equal(chooseTier({ promptTokens: 20, previous: null, hasVideo: true }, config), LARGE);
  assert.throws(() => resolveConfig({ downgradePromptTokens: 254000 }), /threshold/);
});

test('a confirmed overflow raises the effective safety boundary until the prompt shrinks', () => {
  const previous = state(LARGE, 170000);
  assert.equal(route(169000, previous), LARGE);
  assert.equal(route(100000, previous), SMALL);
  assert.equal(isSmallContextOverflow({ code: 'AUTH', message: 'k3-256k supports only 256K context.' }), true);
  for (const code of ['TIMEOUT', 'RATE_LIMIT', 'AUTH', 'TRANSPORT']) assert.equal(isSmallContextOverflow({ code, message: 'unavailable' }), false);
});

test('new and existing selected K3 tiers route small with a stable interpolated system prompt', async () => {
  for (const model of [SMALL, LARGE]) {
    const h = await harness({ options: { model, reasoningEffort: 'high' } });
    try {
      const request = await h.send();
      assert.equal(request.model, SMALL);
      assert.equal(request.reasoningEffort, 'high');
      assert.match(request.messages.find(m => m.role === 'system').content[0].text, /Model=k3\./);
      assert.equal(h.agent.session.requestHeader().config.model, SMALL);
      assert.equal(h.state().model, SMALL);
      assert.ok(!request.messages.some(m => m.source.kind === 'plugin:dsh-kimi-auto'));
      assert.ok(!JSON.stringify(request.messages.map(({ role, content }) => ({ role, content }))).includes('Model switched'));
      assert.equal(h.events().filter(e => e.type === 'developer/message' && e.data.message.source.kind === 'plugin:dsh-kimi-auto').length, 1);
      strictReplay(h);
    } finally { await h.close(); }
  }
});

test('large newly admitted input promotes before sending; a native replacement allows demotion', async () => {
  let removeSeq;
  const h = await harness({ setup: async ctx => {
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      if (removeSeq !== undefined) {
        agent.session.append('user/message', createUserMessage({ content: text('Fixture compact summary.'), source: { kind: 'plugin:fixture' } }), { surfaceOp: { op: 'replace', startSeq: removeSeq, endSeq: removeSeq }, sourceEventSeqs: [removeSeq] });
        removeSeq = undefined;
      }
      return next();
    });
  } });
  try {
    const first = await h.send();
    assert.equal(first.model, SMALL);
    const large = await h.send([response()], 'A'.repeat(900000));
    assert.equal(large.model, LARGE);
    assert.equal(large.messages.filter(m => m.role === 'user' && m.source.kind === 'user').length, 2);
    assert.equal(JSON.stringify(large.messages.find(m => m.role === 'system').content), JSON.stringify(first.messages.find(m => m.role === 'system').content));
    removeSeq = h.events().findLast(e => e.type === 'user/message' && e.data.content.some(b => b.type === 'text' && b.text.length === 900000)).seq;
    const small = await h.send();
    assert.equal(small.model, SMALL);
    assert.ok(small.messages.some(m => JSON.stringify(m.content).includes('Fixture compact summary.')));
    assert.ok(!small.messages.some(m => m.content.some(b => b.type === 'text' && b.text.length === 900000)));
    strictReplay(h);
  } finally { await h.close(); }
});

test('context overflow retries on large tier once with identical messages and no duplicated user input', async () => {
  const h = await harness();
  try {
    await h.send([failure('CONTEXT_WINDOW_EXCEEDED'), response()]);
    assert.deepEqual(h.adapter.requests.map(r => r.model), [SMALL, LARGE]);
    assert.deepEqual(h.adapter.requests[0].messages, h.adapter.requests[1].messages);
    assert.equal(h.events().filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 1);
    assert.equal(h.state().reason, 'overflow');
    assert.ok(!h.events().some(e => e.type === 'compaction/end'));
    strictReplay(h);
  } finally { await h.close(); }
});

test('401 with Kimi exact capacity wording promotes; other failures and large-tier overflow remain failures', async () => {
  const recovered = await harness();
  try {
    await recovered.send([failure('AUTH', 'k3-256k supports only 256K context.'), response()]);
    assert.deepEqual(recovered.adapter.requests.map(r => r.model), [SMALL, LARGE]);
  } finally { await recovered.close(); }
  for (const code of ['AUTH', 'TIMEOUT', 'RATE_LIMIT']) {
    const h = await harness();
    try { await h.send([failure(code)], 'fixture', 'error'); assert.equal(h.adapter.requests.length, 1); }
    finally { await h.close(); }
  }
  const h = await harness();
  try {
    await h.send([failure('CONTEXT_WINDOW_EXCEEDED'), failure('CONTEXT_WINDOW_EXCEEDED')], 'fixture', 'error');
    assert.equal(h.adapter.requests.length, 2);
  } finally { await h.close(); }
});

test('other providers and disabled routing retain their selections and prompt variables', async () => {
  for (const options of [{ provider: 'fixture-other', model: LARGE }, { provider: PROVIDER, model: 'kimi-for-coding' }]) {
    const h = await harness({ options });
    try { const r = await h.send(); assert.equal(r.model, options.model); assert.equal(r.provider, options.provider); assert.equal(h.state(), null); }
    finally { await h.close(); }
  }
  const h = await harness({ config: { enabled: false }, options: { model: SMALL } });
  try { const r = await h.send(); assert.match(r.messages.find(m => m.role === 'system').content[0].text, /k3-256k/); assert.equal(h.state(), null); }
  finally { await h.close(); }
});

test('pressure policy sees 1M family capacity while the request records its real 256K tier', async () => {
  const h = await harness();
  try {
    await h.send();
    const target = { provider: PROVIDER, model: SMALL };
    const effective = await h.ctx.waterfall('compaction/pressure-target', { agent: h.agent, target }, () => Promise.resolve(target));
    assert.deepEqual(effective, { provider: PROVIDER, model: LARGE });
    assert.equal(h.agent.session.requestContext().contextWindow, SMALL_WINDOW);
    assert.equal(h.agent.session.requestHeader().config.model, SMALL);
  } finally { await h.close(); }
});

test('cold resume preserves routing hysteresis and does not duplicate route metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-kimi-auto-'));
  let h = await harness({ root });
  try {
    await h.send(); const id = h.agent.id;
    const initial = h.events().filter(e => e.type === 'developer/message' && e.data.message.source.kind === 'plugin:dsh-kimi-auto').length;
    await h.close(); h = await harness({ root, resume: id });
    await h.send();
    assert.equal(h.state().model, SMALL);
    assert.equal(h.events().filter(e => e.type === 'developer/message' && e.data.message.source.kind === 'plugin:dsh-kimi-auto').length, initial);
    strictReplay(h);
  } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
});

function signedAssistant(model, responseModel = model) {
  return createAssistantMessage({ content: [{ type: 'reasoning', text: 'fixture reasoning' }, ...text('fixture answer')],
    source: { provider: PROVIDER, model, replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: PROVIDER, model, responseModel, stopReason: 'stop' },
      blocks: [{ type: 'reasoning', thinkingSignature: 'fixture-signature' }, { type: 'text' }],
    } } });
}
test('transport compatibility preserves signed content and immutable source history in both directions', () => {
  for (const [from, to] of [[SMALL, LARGE], [LARGE, SMALL]]) {
    const original = signedAssistant(from), before = JSON.stringify(original);
    const mapped = compatibleK3History([original], to)[0];
    assert.equal(mapped.source.model, to);
    assert.equal(mapped.source.replayState.response.model, to);
    assert.equal(mapped.source.replayState.response.responseModel, to);
    assert.deepEqual(mapped.content, original.content);
    assert.equal(mapped.source.replayState.blocks[0].thinkingSignature, 'fixture-signature');
    assert.equal(JSON.stringify(original), before);
    assert.ok(Object.isFrozen(mapped));
  }
  const other = signedAssistant(SMALL, 'different-underlying-model');
  assert.equal(compatibleK3History([other], LARGE)[0], other);
});

test('native web/QQ model selection emits no K3 tier notice but retains real provider switches', async () => {
  const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
  const h = await harness();
  const selection = { current: { provider: PROVIDER, model: LARGE, reasoningEffort: 'high' }, assembled: undefined };
  installModelSelection(h.agent.ctx, selection);
  try {
    await h.send();
    const second = await h.send();
    assert.equal(second.model, SMALL);
    assert.ok(!second.messages.some(m => m.source.kind === 'model-selection'));
    assert.match(second.messages.find(m => m.role === 'system').content[0].text, /Model=k3\./);
    selection.current = { provider: 'fixture-other', model: 'other' };
    const other = await h.send();
    assert.equal(other.provider, 'fixture-other');
    assert.equal(other.messages.filter(m => m.source.kind === 'model-selection').length, 1);
    strictReplay(h);
  } finally { await h.close(); }
});

test('fork retains large-tier hysteresis from source routing events', async () => {
  const { buildForkSeed } = await import('@deepseek-ai/dsh-session/fork');
  const h = await harness(); let child;
  try {
    await h.send([response('OK', 280000)]);
    await h.send([response('OK', 210000)]);
    assert.equal(h.state().model, LARGE);
    const seed = buildForkSeed(h.events(), h.events().at(-1).seq);
    child = await harness({ seed });
    assert.equal(child.state().model, LARGE);
    const request = await child.send([response('OK', 210000)]);
    assert.equal(request.model, LARGE);
    assert.ok(!request.messages.some(m => m.source.kind === 'plugin:dsh-kimi-auto'));
  } finally { await child?.close(); await h.close(); }
});

test('successful output before a capacity failure is never replayed by automatic routing', async () => {
  const h = await harness();
  try {
    await h.send([[{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, delta: 'visible' },
      ...failure('CONTEXT_WINDOW_EXCEEDED')]], 'fixture', 'error');
    assert.equal(h.adapter.requests.length, 1);
  } finally { await h.close(); }
});

test('new large tool output promotes before the next model step and retains one tool result', async () => {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  let executed = 0;
  const h = await harness({ setup: async ctx => {
    ctx.tools.register(defineTool({ name: 'fixture_large_result', description: 'fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      async execute() { executed++; return 'T'.repeat(850000); } }));
  } });
  try {
    const call = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'large_result_call', name: 'fixture_large_result', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 30, totalTokens: 1030 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ];
    await h.send([call, response()]);
    assert.deepEqual(h.adapter.requests.map(r => r.model), [SMALL, LARGE]);
    assert.equal(executed, 1);
    assert.equal(h.adapter.requests[1].messages.filter(m => m.role === 'tool' && m.toolCallId === 'large_result_call').length, 1);
    strictReplay(h);
  } finally { await h.close(); }
});

test('a model-selection hook installed after the first step (the web controller installs it lazily on the first UI pick) still emits no K3 tier notice', async () => {
  const { installModelSelection } = await import('@deepseek-ai/dsh-agent');
  const h = await harness();
  try {
    await h.send();
    // 2026-10-21 23:59: the UI picked k3 + max while routing kept k3-256k; the
    // notice hook arrived after this plugin's wrapper and ran outside it.
    const selection = { current: { provider: PROVIDER, model: LARGE, reasoningEffort: 'high' }, assembled: undefined };
    installModelSelection(h.agent.ctx, selection);
    for (let i = 0; i < 3; i++) {
      const request = await h.send();
      assert.equal(request.model, SMALL);
      assert.equal(request.reasoningEffort, 'high');
      assert.ok(!request.messages.some(m => m.source.kind === 'model-selection'), `notice leaked on request ${i + 1}`);
    }
    assert.ok(!h.agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'model-selection'));
    selection.current = { provider: 'fixture-other', model: 'other' };
    const other = await h.send();
    assert.equal(other.provider, 'fixture-other');
    assert.equal(other.messages.filter(m => m.source.kind === 'model-selection').length, 1);
    strictReplay(h);
  } finally { await h.close(); }
});
