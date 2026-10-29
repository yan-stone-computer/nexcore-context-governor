import assert from "node:assert/strict";
import test from "node:test";
import {
  BUDGET_RATIO,
  DEFAULT_POLICY,
  MARK,
  classify,
  composeSafety,
  ensureSafety,
  govern,
  measure,
  normalizePolicy,
  pruneToolResults,
} from "../src/index.ts";
import type { ChatMessage } from "../src/index.ts";

const policy = (overrides: Record<string, unknown> = {}) =>
  normalizePolicy({ ...DEFAULT_POLICY, ...overrides });

test("splits a request into four measurable blocks", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "fixed prefix" },
    { role: "system", content: "injected evidence" },
    { role: "user", content: "first turn" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "current input" },
  ];

  const groups = classify(messages);
  assert.deepEqual(groups.prefix, [0]);
  assert.deepEqual(groups.injection, [1]);
  assert.deepEqual(groups.session, [2, 3]);
  assert.deepEqual(groups.input, [4]);

  const report = measure(messages, 500, 10_000, policy());
  assert.equal(report.ceiling, Math.floor(10_000 * BUDGET_RATIO));
  assert.equal(report.blocks.length, 4);
  assert.equal(
    report.blocks.reduce((sum, block) => sum + block.tokens, 0),
    report.tokens,
  );
});

test("prunes old tool output while preserving the latest result", () => {
  const old = JSON.stringify({ receiptId: "r1", result: "x".repeat(3000) });
  const latest = JSON.stringify({ receiptId: "r2", result: "y".repeat(3000) });
  const messages: ChatMessage[] = [
    { role: "system", content: "prefix" },
    { role: "tool", content: old, tool_call_id: "c1" },
    { role: "tool", content: latest, tool_call_id: "c2" },
  ];

  const result = pruneToolResults(messages, 1200, 1);
  assert.equal(result.count, 1);
  assert.match(String(messages[1].content), /cleared/);
  assert.equal(messages[2].content, latest);
});

test("degrades in order: prune, compact, then rebuild safe injection", () => {
  const largeResult = JSON.stringify({
    receiptId: "r1",
    result: "process log ".repeat(1400),
  });
  const messages: ChatMessage[] = [
    { role: "system", content: "prefix" },
    { role: "system", content: "injection" },
    { role: "user", content: "build a report" },
    {
      role: "assistant",
      content: "completed: out/report.md, checksum 20260001",
    },
    { role: "user", content: "continue" },
    {
      role: "assistant",
      content: "reading",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: largeResult, tool_call_id: "c1" },
    { role: "user", content: "final turn" },
  ];
  const base = {
    workspace: "D:/workspace",
    network: false,
    skillIndex: "",
    skillBody: "",
    memory: [],
    citations: [],
    safety: { budget: 1, maxSteps: 40, maxToolCalls: 8, toolLoading: "all" as const, shell: false },
  };
  const safety = composeSafety({ agent: { role: "assistant", instructions: "" }, ...base });
  const injection = ["knowledge evidence", safety];
  const result = govern({
    messages,
    injection,
    safety,
    toolsTokens: 0,
    window: 1800,
    policy: policy({ preserveTailTurns: 1 }),
    previous: null,
    input: "final turn",
    steps: ["read_file · r1 · 12ms"],
    round: 0,
  });

  const order = result.actions.join(" | ");
  assert.match(order, /清理工具结果/);
  assert.match(order, /结构化压缩/);
  assert.ok(order.indexOf("清理工具结果") < order.indexOf("结构化压缩"));
  assert.equal(result.rejected, "");
  assert.ok(result.injection.at(-1)?.startsWith(MARK.safety));
  assert.ok(result.compaction?.probe.passed);
});

test("safety is restored after replacement injection", () => {
  const safety = `${MARK.safety}\nworkspace only`;
  const result = ensureSafety(["evidence", `${MARK.safety}\nstale`], safety);
  assert.equal(result.restored, true);
  assert.deepEqual(result.injection, ["evidence", safety]);
});

test("rejects when the current input alone cannot fit", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "prefix" },
    { role: "system", content: "injection" },
    { role: "user", content: "z".repeat(20_000) },
  ];
  const safety = `${MARK.safety}\nworkspace only`;
  const result = govern({
    messages,
    injection: [safety],
    safety,
    toolsTokens: 0,
    window: 2000,
    policy: policy(),
    previous: null,
    input: "z".repeat(20_000),
    steps: [],
    round: 0,
  });

  assert.match(result.rejected, /四区块预算超限/);
  assert.equal(result.actions.at(-1), "拒绝执行并说明原因");
});
