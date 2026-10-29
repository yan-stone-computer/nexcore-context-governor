// 四区块预算模型（CTX-001 至 CTX-008）。
import type { ChatMessage } from "./common.ts";
import { messageTokens } from "./tokens.ts";
import type { BlockItem, BlockName, BlockReport, BudgetReport, ContextPolicy } from "./types.ts";
import { BUDGET_RATIO } from "./types.ts";

// 单条消息的 token 估算住在 core/provider.ts：图片不能按 base64 长度算，这个规则只有一处能改。
// 这里再导出一次，是为了不打断既有的导入路径。
export { messageTokens };

export const BLOCK_META: { name: BlockName; label: string }[] = [
  { name: "prefix", label: "固定前缀" },
  { name: "injection", label: "注入层" },
  { name: "session", label: "会话区" },
  { name: "input", label: "当前输入" }
];

/** 预算总额不超过窗口的 70%，各区块在总额内按配额分摊。 */
export function ceilingOf(window: number, policy: ContextPolicy): number {
  const total = policy.quotas.prefix + policy.quotas.injection + policy.quotas.session + policy.quotas.input;
  return Math.floor(window * Math.min(BUDGET_RATIO, total));
}
export function allowanceOf(ceiling: number, policy: ContextPolicy, name: BlockName): number {
  return Math.floor(ceiling * policy.quotas[name]);
}

/** 区块归属：索引 0 为固定前缀；紧随其后的系统消息为注入层；最后一个用户消息之后为当前输入，其余为会话区。 */
export function classify(messages: ChatMessage[]): Record<BlockName, number[]> {
  const result: Record<BlockName, number[]> = { prefix: [], injection: [], session: [], input: [] };
  if (!messages.length) return result;
  result.prefix.push(0);
  let cursor = 1;
  if (messages[1]?.role === "system") { result.injection.push(1); cursor = 2; }
  let lastUser = -1;
  for (let index = cursor; index < messages.length; index++) if (messages[index].role === "user") lastUser = index;
  for (let index = cursor; index < messages.length; index++) {
    if (lastUser >= 0 && index >= lastUser) result.input.push(index);
    else result.session.push(index);
  }
  return result;
}

function itemOf(message: ChatMessage, index: number): BlockItem {
  // 多模态消息的 content 是数组，直接 JSON.stringify 会把 base64 原样铺进标签里（几万字符）。
  // 所以这里只描述「有哪些块」，不描述块里的内容。
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map(part => part.type === "text" ? part.text : `［图片 ×1］`).join(" ") || "（空）"
      : JSON.stringify(message.tool_calls || []);
  return { label: `${message.role === "tool" ? "工具结果" : message.role === "assistant" ? "模型回复" : message.role === "user" ? "用户输入" : "系统"} · ${content.replace(/\s+/g, " ").slice(0, 46)}`, tokens: messageTokens(message), ref: `msg:${index}` };
}

/** 统计四区块占用，并下钻到具体条目（CTX-005：预算占用可拆到区块并下钻）。 */
export function measure(messages: ChatMessage[], toolsTokens: number, window: number, policy: ContextPolicy, actions: string[] = []): BudgetReport {
  const ceiling = ceilingOf(window, policy);
  const groups = classify(messages);
  const blocks: BlockReport[] = BLOCK_META.map(meta => {
    const items = groups[meta.name].map(index => itemOf(messages[index], index));
    const tokens = items.reduce((sum, item) => sum + item.tokens, 0) + (meta.name === "prefix" ? toolsTokens : 0);
    return { name: meta.name, label: meta.label, quota: policy.quotas[meta.name], allowance: allowanceOf(ceiling, policy, meta.name), tokens, items };
  });
  const tools = toolsTokens;
  const tokens = blocks.reduce((sum, block) => sum + block.tokens, 0);
  return {
    window, ceiling, tokens, estimatedTokens: tokens, tools,
    ratio: Number((tokens / window).toFixed(4)),
    overflow: Math.max(0, tokens - ceiling),
    blocks, actions, cache: policy.cacheMode, estimated: true
  };
}

/** 超限判断只用总额：区块配额是分配参考，不单独拒绝某一区块。 */
export function overBudget(report: BudgetReport) { return report.tokens > report.ceiling; }

/**
 * 工具结果清理：只替换结果内容，保留调用记录与回执引用（CTX-012）。
 *
 * `protect` 是最近几条工具结果**原样保留**的条数。
 * 这一条是被真机逼出来的：规则原本是「超过 1200 字符就清成 240 字符预览」，而它在下一步就执行——
 * 模型刚读回来的文件正文，下一轮就被清掉，于是它永远看不到自己刚读的东西。用户的观察是
 * 「index.html、game.js、styles.css 的读取结果都被截断成 200 字符预览……我无法核对里面定义了什么」，
 * 而模型的表现就是反过来问用户要内容。清理是给**用过的**旧结果腾地方，不是把模型的输入挖空。
 */
