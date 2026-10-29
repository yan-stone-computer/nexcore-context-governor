// 上下文治理管线（CTX-009 至 CTX-016）。
// 处理顺序固定为：能清就清（工具结果清理）→ 能记就记（结构化压缩）→ 能委托就委托（子智能体隔离，本版本未启用）
// → 最后才整体压缩；压缩被探针拦下或已达轮次上限时，改为缩减注入层；仍超限才拒绝执行并说明原因。
import type { ChatMessage } from "./common.ts";
import { classify, measure, overBudget, pruneToolResults } from "./budget.ts";
import { extractRetention, mergeRetention, probeCheck, probeItems, renderRetention } from "./compact.ts";
import { joinInjection, MARK, shrinkInjection } from "./layout.ts";
import type { BudgetReport, ContextPolicy, ProbeReport, Retention } from "./types.ts";

export type GovernInput = {
  messages: ChatMessage[];
  injection: string[];
  safety: string;
  toolsTokens: number;
  window: number;
  policy: ContextPolicy;
  previous: Retention | null;
  input: string;
  steps: string[];
  round: number;
  refs?: string[];
  forceCompact?: boolean;
  trigger?: "budget" | "model";
};
export type CompactionOutcome = {
  round: number; trigger: "budget" | "model"; retention: Retention; text: string; probe: ProbeReport;
  before: number; after: number; freed: number; dropped: number; refs: string[]; blockedReason: string;
};
export type GovernResult = {
  messages: ChatMessage[]; injection: string[]; report: BudgetReport; actions: string[];
  pruned: { count: number; freed: number }; compaction: CompactionOutcome | null; rejected: string;
};

/** 安全约束压缩后由系统重新注入固定区块：摘要里没有它也必须补回（CTX-021）。 */
export function ensureSafety(injection: string[], safety: string): { injection: string[]; restored: boolean } {
  if (!safety) return { injection, restored: false };
  const body = injection.filter(paragraph => !paragraph.startsWith(MARK.safety));
  return { injection: [...body, safety], restored: body.length !== injection.length || !injection.some(paragraph => paragraph.startsWith(MARK.safety)) };
}

function rebuild(messages: ChatMessage[], injection: string[]): void {
  if (messages[1]?.role === "system") messages[1] = { ...messages[1], content: joinInjection(injection) };
}

export function govern(input: GovernInput): GovernResult {
  const { policy } = input;
  const actions: string[] = [];
  const messages = input.messages;
  let injection = [...input.injection];
  let report = measure(messages, input.toolsTokens, input.window, policy, actions);
  let pruned: { count: number; freed: number; protected?: number; calls?: number } = { count: 0, freed: 0 };
  let compaction: CompactionOutcome | null = null;
  let rejected = "";

  const pressure = overBudget(report) || report.ratio >= policy.compactionThreshold;
  const wantCompact = Boolean(input.forceCompact) || (pressure && report.ratio >= policy.compactionThreshold);
  // 温和档先压缩过程日志；到激进档再多压更早轮次（CTX-010）。
  const aggressive = report.ratio >= policy.aggressiveThreshold;
  if (aggressive && pressure) actions.push(`上下文占用 ${(report.ratio * 100).toFixed(0)}%，进入激进档`);

  if (policy.goals.pruneToolResults && pressure) {
    const result = pruneToolResults(messages);
    pruned = result;
    if (result.count) {
      actions.push(`清理工具结果 ${result.count} 处、调用参数 ${result.calls} 处，释放约 ${result.freed} tokens${result.protected ? `（最近 ${result.protected} 次结果原样保留：它们正是当前这一步在用的）` : ""}`);
      report = measure(messages, input.toolsTokens, input.window, policy, actions);
    }
  }

  const compactAllowed = (policy.goals.compaction || policy.goals.structuredNotes) && input.round < policy.maxCompactionRounds;
  if (compactAllowed && (wantCompact || overBudget(report))) {
    const before = report.tokens;
    const tail = aggressive ? Math.min(policy.preserveTailTurns, 1) : policy.preserveTailTurns;
    const attempt = compactSession({ ...input, injection, safety: input.safety, round: input.round + 1, trigger: input.trigger || (input.forceCompact ? "model" : "budget") }, tail);
    if (attempt.outcome) {
      injection = attempt.injection; rebuild(messages, injection);
      report = measure(messages, input.toolsTokens, input.window, policy, actions);
      attempt.outcome.before = before; attempt.outcome.after = report.tokens;
      attempt.outcome.freed = Math.max(0, before - report.tokens);
      compaction = attempt.outcome;
      actions.push(`结构化压缩第 ${compaction.round} 轮，移出 ${compaction.dropped} 段，释放约 ${compaction.freed} tokens，关键事实保留率 ${(compaction.probe.rate * 100).toFixed(0)}%`);
      report = measure(messages, input.toolsTokens, input.window, policy, actions);
    } else if (attempt.blockedReason) {
      actions.push(attempt.blockedReason);
      compaction = attempt.decision;
    }
  }

  /**
   * 还是超预算：连最近几次工具结果也一起清。
   *
   * 先保后清是刻意的顺序——能保住就保住（模型看得见文件才做得了事），实在放不下才退到这一步，
   * 而不是一上来就把它的输入挖空。
   */
  if (overBudget(report) && policy.goals.pruneToolResults) {
    const result = pruneToolResults(messages, 1200, 0);
    if (result.count) {
      pruned = { count: pruned.count + result.count, freed: pruned.freed + result.freed, protected: 0, calls: (pruned.calls || 0) + result.calls };
      actions.push(`预算仍不足，连最近的工具结果一并清理 ${result.count} 处，释放约 ${result.freed} tokens`);
      report = measure(messages, input.toolsTokens, input.window, policy, actions);
    }
  }
  if (overBudget(report)) {
    const shrunk = shrinkInjection(injection);
    if (shrunk.dropped.length) {
      injection = shrunk.paragraphs; rebuild(messages, injection);
      actions.push(`缩减注入层，移出 ${shrunk.dropped.length} 段`);
      report = measure(messages, input.toolsTokens, input.window, policy, actions);
    }
  }

  if (overBudget(report)) {
    /**
     * 报错要能照做：说清改哪个设置、改成什么量级。
     * 以前只说「请缩短输入、调低注入配额或改用更大窗口的模型」——用户知道自己该做点什么，
     * 但满设置页找不到「注入配额」这个词，最后只能把整段任务删掉重来。
     */
    /**
     * 报错里必须带上**分块数字**：只报一个总数，用户既不知道是什么吃掉的，也不知道该动哪一项。
     * 真机上第一次看到这条时，谁也没想到 6.1k 是工具定义、11k 是模型自己写文件的内容。
     */
    const block = (name: string) => report.blocks.find(item => item.name === name)?.tokens ?? 0;
    const parts = [`工具定义 ${report.tools}`, `固定前缀 ${Math.max(0, block("prefix") - report.tools)}`, `注入层 ${block("injection")}`, `会话区 ${block("session")}`, `本轮工具与输出 ${block("input")}`].join(" · ");
    rejected = `四区块预算超限 ${report.overflow} tokens（这次最多能用 ${report.ceiling}，窗口 ${report.window}）。本次占用 ${report.tokens}：${parts}。已依次清理工具结果、结构化压缩会话区、缩减注入层仍不足。三条出路：① 打开设置 → 运行护栏 → 把「上下文窗口 token」调到 ${Math.max(65536, report.window * 2)} 左右再试（上限 200000）；② 把「工具下发方式」改成按需下发，工具定义那 ${report.tools} tokens 只在需要时加载；③ 把这一轮的任务拆小，或换一个窗口更大的模型。原文没有删除，随时可以回看。`;
    actions.push("拒绝执行并说明原因");
  }
  report = measure(messages, input.toolsTokens, input.window, policy, actions);
  return { messages, injection, report, actions, pruned, compaction, rejected };
}

