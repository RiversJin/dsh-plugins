import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAssistantMessage, createSystemMessage, createUserMessage, createToolResultMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { harness, text } from './harness.mjs';
import { SMALL, LARGE, PROVIDER } from '../lib/index.js';

function sse(model, inputTokens = 70) {
  return [
    { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('real pi-ai HTTP payload preserves system, tools, signed thinking and tool pairing across both K3 tiers', async () => {
  const requests = [], degraded = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse(body.model));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const auth = { credentials: new InMemoryCredentialStore(), authContext: { getEnv: () => undefined, fileExists: async () => false } };
  const native = kimiCodingProvider();
  const piProvider = { ...native, getModels: () => native.getModels().map(model => ({ ...model,
    baseUrl: `http://127.0.0.1:${server.address().port}`, compat: { ...model.compat, allowEmptySignature: true },
  })) };
  const profiles = new Map([[PROVIDER, { provider: PROVIDER, displayName: 'Fixture Kimi', piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: 5000, maxRequestImageBytes: 20971520, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
  }]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-test-key', auth, onReplayDegrade: d => degraded.push(d) });
  const h = await harness({ adapter });
  try {
    for (const signature of ['fixture-original-signature', '']) for (const from of [SMALL, LARGE]) {
      const assistant = createAssistantMessage({ content: [{ type: 'reasoning', text: 'Original reasoning.' }, { type: 'tool-call', id: 'call_fixture', name: 'fixture_tool', arguments: '{"value":1}' }],
        source: { provider: PROVIDER, model: from, replayState: {
          response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: PROVIDER, model: from, responseModel: from, stopReason: 'toolUse' },
          blocks: [{ type: 'reasoning', thinkingSignature: signature }, { type: 'tool-call' }],
        } } });
      const messages = [createSystemMessage('Stable system Model=k3.'), createUserMessage({ content: text('Call fixture.'), source: { kind: 'user' } }), assistant,
        createToolResultMessage({ callId: 'call_fixture', content: text('Original tool result.'), isError: false }), createUserMessage({ content: text('Continue.'), source: { kind: 'user' } })];
      const original = JSON.stringify(messages);
      for (const model of [from, from === SMALL ? LARGE : SMALL]) {
        const controller = new AbortController();
        const options = { provider: PROVIDER, model, reasoningEffort: 'high', maxTokens: 128, messages, signal: controller.signal,
          tools: [{ name: 'fixture_tool', description: 'Fixture.', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }] };
        markAgentLoopRequest(options);
        const prepared = await h.ctx.llm.prepareCall(options);
        const chunks = []; for await (const chunk of prepared.stream(options)) chunks.push(chunk);
        assert.equal(chunks.at(-1).type, 'finish'); assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' });
        assert.equal(Object.isFrozen(controller.signal), false, 'request transport must not freeze cancellation state');
        controller.abort('completed fixture');
        assert.equal(controller.signal.aborted, true);
      }
      const [before, after] = requests.slice(-2);
      assert.notEqual(before.model, after.model);
      assert.deepEqual({ ...before, model: 'k3' }, { ...after, model: 'k3' });
      const thinking = after.messages.flatMap(m => m.content).find(b => b.type === 'thinking');
      assert.equal(thinking.thinking, 'Original reasoning.'); assert.equal(thinking.signature, signature);
      assert.equal(JSON.stringify(messages), original);
    }
    assert.equal(requests.length, 8, 'one wire request for each prepared call');
    assert.deepEqual(degraded, []);
  } finally { await h.close(); server.close(); await once(server, 'close'); }
});

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}

test('native agent cancellation reaches an in-flight pi-ai request after a tier change, and the next turn succeeds', async () => {
  const requests = [];
  let entered, disconnected;
  const waiting = new Promise(resolve => { entered = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 2) {
      response.on('close', disconnected);
      response.flushHeaders(); entered();
      return; // Keep the transport live until the real agent cancellation arrives.
    }
    response.end(sse(body.model, 255000));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const auth = { credentials: new InMemoryCredentialStore(), authContext: { getEnv: () => undefined, fileExists: async () => false } };
  const native = kimiCodingProvider();
  const piProvider = { ...native, getModels: () => native.getModels().map(model => ({ ...model,
    baseUrl: `http://127.0.0.1:${server.address().port}`, compat: { ...model.compat, allowEmptySignature: true },
  })) };
  const profiles = new Map([[PROVIDER, { provider: PROVIDER, displayName: 'Fixture Kimi', piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: 5000, maxRequestImageBytes: 20971520, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
  }]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-test-key', auth });
  const h = await harness({ adapter, options: { reasoningEffort: 'high', maxTokens: 128 } });
  const followup = () => h.agent.followup(createUserMessage({ content: text('Continue fixture.'), source: { kind: 'user' } }));
  try {
    followup(); await bounded(h.agent.whenIdle());
    assert.equal(h.events().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed', JSON.stringify(h.events().findLast(e => e.type === 'turn/end').data.reason));
    const original = h.events().find(e => e.type === 'assistant/message').data.message;
    assert.equal(original.source.model, SMALL);
    assert.equal(original.source.replayState.response.version, 2);
    const originalText = JSON.stringify(original);
    followup(); await bounded(waiting);
    assert.deepEqual(requests.map(r => r.model), [SMALL, LARGE]);
    h.agent.cancel({ kind: 'user' });
    await bounded(h.agent.whenIdle()); await bounded(closed);
    assert.deepEqual(h.events().findLast(e => e.type === 'turn/end').data.reason, { kind: 'aborted', reason: { kind: 'user' } });
    followup(); await bounded(h.agent.whenIdle());
    assert.equal(requests.length, 3, 'one new request after cancellation');
    assert.equal(h.events().findLast(e => e.type === 'turn/end').data.reason.kind, 'completed', JSON.stringify(h.events().findLast(e => e.type === 'turn/end').data.reason));
    assert.equal(JSON.stringify(original), originalText);
    assert.ok(!JSON.stringify(h.events()).includes('kDependantSignals'));
  } finally { await h.close(); server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
