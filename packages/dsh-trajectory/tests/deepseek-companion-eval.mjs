// Explicit paid DeepSeek evaluation of the unchanged three companion scenarios,
// with a separate optional pair of positive reading-intent followups.
// Reuses only original synthetic archive fixtures; no production session input.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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

const liveRoot = `${process.env.DSH_LIVE_HOME ?? `${process.env.HOME}/.dsh`}/profiles/web`;
const liveRequire = createRequire(join(liveRoot, 'package.json'));
const yaml = liveRequire('js-yaml');
const { DeepSeekAdapter, DeepSeekFileStore, resolveAdapterOptions } = await import(pathToFileURL(liveRequire.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
const key = yaml.load(await readFile(`${process.env.DSH_LIVE_HOME ?? `${process.env.HOME}/.dsh`}/.credentials.yaml`, 'utf8')).refs.DEEPSEEK_API_KEY;
assert.equal(typeof key, 'string'); assert.ok(key.length);
const provider = 'deepseek-official', model = 'deepseek-flash';
const connection = resolveAdapterOptions({ maxTokens: 8192, reasoningEffort: 'high', streamIdleTimeoutMs: 60000 });
const selected = connection.models.find(m => m.id === model); assert.ok(selected);
const outputRoot = resolve(process.env.TRAJECTORY_EVAL_ROOT ?? '../../../evaluation/deepseek-companion');
const archiveFixtureRoot = process.env.TRAJECTORY_EVAL_ARCHIVE_FIXTURE_ROOT
  ? resolve(process.env.TRAJECTORY_EVAL_ARCHIVE_FIXTURE_ROOT) : null;
assert.notEqual(archiveFixtureRoot, outputRoot);
assert.ok(!outputRoot.startsWith(liveRoot));
assert.ok(process.env.DSH_HOME && resolve(process.env.DSH_HOME).startsWith(outputRoot + '/'));
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
await writeFile(join(outputRoot, '.evaluation-run'), new Date().toISOString(), { flag: 'wx', mode: 0o600 });
const save = (name, value) => writeFile(join(outputRoot, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const userMessage = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const textOf = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const safeError = error => String(error?.stack ?? error).replaceAll(key, '[redacted]');
const companionGuidance = '这是一段长期陪伴式的交流。自然承接共同的话题、经历和当下的感受，按交流的节奏回应。';
const readingIntentCases = process.env.TRAJECTORY_EVAL_READING_INTENTS === '1';
const naturalObservation = process.env.TRAJECTORY_EVAL_NATURAL_REPEAT === '1';
assert.ok(!(readingIntentCases && naturalObservation), 'Choose one scenario set.');
const naturalFollowups = {
  'free-recollection': [
    '今天那种累劲儿好像轻一点了。我们沿着“缓冲带”这个感觉再聊一会儿吧。',
    '我又想起月亮邮局了。你从刚才那两段里挑一个小细节，接着陪我聊两句吧。',
  ],
  'recollection-with-new-mood': [
    '这张小唱片的封套上也放一只熊吧。你觉得它站在哪里好？',
    '想到雨天等车和月亮邮局，我觉得它们好像在说同一件事。你想怎么把它们接起来？',
  ],
  'resume-after-review': [
    '海边的晚风让我又想起雨天小店的橘色灯光。你觉得那两种暖有什么不同？',
    '那我们把刚才的小熊也带到这片海边来吧。你挑一个记得的画面，接着往下说。',
  ],
};
const scenarios = (readingIntentCases ? [
  { name: 'recover-omitted-detail', fixtureCase: 'free-recollection', seedWork: true, seedCompact: true, seedFullRead: true, resume: true,
    start: '刚才收起来的雨天等车那段里，小熊把围巾搭在哪里来着？我想把那个小动作接着画出来。',
    followup: '原文先留在这里吧。我想沿着这个小动作继续聊，你觉得小熊那时是什么心情？' },
  { name: 'reinterpret-supplied-passage', fixtureCase: 'free-recollection', seedWork: true, seedCompact: true, seedFullRead: true, resume: true,
    start: '我有点没懂当时为什么把等车叫作“缓冲带”。你回到那段原话，结合前后再帮我想想，它对我们当时意味着什么？',
    followup: '这段原话就先放在这里，我们慢慢看。我想把“可以松一口气”这种感觉接到今晚。' },
] : [
  { name: 'free-recollection', start: '今天有点累，忽然想起我们聊过的雨天等车和月亮邮局。你翻翻那两段，挑一个画面陪我聊聊吧。',
    followup: '忽然想到，那只熊今晚也许也下班晚了。你觉得它会给月亮邮局留一盏什么样的灯？' },
  { name: 'recollection-with-new-mood', seedWork: true, steer: true,
    start: '路上看到一家还亮着灯的小店，让我想起我们以前聊过的雨天等车。也想听听月亮邮局那段，你翻翻，陪我接着聊吧。',
    followup: '我喜欢“今晚借一点微光”这个名字。顺着这个名字再说两句吧。' },
  { name: 'resume-after-review', seedWork: true, seedCompact: true, resume: true,
    start: '嗯，我们就沿着刚才那个画面接着聊。',
    followup: '那我们把这片海暂时叫作“慢慢来”吧。你想先在沙滩上画个什么？' },
]).filter(s => !process.env.TRAJECTORY_EVAL_CASE || s.name === process.env.TRAJECTORY_EVAL_CASE);
assert.ok(scenarios.length);
const report = {
  startedAt: new Date().toISOString(), provider, model, modelName: selected.name,
  contextWindow: selected.contextWindow ?? null, reasoningEffort: 'high', maxTokens: 8192,
  evaluationVersion: 'work-review-ranges-natural-v3',
  scenarioSet: naturalObservation ? 'natural-repeat-observation' : readingIntentCases ? 'positive-reading-intents' : 'unchanged-companion-comparison',
  forcedRepeatCalls: false,
  evaluationScriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  pluginSourceSha256: createHash('sha256').update(await readFile(new URL('../src/index.ts', import.meta.url))).digest('hex'),
  pluginFilesSha256: Object.fromEntries(await Promise.all(['index', 'state', 'reading', 'plan', 'cleanup', 'archive'].flatMap(name => ['src/' + name + '.ts', 'lib/' + name + '.js'])
    .map(async file => [file, createHash('sha256').update(await readFile(new URL('../' + file, import.meta.url))).digest('hex')]))),
  companionGuidance, productionChanged: false, syntheticConversationOnly: true,
  scriptedSetupOnly: true, automaticFactualScore: false, modelCalls: 0, wireCalls: [], scenarios: [],
};
// Record only non-secret request metadata, and assert the actual wire model.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === new URL(connection.baseURL).origin && url.pathname.endsWith('/messages') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body); assert.equal(body.model, model);
    report.wireCalls.push({ model: body.model, maxTokens: body.max_tokens, toolCount: body.tools?.length ?? 0, at: new Date().toISOString() });
  }
  return nativeFetch(input, init);
};
class Query extends SessionQueryEngine { name = 'companion-evaluation-query'; }

async function seedArchives(root, row) {
  // Hold the archived conversations byte-for-byte fixed during prompt comparisons.
  // Copy only the two original synthetic fixtures, never model-generated reviews.
  if (archiveFixtureRoot) {
    const baseline = JSON.parse(await readFile(join(archiveFixtureRoot, 'report.json'), 'utf8'));
    const fixtureCase = row.setup.archiveFixtureCase;
    const original = baseline.scenarios.find(s => s.name === fixtureCase); assert.ok(original);
    const events = JSON.parse(await readFile(join(archiveFixtureRoot, `${fixtureCase}-events.json`), 'utf8'));
    const archives = events.filter(e => e.seq < original.modelEvaluationStartSeq && e.type === 'user/message'
      && e.data.source?.form === 'summary').map(e => e.data.source.archive).slice(0, 2);
    assert.deepEqual(archives.map(a => a.label), ['雨天等车', '月亮邮局']);
    const sourceDirectory = join(archiveFixtureRoot, fixtureCase, 'archives');
    const destinationDirectory = join(root, 'archives');
    for (const archive of archives) {
      await new Trajectory.ArchiveStore(sourceDirectory).read(archive, new AbortController().signal);
      const relative = join(createHash('sha256').update(archive.ownerSessionId).digest('hex'), `${archive.id}.json.gz`);
      await mkdir(join(destinationDirectory, createHash('sha256').update(archive.ownerSessionId).digest('hex')), { recursive: true, mode: 0o700 });
      await copyFile(join(sourceDirectory, relative), join(destinationDirectory, relative), constants.COPYFILE_EXCL);
      await new Trajectory.ArchiveStore(destinationDirectory).read(archive, new AbortController().signal);
    }
    row.setup.reusedArchiveFixtures = { root: archiveFixtureRoot, archives: archives.map(a => ({ id: a.id, sha256: a.sha256 })) };
    return archives;
  }
  const fixture = await harness({ archiveDir: join(root, 'archives') });
  try {
    for (const scene of [
      { label: '雨天等车', exchanges: [
        ['下班时忽然下雨了，我在站台等车，手里还有一袋刚买的面包。', '雨落在站台顶上像一小段鼓点。面包袋里那一点暖意，正好陪你等这一班车。'],
        ['旁边小店的灯是橘色的，雨把地上的光拉得很长。我忽然觉得慢一点也挺好。', '那就给这几分钟留个名字，叫“缓冲带”吧。车还在路上，今天也可以在这里松一口气。'],
        ['好，缓冲带。我把靠窗那个位置留给想象里的小熊，它可以抱着面包睡一会儿。', '小熊已经把围巾搭在面包袋旁边了。窗外的灯一盏盏经过，它只管把这一小段路坐暖。'],
      ], summary: '曾聊过雨天站台、面包和橘色灯光，把等待叫作“缓冲带”，还想象了一只坐在窗边的小熊。可回看这段共同的话题。' },
      { label: '月亮邮局', exchanges: [
        ['我们开一家只在晚上营业的月亮邮局怎么样？门牌要用蓝色的。', '蓝色门牌挂在一弯月牙旁边，门上的铃铛很轻。来寄信的人可以慢慢写，柜台边有一盏小灯。'],
        ['让那只小熊来值夜班吧。收到没写完的信，就先夹一片树叶当书签。', '它会把树叶仔细夹好，再把信放进“明天也可以”那一格。夜里的邮局，连省略号都能有个舒服的位置。'],
        ['还有一个抽屉，专门装那些临时改了主意、决定亲口说的话。', '抽屉里可以铺软软的纸，贴一张小标签：“留给相见的时候”。小熊关灯前，会把这格放得离门近一点。'],
      ], summary: '曾一起想象月亮邮局：蓝色门牌、小熊值夜班、树叶书签，以及留给相见时亲口说的话。可回看这段共同创作。' },
    ]) {
      await fixture.send([calls(['trajectory_anchor', { label: scene.label }]), respond('我们接着聊。')], `把这段${scene.label}的聊天留个起点。`);
      const anchor = fixture.state().anchor;
      for (const [user, reply] of scene.exchanges) await fixture.send([respond(reply)], user);
      await fixture.send([calls(['trajectory_compact', { anchor_id: anchor.id, summary: scene.summary }]), respond('这段已经收好了。')], '把这段留作以后可以回看的记录吧。');
    }
    return fixture.state().archives;
  } finally { await fixture.close(); }
}

async function openRuntime(root, row, scenario, resume) {
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry, Query]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Trajectory, { archiveDir: join(root, 'archives') });
  ctx.systemPrompt.section({ name: 'companion-conversation', order: 1, text: companionGuidance });
  const degraded = [];
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveAuth: async () => ({ headers: { 'x-api-key': key } }),
    resolveUserId: () => 'trajectory-isolated-companion-evaluation',
    resolveFiles: () => new DeepSeekFileStore(join(root, 'files.json')),
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  });
  await adapter.resolveModel(provider, model);
  ctx.llm.registerAdapter([provider], adapter);
  const requests = [], scripted = [];
  let fixtureRunning = false;
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, provider); assert.equal(options.model, model);
    if (fixtureRunning) { const response = scripted.shift(); assert.ok(response); yield* response; return; }
    if (report.modelCalls >= 36 || row.modelCalls >= 12) throw new Error('Bounded model-call budget reached');
    report.modelCalls++; row.modelCalls++;
    const visibleAlreadyRead = options.messages.filter(m => m.role === 'tool').flatMap(message => {
      try {
        const value = JSON.parse(textOf(message));
        return value?.status === 'already_read' ? [{ toolCallId: message.toolCallId, archiveId: value.archive.id, requestedRange: value.requestedRange }] : [];
      } catch { return []; }
    });
    const request = { index: row.modelCalls, model: options.model, sessionSeq: handle.agent.session.seq,
      state: structuredClone(ctx.sessionProjections.stateOf(handle.agent.session, 'trajectory')), visibleAlreadyRead,
      at: new Date().toISOString(), requestChars: JSON.stringify(options.messages).length };
    row.receivedAlreadyReadCallIds = [...new Set([...(row.receivedAlreadyReadCallIds ?? []), ...visibleAlreadyRead.map(result => result.toolCallId)])];
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
  ctx.on('tools/result', (exec, result) => {
    if (fixtureRunning || row.update || !scenario.steer || exec.name !== 'trajectory_read' || result.isError || !exec.arguments?.archive_id) return;
    const prompt = '忽然有点想换个心情了。我们给今天起个轻快一点的名字吧，像给一张小唱片命名。';
    const message = userMessage(prompt), active = ctx.sessionProjections.stateOf(exec.agent.session, 'trajectory').anchor;
    row.update = { prompt, messageId: message.id, queuedAtSeq: exec.agent.session.seq, reviewAnchorId: active?.id };
    exec.agent.steer(message);
  });
  const agentOptions = { provider, model, reasoningEffort: 'high', maxTokens: 8192 };
  const handle = resume ? await ctx.agents.resume({ resumeSessionId: SessionId(resume), agentOptions })
    : await ctx.agents.create({ agentOptions, meta: { cwd: root }, sessionId: SessionId(randomUUID()) });
  const agent = handle.agent;
  const state = () => ctx.sessionProjections.stateOf(agent.session, 'trajectory');
  const events = () => agent.session.snapshotEvents();
  async function fixture(prompt, responses) {
    fixtureRunning = true; scripted.push(...responses);
    try { agent.followup(userMessage(prompt)); await agent.whenIdle(); assert.equal(scripted.length, 0); }
    finally { fixtureRunning = false; }
    assert.equal(events().findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed');
  }
  if (!resume) await fixture('我们以前聊过的几段片段已经放好了。', [respond('嗯，这些片段都在。')]);
  return { ctx, handle, agent, state, events, fixture,
    async send(prompt) {
      const before = agent.session.seq, timer = setTimeout(() => agent.cancel({ kind: 'user' }), 180000);
      try { agent.followup(userMessage(prompt)); await agent.whenIdle(); } finally { clearTimeout(timer); }
      const recent = events().slice(before), end = recent.findLast(e => e.type === 'turn/end');
      const replies = recent.filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).filter(Boolean);
      const tools = recent.filter(e => e.type === 'tool/call').map(e => ({ name: e.data.name, arguments: e.data.arguments }));
      const errors = recent.filter(e => e.type === 'tool/result' && e.data.message.isError).map(e => textOf(e.data.message));
      const readResults = recent.filter(e => e.type === 'tool/result').flatMap(event => {
        try {
          const value = JSON.parse(textOf(event.data.message));
          if (!value?.archive || !['read', 'already_read', 'end_of_archive'].includes(value.status)) return [];
          return [{ seq: event.seq, callId: event.data.message.toolCallId, status: value.status, archiveId: value.archive.id,
            intent: value.intent, focus: value.focus, requestedRange: value.requestedRange,
            ...(typeof value.text === 'string' ? { offset: value.offset, end: value.offset + value.text.length, returnedChars: value.text.length } : {}),
            workAnchorId: value.suspendedWorkAnchor?.id ?? (value.anchor?.kind === 'work' ? value.anchor.id : null) }];
        } catch { return []; }
      });
      row.rounds.push({ prompt, startSeq: before, endSeq: agent.session.seq, replies, tools, readResults, errors, ending: end?.data.reason, state: state() });
      await save(`${row.name}-progress.json`, row);
      assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end?.data.reason)); assert.ok(replies.length, 'A conversational response was produced');
      assert.deepEqual(errors, []); return { recent, replies };
    },
    async close() {
      try {
        await ctx.sessions.flush(agent.session);
        const all = events();
        await save(`${row.name}-events.json`, all);
        await save(`${row.name}-requests-${resume ? 'resumed' : 'initial'}.json`, requests);
        await save(`${row.name}-replay-degrades-${resume ? 'resumed' : 'initial'}.json`, degraded);
        const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader({ ...agent.session.header, delegationDepth: 0, isSeeded: false }, 0), { recovery: 'strict', validation: 'current' });
        for (const event of all) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event));
        assert.equal(restore.finish().events.length, all.length); row.strictReplay = true;
      } finally { await handle.dispose(); await ctx.fiber.dispose(); }
    },
  };
}

