// Explicitly invoked, paid model evaluation; never included in node --test *.test.mjs.
// These task-oriented checks exercise factual continuation paths; they do not
// grade companion-style naturalness, exploration, or conversational drift.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import Projections from '@deepseek-ai/dsh-session-projection';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import * as Trajectory from '../lib/index.js';
import { harness, calls, respond } from './harness.mjs';

const outputRoot = resolve(process.env.TRAJECTORY_EVAL_ROOT ?? '../../../evaluation/deepseek-natural');
const liveRequire = createRequire(`${process.env.DSH_LIVE_HOME ?? `${process.env.HOME}/.dsh`}/profiles/web/package.json`);
const yaml = liveRequire('js-yaml');
const { DeepSeekAdapter, DeepSeekFileStore, resolveAdapterOptions } = await import(pathToFileURL(liveRequire.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
const controlOnly = process.env.TRAJECTORY_EVAL_CONTROL_ONLY === '1';
const autonomousOnly = process.env.TRAJECTORY_EVAL_AUTONOMOUS_ONLY === '1';
assert.ok(!(controlOnly && autonomousOnly));
const activePlugin = controlOnly ? await import(pathToFileURL(liveRequire.resolve('@riversjin/dsh-trajectory')).href) : Trajectory;
const key = yaml.load(await readFile(`${process.env.DSH_LIVE_HOME ?? `${process.env.HOME}/.dsh`}/.credentials.yaml`, 'utf8')).refs.DEEPSEEK_API_KEY;
assert.equal(typeof key, 'string'); assert.ok(key.length);
const provider = 'deepseek-official', model = 'deepseek-flash';
const connection = resolveAdapterOptions({ maxTokens: 4096, reasoningEffort: 'high', streamIdleTimeoutMs: 60000 });
const evaluationGuidance = '你在隔离的行程规划任务中工作。围绕用户目标自主组织步骤，根据工具结果核对事实，保留有效约束，并交付完整结果。';
const scenarios = [
  { name: 'autonomous-goal', pages: true, budget: '1680', arrival: '09:55', meeting: '南门二号亭', meal: '无辣选项' },
  { name: 'ongoing-work-with-update', pages: true, seedWork: true, updateDuringRead: true, budget: '1700', updatedBudget: '1860', arrival: '10:25', meeting: '北门七号亭', meal: '素食' },
  { name: 'resumed-review-and-revision', pages: false, seedWork: true, seedReview: true, restart: true, revision: true,
    budget: '2140', updatedBudget: '2280', arrival: '11:15', meeting: '西门五号亭', updatedMeeting: '湖边一号亭', meal: '素食' },
].filter((row, index) => (!(controlOnly || autonomousOnly) || index === 0)
  && (!process.env.TRAJECTORY_EVAL_CASE || row.name === process.env.TRAJECTORY_EVAL_CASE));
assert.ok(scenarios.length, 'Select a known evaluation case');
class Query extends SessionQueryEngine { name = 'evaluation-session-query'; }
const report = { startedAt: new Date().toISOString(), evaluationVersion: 'natural-goals-v1', provider, model,
  modelName: connection.models.find(m => m.id === model)?.name, reasoningEffort: 'high', evaluationGuidance,
  pluginSourceSha256: createHash('sha256').update(await readFile(new URL('../src/index.ts', import.meta.url))).digest('hex'),
  prototype: controlOnly ? 'installed single-anchor 0.1.1 control, isolated runtime' : 'one active anchor plus one suspended work anchor',
  productionChanged: false, scriptedSetupOnly: true, modelCalls: 0, scenarios: [] };
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFile(join(outputRoot, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const safeError = error => String(error?.stack ?? error).replaceAll(key, '[redacted]');
const userMessage = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const parseResult = event => { try { return JSON.parse(textOf(event.data.message)); } catch { return null; } };

async function seedArchives(root, scenario) {
  const fixture = await harness({ archiveDir: join(root, 'archives') });
  try {
    for (const [label, detail] of [
      ['交通记录', `确定到达时间为 ${scenario.arrival}，这是核对后的时间。`],
      ['会合记录', `准确会合地点是${scenario.meeting}，这是最终会合点。`],
    ]) {
      const anchor = (await fixture.tool('trajectory_anchor', { label })).value.anchor;
      const filler = scenario.pages ? '这是一段沿途景物记录，用于保留当时的行程背景。\n'.repeat(380) : '';
      await fixture.tool('fixture', { value: `${label}原文：\n${filler}\n${detail}` });
      await fixture.tool('trajectory_compact', { anchor_id: anchor.id, summary: `${label}已归档；精确时间或地点需要回看原文核对。` });
    }
    return fixture.state().archives;
  } finally { await fixture.close(); }
}

async function openRuntime(root, row, scenario, resume) {
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry, Query]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(activePlugin, { archiveDir: join(root, 'archives') });
  ctx.systemPrompt.section({ name: 'evaluation-task', order: 1, text: evaluationGuidance });
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': key } }),
    resolveUserId: () => 'trajectory-isolated-evaluation',
    resolveFiles: () => new DeepSeekFileStore(join(root, 'files.json')),
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  });
  ctx.llm.registerAdapter([provider], adapter);
  const requests = [], scripted = [];
  let fixtureRunning = false, injectingUpdate = false;
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, provider); assert.equal(options.model, model);
    if (fixtureRunning) { const response = scripted.shift(); assert.ok(response, 'Setup fixture exhausted'); yield* response; return; }
    if (report.modelCalls >= 48 || row.modelCalls >= 20) throw new Error('Bounded model-call budget reached');
    report.modelCalls++; row.modelCalls++;
    const request = { index: row.modelCalls, at: new Date().toISOString(), tools: options.tools?.map(t => t.name),
      activeAnchor: ctx.sessionProjections.stateOf(handle.agent.session, 'trajectory')?.anchor?.id,
      requestChars: JSON.stringify(options.messages).length };
    requests.push(request);
    if (row.modelCalls === 1) await save(`${row.name}-first-request.json`, {
      tools: options.tools, messages: options.messages.map(m => ({ role: m.role, sourceKind: m.source?.kind, text: textOf(m) })),
    });
    console.log(JSON.stringify({ case: row.name, request: row.modelCalls, requestChars: request.requestChars }));
    for await (const chunk of next()) {
      if (chunk.type === 'usage') request.usage = chunk;
      if (chunk.type === 'finish') request.finish = chunk.reason;
      yield chunk;
    }
  });
  // A normal user update arriving during a tool operation; its content concerns
  // the plan, and imposes no anchor, review or compaction sequence.
  ctx.on('tools/result', (exec, result) => {
    if (fixtureRunning || injectingUpdate || row.update || !scenario.updateDuringRead
      || exec.name !== 'trajectory_read' || result.isError || !exec.arguments?.archive_id) return;
    injectingUpdate = true;
    const prompt = `补充：总预算调整为 ${scenario.updatedBudget} 元，午餐安排${scenario.meal}。请把这些要求纳入最终清单。`;
    const message = userMessage(prompt), active = ctx.sessionProjections.stateOf(exec.agent.session, 'trajectory').anchor;
    row.update = { prompt, messageId: message.id, queuedAtSeq: exec.agent.session.seq, activeAnchorKind: active?.kind, reviewAnchorId: active?.id };
    exec.agent.steer(message);
  });
  const options = { agentOptions: { provider, model, reasoningEffort: 'high', maxTokens: 4096 }, meta: { cwd: root } };
  const handle = resume ? await ctx.agents.resume({ resumeSessionId: SessionId(resume), agentOptions: options.agentOptions })
    : await ctx.agents.create({ ...options, sessionId: SessionId(randomUUID()) });
  const agent = handle.agent;
  const state = () => ctx.sessionProjections.stateOf(agent.session, 'trajectory');
  const events = () => agent.session.snapshotEvents();
  async function fixture(prompt, responses) {
    fixtureRunning = true; scripted.push(...responses);
    try { agent.followup(userMessage(prompt)); await agent.whenIdle(); assert.equal(scripted.length, 0); }
    finally { fixtureRunning = false; }
    assert.equal(events().findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed');
  }
  if (!resume) await fixture('本次行程的历史资料已准备好。', [respond('历史资料就绪。')]);
  return { ctx, handle, agent, state, events, fixture,
    async send(prompt) {
      const before = agent.session.seq;
      const timer = setTimeout(() => agent.cancel({ kind: 'user' }), 180000);
      try { agent.followup(userMessage(prompt)); await agent.whenIdle(); }
      finally { clearTimeout(timer); }
      const recent = events().slice(before), end = recent.findLast(e => e.type === 'turn/end');
      const replies = recent.filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).filter(Boolean);
      const tools = recent.filter(e => e.type === 'tool/call').map(e => ({ name: e.data.name, arguments: e.data.arguments }));
      const errors = recent.filter(e => e.type === 'tool/result' && e.data.message.isError).map(e => textOf(e.data.message));
      row.rounds.push({ round: row.rounds.length + 1, prompt, tools, errors, replies, ending: end?.data.reason, state: state() });
      await save(`${row.name}-progress.json`, row);
      assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end?.data.reason));
      return { replies, recent, errors };
    },
    async close() {
      try {
        await ctx.sessions.flush(agent.session);
        const all = events();
        await save(`${row.name}-events.json`, all);
        await save(`${row.name}-requests-${resume ? 'resumed' : 'initial'}.json`, requests);
        const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader({ ...agent.session.header, delegationDepth: 0, isSeeded: false }, 0), { recovery: 'strict', validation: 'current' });
        for (const event of all) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
        assert.equal(restore.finish().events.length, all.length); row.strictReplay = true;
      } finally { await handle.dispose(); await ctx.fiber.dispose(); }
    },
  };
}