/**
 * 保护最近 protect 条，但**至少留一条可清的**。
 *
 * 这一步之所以在这里执行，就是为了腾出空间；把可清的全都保住等于这一步什么都没做，
 * 后面只能靠压缩与缩减注入去顶，顺序也乱了。所以：可清的有 n 条时，最多保护 n-1 条。
 * protect=0 必须真的等于「一条都不保」（`slice(-0)` 是 `slice(0)`，会把整份列表都当成要保护的）。
 */
function shieldOf(keys: (string | number)[], protect: number): Set<string | number> {
  const count = Math.max(0, Math.min(protect, keys.length - 1));
  return new Set(count > 0 ? keys.slice(-count) : []);
}

/**
 * 工具结果清理：只替换内容，保留调用记录与回执引用（CTX-012）。
 *
 * 两件事一起做，因为它们吃的是同一笔预算，而且第二件常被忽略：
 * ① **工具返回**：超过 1200 字符的清成预览；
 * ② **调用参数**：模型写文件时把整份内容放在 tool_calls 里——一次 `builtin_write_file` 的返回
 *    可能只有几十字节（path/bytes/sha256），而参数里躺着几百行 HTML。真机上「本轮工具与输出
 *    11083 tokens」绝大部分是这一项，而且它每一轮都跟着请求重发。
 *
 * `protect` 是最近几条**原样保留**的条数（结果与参数各自独立计算）：它们正是当前这一步在用的东西。
 * 清理是给用过的旧内容腾地方，不是把模型的输入挖空。
 */
export function pruneToolResults(messages: ChatMessage[], keep = 1200, protect = 3): { count: number; freed: number; protected: number; calls: number } {
  let count = 0, freed = 0;

  // ── ① 工具返回
  const bigResults = messages
    .map((message, index) => ({ message, index }))
    .filter(item => item.message.role === "tool" && typeof item.message.content === "string" && item.message.content.length > keep);
  const shielded = shieldOf(bigResults.map(item => item.index), protect);
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "tool" || typeof message.content !== "string" || message.content.length <= keep) continue;
    if (shielded.has(index)) continue;
    let preview = message.content.slice(0, 240);
    let receiptId = "";
    try {
      const parsed = JSON.parse(message.content) as { receiptId?: string; result?: unknown };
      preview = JSON.stringify(parsed.result).slice(0, 240);
      receiptId = String(parsed.receiptId || "");
    } catch { /* 非结构化结果按原文截断 */ }
    const before = messageTokens(message);
    /**
     * 取回原文的两条路都要写出来（只有 receiptId 时，模型常常不知道该用哪个工具换回来），
     * 但必须写得短：这条注记**每条被清理的结果都会带一份**，长一句就是几十个 token 的常态开销。
     */
    message.content = JSON.stringify({ ...(receiptId ? { receiptId } : {}), cleared: true, preview, note: `已清理（原文未删除）。取原文：builtin_context_ref 按 receiptId${receiptId ? `（${receiptId}）` : ""} 回读，或用原工具（如 builtin_read_file）重读一次。` });
    freed += Math.max(0, before - messageTokens(message));
    count++;
  }

  // ── ② 调用参数：**独立判定**，因为一次调用的结果可能很小而参数很大（write_file 就是这样）
  const bigCalls = messages
    .flatMap(message => message.role === "assistant" ? (message.tool_calls || []).map(call => ({ message, call })) : [])
    .filter(item => String(item.call.function?.arguments || "").length > keep);
  const shieldedCalls = shieldOf(bigCalls.map(item => String(item.call.id)), protect);
  let calls = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    // 只清**它自己就很大**的调用：参数很小的时候，把「{}」换成一段说明反而会多出几百字节（实测踩过）。
    const hit = message.tool_calls.filter(call => String(call.function?.arguments || "").length > keep && !shieldedCalls.has(String(call.id)));
    if (!hit.length) continue;
    const targets = new Set(hit.map(call => String(call.id)));
    const before = messageTokens(message);
    /**
     * `arguments` 仍然必须是**一段合法 JSON 字符串**：上游对 tool_calls 的格式有要求，
     * 清成空串会让请求直接 400。tool_call 与 tool 结果成对保留，只是内容换成说明——
     * 要重看这次调用写了什么，回执表与调用意图表里都还有原文。
     */
    message.tool_calls = message.tool_calls.map(call => targets.has(String(call.id))
      ? { ...call, function: { ...call.function, arguments: JSON.stringify({ cleared: true, tool: call.function.name, note: "这次调用的参数已清理（原文未删除）：要重看它写了什么，用 builtin_context_ref 取本次回执，或直接重新读那个文件；要接着改，先读文件再改。" }) } }
      : call);
    freed += Math.max(0, before - messageTokens(message));
    calls += hit.length;
  }
  return { count, freed, protected: shielded.size, calls };
}