type Attempt = { outcome: CompactionOutcome | null; injection: string[]; blockedReason: string; decision: CompactionOutcome | null };

function compactSession(input: GovernInput & { trigger: "budget" | "model" }, tailTurns: number): Attempt {
  const { messages, policy } = input;
  const groups = classify(messages);
  const session = groups.session;
  const users = session.filter(index => messages[index].role === "user");
  const cutStart = session[0] ?? -1;
  const keepFrom = users.length > tailTurns ? users[users.length - tailTurns] : -1;
  if (cutStart < 0 || keepFrom < 0 || keepFrom <= cutStart) return { outcome: null, injection: input.injection, blockedReason: "", decision: null };
  const dropped = messages.slice(cutStart, keepFrom);
  if (!dropped.length) return { outcome: null, injection: input.injection, blockedReason: "", decision: null };

  const retention = mergeRetention(input.previous, extractRetention(dropped, { input: input.input, steps: input.steps }));
  const refs = [...new Set([...(input.refs || []), ...receiptRefs(dropped)])].slice(0, 12);
  const text = renderRetention(retention, input.round, refs);
  const probe = probeCheck(probeItems(dropped), text, policy.probeFloor);
  const decision: CompactionOutcome = { round: input.round, trigger: input.trigger, retention, text, probe, before: 0, after: 0, freed: 0, dropped: dropped.length, refs, blockedReason: "" };

  if (!probe.passed) {
    decision.blockedReason = `压缩被拦截：关键事实保留率 ${(probe.rate * 100).toFixed(0)}% 低于下限 ${(policy.probeFloor * 100).toFixed(0)}%，不继续压缩（缺失：${probe.missing.slice(0, 3).join("；") || "无"}）`;
    return { outcome: null, injection: input.injection, blockedReason: decision.blockedReason, decision };
  }

  // 压缩结果是一等公民：旧的压缩块被新块取代（内容已去重合并），安全约束始终由系统重新注入并排在末尾。
  const base = input.injection.filter(paragraph => !paragraph.startsWith(MARK.compacted) && !paragraph.startsWith(MARK.safety));
  const nextInjection = ensureSafety([...base, text], input.safety).injection;
  messages.splice(cutStart, keepFrom - cutStart);
  return { outcome: decision, injection: nextInjection, blockedReason: "", decision };
}

function receiptRefs(dropped: ChatMessage[]): string[] {
  const refs: string[] = [];
  for (const message of dropped) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try { const parsed = JSON.parse(message.content) as { receiptId?: string }; if (parsed.receiptId) refs.push("receipt:" + parsed.receiptId); } catch { /* 忽略非结构化结果 */ }
  }
  return refs;
}
