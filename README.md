# Nexcore Context Governor

### 长任务不是“窗口不够大”。  
### 真正的问题是：超限时，谁决定先丢什么？

[![test](https://github.com/yan-stone-computer/nexcore-context-governor/actions/workflows/test.yml/badge.svg)](https://github.com/yan-stone-computer/nexcore-context-governor/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0ea5a6.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-2563eb.svg)](package.json)

![Four-block context governance](docs/context-governor.svg)

大多数 Agent 在上下文超限时直接截断。这个库会先预算、再降级、再核对关键事实，
最后在请求不可能成功时明确拒绝执行。

Nexcore Context Governor 是从
[NexcoreWork](https://github.com/yan-stone-computer/nexcorework-site) 抽出的
provider-independent TypeScript 核心，不依赖模型 SDK。

## 它和“自动摘要”有什么不同

| 常见做法 | Nexcore Context Governor |
|---|---|
| 按轮次截断 | 四区块分别计量 |
| 一次大摘要覆盖历史 | 固定顺序治理，可解释 |
| 摘要是否丢事实碰运气 | 结构化保留清单与探针核对 |
| 安全约束可能被裁掉 | 压缩后由系统重新注入末尾 |
| 当前输入放不下也硬发 | 明确拒绝并报告各区块占用 |
| 原文被摘要替代 | 只从当前视图移出，可按引用回读 |

## 治理顺序

```text
固定前缀 / 注入层 / 会话历史 / 当前输入
                  ↓
             分区计量
                  ↓
    清理旧工具结果和超大参数
                  ↓
      结构化压缩较早会话
                  ↓
       关键事实探针核对
                  ↓
       重建末尾安全约束
                  ↓
     缩减低优先级注入
                  ↓
   仍超限则拒绝执行并说明原因
```

治理顺序是确定的，不交给模型“自由发挥”。

## 30 秒验证

```bash
git clone https://github.com/yan-stone-computer/nexcore-context-governor.git
cd nexcore-context-governor
npm install
npm run check
```

5 项测试覆盖四区块计量、工具结果清理、固定降级顺序、安全约束回注和超限拒绝。

## 最小用法

```ts
import {
  DEFAULT_POLICY,
  govern,
  normalizePolicy,
} from "nexcore-context-governor";

const result = govern({
  messages,
  injection: ["retrieved evidence", safety],
  safety,
  toolsTokens: 1200,
  window: 65_536,
  policy: normalizePolicy(DEFAULT_POLICY),
  previous: null,
  input: latestUserInput,
  steps: toolStepSummaries,
  round: 0,
});

if (result.rejected) {
  return { error: result.rejected, report: result.report };
}
```

## 可观测输出

每次治理都会返回：

- 四个区块的 token 占用与下钻条目；
- 硬预算、溢出量和采用过的动作；
- 清理了多少工具结果、释放多少 token；
- 结构化保留清单和探针是否通过；
- 当前安全约束是否仍在最后；
- 拒绝时每个区块具体占了多少。

这让上下文治理能进入测试、轨迹和用户界面，而不是藏在框架内部。

## 设计边界

- token 数是确定性估算，不冒充供应商账单。
- 压缩是规则驱动，不调用另一个模型写摘要。
- 原文持久化、回执读取和最终模型适配由宿主负责。
- 当前分类器面向常见 `system/user/assistant/tool` 消息格式。

如果你的 Agent 曾经“摘要完就把关键路径弄丢了”，欢迎把最小复发案例发到 Issue。

## 与开放栈组合

- [NexcoreMemory](https://github.com/yan-stone-computer/NexcoreMemory)
- [NexcoreFileRead](https://github.com/yan-stone-computer/NexcoreFileRead)
- [NexcoreVision](https://github.com/yan-stone-computer/NexcoreVision)
- [NexcoreToolGuard](https://github.com/yan-stone-computer/NexcoreToolGuard)
- [NexcoreAgent](https://github.com/yan-stone-computer/NexcoreAgent)

## License

MIT
