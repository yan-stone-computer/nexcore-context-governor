// 第 18 章上下文工程与预算管理（CTX-001 至 CTX-034）的类型与默认策略。
// 本文件不依赖任何运行时模块，供内核、界面与测试共同引用。
export type BlockName = "prefix" | "injection" | "session" | "input";

export type BlockItem = { label: string; tokens: number; ref: string };
export type BlockReport = { name: BlockName; label: string; quota: number; allowance: number; tokens: number; items: BlockItem[] };
export type BudgetReport = {
  window: number; ceiling: number; tokens: number; estimatedTokens: number; tools: number;
  ratio: number; overflow: number; blocks: BlockReport[]; actions: string[]; cache: CacheMode; estimated: true;
};

export type ContextGoals = {
  pruneToolResults: boolean;
  compaction: boolean;
  structuredNotes: boolean;
  subagentIsolation: boolean;
  onDemandRetrieval: boolean;
};
export type CacheMode = "system-only" | "exclude-tool-results" | "none";
export type ContextPolicy = {
  quotas: Record<BlockName, number>;
  compactionThreshold: number;
  aggressiveThreshold: number;
  preserveTailTurns: number;
  probeFloor: number;
  maxCompactionRounds: number;
  cacheMode: CacheMode;
  goals: ContextGoals;
};

/** 压缩的强制保留清单（CTX-018）。 */
export type Retention = {
  goals: string[]; facts: string[]; decisions: string[]; open: string[];
  artifacts: string[]; steps: string[]; constraints: string[];
};
export type ProbeReport = { total: number; kept: number; rate: number; missing: string[]; passed: boolean };
export type CompactionRecord = {
  id: string; runId: string; round: number; trigger: "budget" | "model";
  before: number; after: number; freed: number; dropped: number;
  retention: Retention; text: string; probe: ProbeReport;
  versions: { prompt: string; tool: string; model: string };
  refs: string[]; snapshot: boolean; createdAt: number; updatedAt: number;
};

export const RETENTION_LABELS: Record<keyof Retention, string> = {
  goals: "任务目标与成功判据",
  facts: "已确认事实",
  decisions: "决策与理由",
  open: "未决问题",
  artifacts: "产物路径",
  steps: "已完成步骤的调用记录",
  constraints: "用户显式提出的约束"
};

/** 预算总额上限：窗口的 70%，其余留给输出与推理（CTX-002）。 */
export const BUDGET_RATIO = 0.7;

/** 四区块默认配额，合计为 1，表示在预算总额内的相对份额（CTX-003）。 */
export const DEFAULT_QUOTAS: Record<BlockName, number> = { prefix: 0.15, injection: 0.25, session: 0.3, input: 0.3 };

export const DEFAULT_POLICY: ContextPolicy = {
  quotas: { ...DEFAULT_QUOTAS },
  // 达到温和档先清理与压缩，达到激进档再缩减注入层（CTX-009 至 CTX-016）。
  compactionThreshold: 0.85,
  aggressiveThreshold: 0.95,
  preserveTailTurns: 2,
  probeFloor: 0.8,
  maxCompactionRounds: 3,
  cacheMode: "exclude-tool-results",
  goals: { pruneToolResults: true, compaction: true, structuredNotes: true, subagentIsolation: false, onDemandRetrieval: true }
};

function flag(value: unknown, fallback: boolean) { return typeof value === "boolean" ? value : fallback; }
function ratio(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
function count(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** 把存储中的策略归一化：旧记录缺字段时补齐默认值，越界值回退，避免升级后读数失败（CTX-004）。 */
export function normalizePolicy(value: unknown): ContextPolicy {
  const input = (value && typeof value === "object" ? value : {}) as Partial<ContextPolicy>;
  const quotas = { ...DEFAULT_QUOTAS };
  const rawQuotas = (input.quotas && typeof input.quotas === "object" ? input.quotas : {}) as Partial<Record<BlockName, number>>;
  for (const name of Object.keys(quotas) as BlockName[]) quotas[name] = ratio(rawQuotas[name], quotas[name], 0.05, 0.6);
  const total = quotas.prefix + quotas.injection + quotas.session + quotas.input;
  for (const name of Object.keys(quotas) as BlockName[]) quotas[name] = Number((quotas[name] / total).toFixed(4));
  const goals = { ...DEFAULT_POLICY.goals };
  const rawGoals = (input.goals && typeof input.goals === "object" ? input.goals : {}) as Partial<ContextGoals>;
  for (const name of Object.keys(goals) as (keyof ContextGoals)[]) goals[name] = flag(rawGoals[name], goals[name]);
  const mode = input.cacheMode;
  return {
    quotas,
    compactionThreshold: ratio(input.compactionThreshold, DEFAULT_POLICY.compactionThreshold, 0.4, 0.99),
    aggressiveThreshold: ratio(input.aggressiveThreshold, DEFAULT_POLICY.aggressiveThreshold, 0.5, 1),
    preserveTailTurns: count(input.preserveTailTurns, DEFAULT_POLICY.preserveTailTurns, 0, 6),
    probeFloor: ratio(input.probeFloor, DEFAULT_POLICY.probeFloor, 0.5, 1),
    maxCompactionRounds: count(input.maxCompactionRounds, DEFAULT_POLICY.maxCompactionRounds, 0, 10),
    cacheMode: mode === "system-only" || mode === "exclude-tool-results" || mode === "none" ? mode : DEFAULT_POLICY.cacheMode,
    goals
  };
}

/** 界面与接口共用的策略字段说明，避免两处各自硬编码。 */
export const POLICY_FIELDS = [
  { key: "quotas", label: "四区块配额", detail: "固定前缀 / 注入层 / 会话区 / 当前输入，合计为预算总额的相对份额" },
  { key: "compactionThreshold", label: "压缩触发阈值", detail: "占用超过该比例即触发结构化压缩" },
  { key: "aggressiveThreshold", label: "激进档阈值", detail: "超过该比例先缩减注入层" },
  { key: "preserveTailTurns", label: "保留最近轮次", detail: "压缩时永久保留的最近用户轮次原文" },
  { key: "probeFloor", label: "关键事实保留率下限", detail: "低于该值即阻止继续压缩" },
  { key: "maxCompactionRounds", label: "单次运行压缩上限", detail: "达到上限后不再压缩，改为缩减注入层" }
] as const;
