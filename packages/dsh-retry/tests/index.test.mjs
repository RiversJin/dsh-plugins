import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import {
  commitRetrySurface,
  createRetryTrigger,
  parseRetryInput,
  planRetry,
} from '../lib/index.js';

function text(message) {
  return message.content.find(block => block.type === 'text')?.text;
}

function appendTurn(session, turn, prompt, answer, { tool = false } = {}) {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' });
  if (tool) {
    session.append('tool/call', {
      turn,
      step: 1,
      callId: `call-${turn}`,
      name: 'read',
      arguments: '{}',
    });
  }
  const assistantMessage = createAssistantMessage({
    content: [{ type: 'text', text: answer }],
    source: { provider: 'test', model: 'test' },
  });
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: assistantMessage,
  }, { surfaceOp: 'append', sourceEventSeqs: [] });
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  return { user, assistant, assistantMessage };
}

test('plans the latest request and detects tool risk', () => {
  const session = Session.create('retry-plan');
  appendTurn(session, 1, 'first', 'one');
  const latest = appendTurn(session, 2, 'second', 'two', { tool: true });
  const plan = planRetry(session.events, session.surface.nodes, latest.assistantMessage.id);
  assert.equal(plan.ok, true);
  assert.equal(plan.userMessage.id, latest.user.data.id);
  assert.equal(plan.latestAssistantMessageId, latest.assistantMessage.id);
  assert.equal(plan.toolCallCount, 1);
  assert.deepEqual(plan.sourceEventSeqs, [latest.user.seq, latest.assistant.seq]);
});

test('rejects a stale assistant target', () => {
  const session = Session.create('retry-stale');
  const stale = appendTurn(session, 1, 'first', 'one');
  appendTurn(session, 2, 'second', 'two');
  assert.deepEqual(
    planRetry(session.events, session.surface.nodes, stale.assistantMessage.id),
    { ok: false, code: 'target-not-latest' },
  );
});

test('surface replacement keeps one active human request across repeated retries', () => {
  const session = Session.create('retry-repeat');
  const initial = appendTurn(session, 1, 'question', 'old answer');
  const firstPlan = planRetry(session.events, session.surface.nodes, initial.assistantMessage.id);
  assert.equal(firstPlan.ok, true);
  commitRetrySurface(session, firstPlan);

  session.append('turn/start', { turn: 2 });
  session.append('step/start', { turn: 2, step: 1 });
  session.append('user/message', createRetryTrigger(), { surfaceOp: 'append' });
  const retryAnswer = createAssistantMessage({
    content: [{ type: 'text', text: 'new answer' }],
    source: { provider: 'test', model: 'test' },
  });
  session.append('assistant/message', {
    turn: 2,
    step: 1,
    message: retryAnswer,
  }, { surfaceOp: 'append', sourceEventSeqs: [] });
  session.append('step/end', { turn: 2, step: 1 });
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });

  const beforeSecond = session.deriveMessages();
  assert.equal(beforeSecond.filter(message => text(message) === 'question').length, 1);
  assert.equal(beforeSecond.some(message => text(message) === 'old answer'), false);
  assert.equal(beforeSecond.some(message => text(message) === 'new answer'), true);

  const secondPlan = planRetry(session.events, session.surface.nodes, retryAnswer.id);
  assert.equal(secondPlan.ok, true);
  commitRetrySurface(session, secondPlan);
  const afterSecond = session.deriveMessages();
  assert.deepEqual(afterSecond.map(text), ['question']);
  assert.equal(session.events.some(event => event.data?.message?.id === initial.assistantMessage.id), true);
});

test('parses force independently of the optional UI target', () => {
  assert.deepEqual(parseRetryInput(''), { force: false });
  assert.deepEqual(parseRetryInput('force'), { force: true });
  assert.deepEqual(parseRetryInput('message-1 --force'), {
    targetMessageId: 'message-1',
    force: true,
  });
  assert.equal(parseRetryInput('message-1 message-2'), undefined);
});