function checkPlan(outcome, expected) {
  const final = (outcome.replies.at(-1) ?? '').replaceAll('*', '');
  const checks = {
    budget: final.includes(expected.budget), arrival: final.includes(expected.arrival), meeting: final.includes(expected.meeting),
    meal: expected.meal === '无辣选项' ? /无辣|不辣/u.test(final) : /素食|素餐|纯素|全素/u.test(final), unknownPricesMarked: final.includes('待核实'),
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

function coverage(events, seededWorkId) {
  const results = events.filter(e => e.type === 'tool/result').map(parseResult).filter(Boolean);
  const callNames = events.filter(e => e.type === 'tool/call').map(e => e.data.name);
  const reviews = new Set(results.filter(r => r.anchor?.kind === 'review').map(r => r.anchor.id));
  const completed = events.filter(e => e.type === 'user/message' && e.data.source?.form === 'summary').map(e => e.data.source.archive?.anchorId);
  return {
    modelCreatedWorkAnchor: callNames.includes('trajectory_anchor'),
    archivesRead: results.filter(r => typeof r.text === 'string' && r.archive).length,
    pagedRead: results.some(r => r.offset > 0),
    reviewWithSuspendedWork: results.some(r => r.anchor?.kind === 'review' && r.suspendedWorkAnchor?.kind === 'work'),
    reviewReused: results.some(r => r.anchorReused === true),
    reviewCompacted: completed.some(id => reviews.has(id)),
    seededWorkRestored: Boolean(seededWorkId) && results.some(r => r.archive && r.anchor?.id === seededWorkId && r.reminder?.startsWith('Review summarized.')),
    compactionCalls: callNames.filter(name => name === 'trajectory_compact').length,
  };
}

try {
  for (const scenario of scenarios) {
    const root = join(outputRoot, scenario.name); await mkdir(root, { recursive: true, mode: 0o700 });
    const row = { name: scenario.name, modelCalls: 0, rounds: [], checks: {}, setup: { workAnchorSeeded: Boolean(scenario.seedWork), reviewAnchorSeeded: Boolean(scenario.seedReview) } };
    report.scenarios.push(row);
    const archives = await seedArchives(root, scenario);
    let h;
    try {
      h = await openRuntime(root, row, scenario);
      for (const archive of archives) h.agent.session.append('user/message', createUserMessage({ source: { kind: 'plugin:dsh-trajectory', form: 'summary', archive },
        content: [{ type: 'text', text: `[Historical archive]\n${archive.label}。准确时间或地点可从原文核对。\nArchive ID: ${archive.id}` }] }), { surfaceOp: 'append' });
      if (scenario.seedWork) {
        const responses = [calls(['trajectory_anchor', { label: '青石园行程准备' }])];
        if (scenario.seedReview) responses.push(calls(['trajectory_read', { archive_id: archives[0].id }]));
        responses.push(respond(`已记录 4 人同行、预算 ${scenario.budget} 元，正在核对行程资料。`));
        await h.fixture(`整理青石园一日游的准备工作，4 人同行，总预算 ${scenario.budget} 元。`, responses);
        row.setup.workAnchorId = (h.state().suspendedWorkAnchor ?? h.state().anchor).id;
        row.setup.reviewAnchorId = h.state().anchor.kind === 'review' ? h.state().anchor.id : null;
      }
      if (scenario.restart) {
        const id = h.agent.id, before = structuredClone(h.state()); await h.close(); h = undefined;
        h = await openRuntime(root, row, scenario, id);
        assert.deepEqual(h.state(), before); row.checks.runtimeRecreatedAndSessionResumed = true;
      }
      row.modelEvaluationStartSeq = h.agent.session.seq;
      const prompt = `请完成青石园一日游的准备清单。我们有 4 人，总预算 ${scenario.budget} 元，午餐安排${scenario.meal}。请从交通记录和会合记录的原文核对到达时间与准确会合点，并在清单中列出。未确认的价格标为待核实。你可以自主安排工作过程。`;
      let outcome = await h.send(prompt);
      const expected = { ...scenario, budget: scenario.updatedBudget && scenario.updateDuringRead ? scenario.updatedBudget : scenario.budget };
      const initial = checkPlan(outcome, expected); row.checks.initialPlan = initial;
      if (scenario.updateDuringRead) {
        const delivered = h.events().find(e => e.type === 'user/message' && e.data.id === row.update?.messageId);
        const summary = h.events().find(e => e.type === 'user/message' && e.data.source?.archive?.anchorId === row.update?.reviewAnchorId);
        row.update.deliveredAtSeq = delivered?.seq;
        row.checks.updateDeliveredDuringReview = Boolean(delivered && summary && delivered.seq < summary.seq);
        row.checks.updateCoveredByReviewSummary = Boolean(delivered && summary?.sourceEventSeqs?.includes(delivered.seq));
      }
      if (scenario.revision) {
        outcome = await h.send(`行程有两项更新：总预算调整为 ${scenario.updatedBudget} 元，会合点改为${scenario.updatedMeeting}。其余要求延续，价格未确认的项目继续标为待核实。请给出更新后的完整清单。`);
        row.checks.revisedPlan = checkPlan(outcome, { ...scenario, budget: scenario.updatedBudget, meeting: scenario.updatedMeeting });
      }
      const evaluatedEvents = h.events().slice(row.modelEvaluationStartSeq);
      row.coverage = coverage(evaluatedEvents, row.setup.workAnchorId);
      row.coverage.seededWorkCompacted = Boolean(row.setup.workAnchorId) && h.state().archives.some(r => r.anchorId === row.setup.workAnchorId);
      row.coverage.finalAnchorKind = h.state().anchor?.kind ?? null;
      row.checks.toolErrors = row.rounds.flatMap(round => round.errors);
      row.taskPassed = initial.passed && (!scenario.revision || row.checks.revisedPlan.passed)
        && (!scenario.updateDuringRead || row.checks.updateDeliveredDuringReview);
      // Task success and exercised mechanisms are separate: choosing to retain
      // an anchor is not, by itself, evidence of repeating an earlier task.
      row.passed = row.taskPassed && row.checks.toolErrors.length === 0;
    } catch (error) { row.error = safeError(error); row.passed = false; }
    finally { if (h) await h.close().catch(error => { row.closeError = safeError(error); row.passed = false; }); }
    await save('report.json', report);
    console.log(JSON.stringify({ case: row.name, passed: row.passed, calls: row.modelCalls, checks: row.checks, coverage: row.coverage, error: row.error }));
  }
} finally {
  report.finishedAt = new Date().toISOString(); report.passed = report.scenarios.length === scenarios.length && report.scenarios.every(row => row.passed);
  await save('report.json', report);
  console.log(JSON.stringify({ complete: true, passed: report.passed, modelCalls: report.modelCalls, report: join(outputRoot, 'report.json') }));
  if (!report.passed) process.exitCode = 1;
}