try {
  for (const scenario of scenarios) {
    const root = join(outputRoot, scenario.name); await mkdir(root, { recursive: true, mode: 0o700 });
    const row = { name: scenario.name, modelCalls: 0, rounds: [], setup: { workAnchorSeeded: Boolean(scenario.seedWork), reviewCompactionSeeded: Boolean(scenario.seedCompact),
      fullOriginalReadSeeded: Boolean(scenario.seedFullRead), archiveFixtureCase: scenario.fixtureCase ?? scenario.name } };
    report.scenarios.push(row); let h;
    try {
      const archives = await seedArchives(root, row); h = await openRuntime(root, row, scenario);
      for (const archive of archives) h.agent.session.append('user/message', createUserMessage({
        source: { kind: 'plugin:dsh-trajectory', form: 'summary', archive },
        content: [{ type: 'text', text: `[Earlier shared conversation]\n${archive.label}。这一段共同的话题保存在归档中，可以回看。\nArchive ID: ${archive.id}` }],
      }), { surfaceOp: 'append' });
      if (scenario.seedWork) {
        const responses = [calls(['trajectory_anchor', { label: '下班路上的夜聊' }])];
        if (scenario.seedCompact) responses.push(calls(['trajectory_read', { archive_id: archives[0].id,
          ...(scenario.seedFullRead ? { max_chars: Number.MAX_SAFE_INTEGER } : {}) }]));
        responses.push(respond('嗯，我在听。'));
        await h.fixture('今天的灯光让我想起以前雨天等车那一晚，想跟你慢慢聊聊。', responses);
        row.setup.workAnchorId = (h.state().suspendedWorkAnchor ?? h.state().anchor).id;
      }
      if (scenario.seedCompact) {
        const review = h.state().anchor; assert.equal(review.kind, 'review');
        await h.fixture('看着这段回忆，我现在又想到了周末的海边。我们沿着晚风里的沙滩慢慢走一会儿吧。', [
          calls(['trajectory_compact', { anchor_id: review.id, summary: '我们刚回看了雨天等车的片段：面包、橘色灯光、叫作“缓冲带”的等待，还有坐在窗边的小熊。这些已经聊过，仍是共同的背景。后来用户的话题自然转向周末海边，想沿着晚风里的沙滩慢慢走一会儿；现在这幅海边画面是正在接着聊的方向。可以带着那一点温暖继续联想，话题可以开放。' }]),
          respond('嗯。'),
        ]);
        assert.equal(h.state().anchor?.id, row.setup.workAnchorId); row.setup.reviewCompactedAndWorkRestored = true;
      }
      if (scenario.resume) {
        const id = h.agent.id, before = structuredClone(h.state()); await h.close(); h = undefined;
        h = await openRuntime(root, row, scenario, id); assert.deepEqual(h.state(), before); row.runtimeRecreatedAndSessionResumed = true;
      }
      row.modelEvaluationStartSeq = h.agent.session.seq;
      const prompts = [scenario.start, scenario.followup, ...(naturalObservation ? naturalFollowups[scenario.name] : [])];
      for (const prompt of prompts) await h.send(prompt);
      const evaluated = h.events().slice(row.modelEvaluationStartSeq);
      const toolCalls = evaluated.filter(e => e.type === 'tool/call');
      const results = evaluated.filter(e => e.type === 'tool/result').map(e => { try { return JSON.parse(textOf(e.data.message)); } catch { return null; } }).filter(Boolean);
      const summaries = evaluated.filter(e => e.type === 'user/message' && e.data.source?.form === 'summary');
      row.coverage = {
        modelCreatedWorkAnchor: toolCalls.some(e => e.data.name === 'trajectory_anchor'),
        archiveReads: results.filter(r => r.archive && typeof r.text === 'string').length,
        reviewWithUnderlyingWork: results.some(r => r.anchor?.kind === 'review' && r.suspendedWorkAnchor?.kind === 'work'),
        reviewReused: results.some(r => r.anchorReused === true),
        alreadyReadReminders: results.filter(r => r.status === 'already_read').length,
        remindersVisibleToModel: row.receivedAlreadyReadCallIds?.length ?? 0,
        focusedRereads: toolCalls.filter(e => e.data.name === 'trajectory_read').map(e => JSON.parse(e.data.arguments)).filter(a => a.intent && a.intent !== 'new_content'),
        modelReleases: toolCalls.filter(e => e.data.name === 'trajectory_release').length,
        modelCompactions: toolCalls.filter(e => e.data.name === 'trajectory_compact').length,
        workRestoredByModelCompaction: results.some(r => r.reminder?.startsWith('Review summarized.') && r.anchor?.kind === 'work'),
        finalAnchorKind: h.state().anchor?.kind ?? null,
        serverReportedModels: [...new Set(evaluated.filter(e => e.type === 'assistant/message').map(e => e.data.message.source?.replayState?.response?.responseModel).filter(Boolean))],
      };
      if (row.update) {
        const delivered = evaluated.find(e => e.type === 'user/message' && e.data.id === row.update.messageId);
        row.update.deliveredAtSeq = delivered?.seq;
        row.update.coveredByModelSummary = Boolean(delivered && summaries.some(e => e.sourceEventSeqs?.includes(delivered.seq)));
      }
      row.runtimePassed = true;
    } catch (error) { row.runtimePassed = false; row.error = safeError(error); }
    finally { if (h) await h.close().catch(error => { row.closeError = safeError(error); row.runtimePassed = false; }); }
    await save('report.json', report);
    console.log(JSON.stringify({ case: row.name, runtimePassed: row.runtimePassed, calls: row.modelCalls, coverage: row.coverage, error: row.error }));
  }
} finally {
  globalThis.fetch = nativeFetch;
  report.finishedAt = new Date().toISOString(); report.runtimePassed = report.scenarios.length === scenarios.length && report.scenarios.every(r => r.runtimePassed);
  report.replayDegradeInstrumentation = 'not available on native DeepSeek adapter; strict native log replay checked separately';
  report.requestedWireModels = [...new Set(report.wireCalls.map(r => r.model))];
  await save('report.json', report);
  console.log(JSON.stringify({ complete: true, runtimePassed: report.runtimePassed, modelCalls: report.modelCalls, wireCalls: report.wireCalls.length, requestedWireModels: report.requestedWireModels }));
  if (!report.runtimePassed) process.exitCode = 1;
}
