// 结构化压缩（CTX-017 至 CTX-022）。
// 设计取舍：不使用「把历史丢给模型总结一下」的不可验证自动摘要，而是做确定性结构化压缩，
// 保留清单强制成块、原文只从上下文移出而不删除（可按引用回读），压缩前后做关键事实核对。
import type { ChatMessage } from "./common.ts";
import { MARK } from "./layout.ts";
import type { ProbeReport, Retention } from "./types.ts";
import { RETENTION_LABELS } from "./types.ts";

const SENTENCE = /[^。！？；\n]+[。！？；]?/g;
const CONSTRAINTS = /禁止|必须|不得|只能|不要|务必|仅可|不可|约束|限制|上限|不少于|不允许/;
const DECISIONS = /决定|决策|采用|选择|方案|因此|结论|定为|不再/;
const OPEN = /未决|待确认|待定|待办|需要确认|尚未|未知|未验证|没有结论|TODO/i;
const FACTUAL = /\d|[Kk]\d+[^\d]|[\w.-]+\/[\w./-]+|\.(?:md|txt|json|log|ts|tsx|js|mjs|py|html|csv|xlsx|pdf|png)\b|已确认|回执/;
const ARTIFACT = /(?:[\w\u4e00-\u9fa5.-]+\/)+[\w\u4e00-\u9fa5.-]+\.[a-z0-9]{1,6}\b|\b[\w-]+\.(?:md|txt|json|log|ts|tsx|js|mjs|py|html|csv|xlsx|pdf|png)\b/gi;
const DIGIT = /\d+(?:\.\d+)?%?/g;

const LIMIT = { goals: 4, facts: 24, decisions: 12, open: 12, artifacts: 12, steps: 16, constraints: 12 };
const ITEM_MAX = 320;

function clip(value: string, max = ITEM_MAX) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function sentences(value: string): string[] {
  return (value.match(SENTENCE) || []).map(item => item.trim()).filter(item => item.length >= 4 && item.length <= 1200);
}
function push(list: string[], value: string, limit: number) {
  const text = clip(value);
  if (!text || list.includes(text) || list.length >= limit) return;
  list.push(text);
}
function pushRecent(list: string[], value: string, limit: number) {
  const entry = clip(value);
  if (!entry || list.includes(entry)) return;
  if (list.length >= limit) list.shift();
  list.push(entry);
}
function isCompacted(message: ChatMessage) { return message.role === "system" && String(message.content || "").startsWith(MARK.compacted); }

/** 从一条消息里抽取可核对的事实片段：带数字、路径、编号或回执标记的句子。 */
function factualSentences(value: string): string[] {
  return sentences(value).filter(item => FACTUAL.test(item));
}

/** 按保留清单从被压缩的消息中抽取结构化内容（CTX-018）。 */
export function extractRetention(messages: ChatMessage[], options: { input: string; steps?: string[] }): Retention {
  const retention: Retention = { goals: [], facts: [], decisions: [], open: [], artifacts: [], steps: [], constraints: [] };
  for (const sentence of sentences(options.input)) {
    if (/目标|成功|交付|验收|判据/.test(sentence)) push(retention.goals, sentence, LIMIT.goals);
  }
  push(retention.goals, clip(options.input, 400), LIMIT.goals);
  for (const message of messages) {
    if (isCompacted(message)) continue;
    const content = typeof message.content === "string" ? message.content : "";
    const user = message.role === "user";
    for (const sentence of sentences(content)) {
      if (CONSTRAINTS.test(sentence)) push(retention.constraints, sentence, LIMIT.constraints);
      if (!user && DECISIONS.test(sentence)) pushRecent(retention.decisions, sentence, LIMIT.decisions);
      if (!user && (OPEN.test(sentence) || sentence.endsWith("？"))) pushRecent(retention.open, sentence, LIMIT.open);
    }
    const source = user ? "" : content;
    for (const sentence of factualSentences(source)) pushRecent(retention.facts, sentence, LIMIT.facts);
    for (const match of content.matchAll(ARTIFACT)) pushRecent(retention.artifacts, match[0], LIMIT.artifacts);
  }
  for (const step of options.steps || []) push(retention.steps, step, LIMIT.steps);
  return retention;
}

/** 合并两轮压缩结果并可继续累积压缩：同一轮之内只做规范化去重（CTX-017、CTX-022）。 */
export function mergeRetention(previous: Retention | null, next: Retention): Retention {
  const merged: Retention = { goals: [], facts: [], decisions: [], open: [], artifacts: [], steps: [], constraints: [] };
  for (const key of Object.keys(merged) as (keyof Retention)[]) {
    const seen = new Set<string>();
    for (const value of [...(previous?.[key] || []), ...next[key]]) {
      const text = clip(value);
      if (seen.has(text)) continue;
      seen.add(text); merged[key].push(text);
    }
    if (merged[key].length > LIMIT[key]) merged[key] = merged[key].slice(merged[key].length - LIMIT[key]);
  }
  return merged;
}

export function isRetentionEmpty(retention: Retention) { return Object.values(retention).every(list => !list.length); }

/** 渲染为一等公民的压缩区块：可序列化、可继续累积、可回读（CTX-017）。 */
export function renderRetention(retention: Retention, round: number, refs: string[]): string {
  const sections = (Object.keys(RETENTION_LABELS) as (keyof Retention)[]).map(key => {
    const list = retention[key];
    return `${RETENTION_LABELS[key]}：\n` + (list.length ? list.map(item => "- " + item).join("\n") : "- （无）");
  });
  return [
    `${MARK.compacted} · 第 ${round} 轮】本节由系统结构化生成，继续累积压缩时按去重合并，原文只从上下文移出、不删除。`,
    ...sections,
    refs.length ? `回读引用：${refs.join("、")}` : "回读引用：（无）"
  ].join("\n");
}

/** 探针问题集：从被移出上下文的内容里取关键数字、路径与约束（CTX-021，对齐 R-13）。 */
export function probeItems(dropped: ChatMessage[]): { label: string; key: string }[] {
  const seen = new Set<string>();
  const items: { label: string; key: string }[] = [];
  const add = (label: string, key: string) => { if (key && !seen.has(key)) { seen.add(key); items.push({ label, key }); } };
  for (const message of dropped) {
    const content = typeof message.content === "string" ? message.content : "";
    for (const match of content.matchAll(DIGIT)) add("数字", match[0]);
    for (const match of content.matchAll(ARTIFACT)) add("路径", match[0]);
    for (const sentence of sentences(content)) {
      if (!CONSTRAINTS.test(sentence)) continue;
      const key = clip(sentence, 24);
      if (key.length >= 6) add("约束", key);
    }
  }
  return items;
}

/** 压缩前后各核对一次，度量关键事实保留率；低于下限即阻止继续压缩（CTX-021、R-13）。 */
export function probeCheck(items: { label: string; key: string }[], text: string, floor: number): ProbeReport {
  const normalized = text.replace(/\s+/g, "");
  const missing: string[] = [];
  let kept = 0;
  for (const item of items) {
    if (normalized.includes(item.key.replace(/\s+/g, ""))) kept++;
    else if (missing.length < 8) missing.push(`${item.label}：${item.key}`);
  }
  const total = items.length;
  const rate = total ? kept / total : 1;
  return { total, kept, rate, missing, passed: total === 0 || rate >= floor };
}
