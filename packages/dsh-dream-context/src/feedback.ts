import type { Book } from './types.js';
import type { Proposal } from './dream.js';
import { UNKNOWN_MEMORY_PREFIX } from './preferences.js';

export const MAX_DREAM_CORRECTIONS = 2;
/** Model request rounds one dream may take at most: the first answer plus each correction round. */
export const DREAM_ROUND_ALLOWANCE = 1 + MAX_DREAM_CORRECTIONS;

// Only authored-output validation is recoverable here. Cancellation, provider,
// storage and programming errors must still stop the existing dream attempt.
const hints = new Map<string, string>([
  ['Dream output must contain complete episodes and memories JSON; original retained', '请返回完整、可解析且符合字段约定的 JSON，包含 episodes 和 memories；没有记忆变更时 memories 可以为空。'],
  ['Dream revision was not among the presented current records', '修订必须使用已呈现的当前记忆 ID；新增记忆必须省略 id，由系统生成。已有记忆未呈现时，请先取得当前记录，或暂不提交这项修订。'],
  ['Memory revision must name an existing ID', '新增记忆请省略 id；修订已有记忆请使用当前库中已呈现的真实 ID。'],
  ['Unknown or repeated episode update', 'episodes 只能使用已呈现的真实经历 ID，同一 ID 只提交一次。'],
  ['Dream episode revision was not among the presented records', '只修订本次已呈现或已查阅的经历，使用其真实 ID。'],
  ['Dream omitted a requested episode; original context is retained', '请在 episodes 中包含本次 requiredEpisode 指定的经历及其总结。'],
  ['Retention extension needs a reason and must fit maxSummaryDays', '延长保留需要 keepReason，keepUntil 必须是毫秒时间戳且不超过给出的 maxKeepUntil；不延长时省略这两个字段。'],
  ['Memory evidence is outside this branch', 'evidence 只能引用当前分支真实存在的 episode 或 legacy 来源 ID，不要引用自拟 ID 或记忆 ID。A daytime note id (note_...) is not a source either; cite the episodeId shown with that note.'],
  ['Duplicate memory revision', '同一条记忆只提交一次，将其修改合并为一项。'],
  ['Dream bias adjustments must name sampled memories', 'biasAdjustments 只能使用本次补充清单中抽选的已有记忆 ID。'],
  ['Bias batch repeats a memory ID', 'biasAdjustments 中每个记忆 ID 只出现一次。'],
  [UNKNOWN_MEMORY_PREFIX, '偏置调整必须指向当前分支真实存在的记忆 ID；请使用本次呈现的完整 ID，不要凭印象改写。'],
]);

/** Explain the rejection without rewriting the author's proposal or inferring
 * that an unknown ID is definitely a new memory rather than a mistyped update. */
export function proposalFeedback(error: unknown, proposal: Proposal | undefined, book: Book): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const hint = hints.get(error.message) ?? (error.message.startsWith(UNKNOWN_MEMORY_PREFIX) ? hints.get(UNKNOWN_MEMORY_PREFIX) : undefined);
  if (!hint) return undefined;
  const known = new Set(book.memories.map(memory => memory.id));
  const unknown = proposal?.memories.flatMap((memory, index) => memory.id !== undefined && !known.has(memory.id)
    ? [`memories[${index}].id = ${JSON.stringify(memory.id.slice(0, 256))} 在当前记忆库中不存在。`] : []) ?? [];
  return ['[梦境提交校验反馈：本次结果尚未提交，任何总结、记忆或偏置均未写入。]',
    `校验原因：${error.message}`, hint, ...unknown.slice(0, 16),
    ...(unknown.length > 16 ? [`另有 ${unknown.length - 16} 项同类 ID 问题，请一并核对。`] : []),
    '请由你自己修正后重新返回完整 JSON，包含本次仍要提交的全部总结和记忆变更，不要只返回修正片段。新增与修订的意图由你判断；系统不会自动删除 ID 或改写正文。',
    '这是同一次梦境的校验反馈，不是新的日间对话。继续使用本次已给出的真实范围、记录和来源；本次整理的总时限与容量限制保持不变。',
  ].join('\n');
}
