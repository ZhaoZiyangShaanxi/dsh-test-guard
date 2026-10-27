# dsh-test-guard 项目评估（2026-10-27）

## 结论

当前项目是可构建、可测试的 **Host 侧审查原型**，适合继续验证审查与覆盖率算法。它还不是可在 DSH Web GUI 中直接启用的完整六模块产品：前端需要独立 Client 入口、Host/Client 通信和 DSH Slot 注册；质量门禁还没有接入真实提交或 CI 流程。不要把 `gateCheck().allowed` 误认为已经安装了 Git 拦截器。

## 六模块现状

| 模块 | 已验证能力 | 当前边界 |
| --- | --- | --- |
| 智能路由 | 任务标签、优先级和延迟排序、三次失败熔断、60 秒巡检、`/models` 不支持时最小 chat 探测 | 只路由调用该服务的请求；`chat` 标签不会自动接管 DSH 全局聊天。配置变更依赖 Cordis 重新装载插件，尚无原地更新 API。 |
| 测试感知上下文 | 分段评分、保留断言与堆栈、低覆盖行提权、超限裁剪 | token 数是估算值；缺少 tokenizer 校验和真实长会话回放。 |
| 代码审查 | Git/IDE Diff 降级、结构化变更、静态 Import/Require 影响分析、缺测与无断言提示、JSON 校验 | 影响图不解析 tsconfig 路径别名和动态导入；“断言有效性”是静态提示，不能证明断言能捕获缺陷。 |
| 覆盖率与门禁 | Istanbul JSON 的行/分支命中映射、阻断/警告/通过结果 | 不生成报告，不检查报告是否对应当前代码版本；没有 pre-commit 或 CI 执行入口，也未解析 lcov。 |
| ReviewPanel | 问题卡片、评级、编辑器桥接接口、`test-gen`、Diff 与确认写入 | 组件没有注册到 DSH Client Slot；仓库没有具体 IDE 适配器，Host 事件也未跨进程转发。 |
| 测试 | 路由、压缩、审查、覆盖率和面板交互的 Vitest 测试 | 面板测试使用轻量 DOM 替身，尚无真实 DSH Web/IDE 端到端测试。 |

模型返回不可恢复的 JSON 时，审查会报错。这里**有意不返回空结果**：空结果可能使质量门禁错误放行。

## 优先改进顺序

1. **完成 DSH Client 接线。** 按 DSH 官方 Host → Remote → Client model → UI Slot 流程，拆分浏览器入口，在 `ctx.slots.register()` 中注册面板，并把审查事件和生成请求接到 Host。为目标编辑器实现 `ReviewPanelIde`，再做一次真实 Web GUI 冒烟测试。DSH 的原生 Web 组合机制是 Slots；第三方 `deepseek-harness-genui` 不等于 DSH 核心渲染引擎。
2. **让门禁实际执行。** 增加 CI 或 pre-commit 命令：生成最新覆盖率、运行审查、调用 `gateCheck()`，阻断时以非零退出码结束。检查覆盖率报告的生成时间或代码版本，避免旧报告误判。AI 生成测试在写入前应编译或运行，至少在确认后执行 Vitest。
3. **提高回归选择准确率。** 现有静态引用图保留为快速提示；对 Vitest 项目增加 `vitest related --run` 作为执行级验证，并处理路径别名、动态导入与测试文件重命名。
4. **补工程化评测。** 构建带预期受影响测试、严重问题及未覆盖行的固定样本集，分别统计误报、漏报、路由降级成功率和压缩后关键证据保留率。明确全局覆盖率与变更行覆盖率两个阈值，避免全局高覆盖掩盖新增分支盲区。

## 参考依据

- [DSH Web Client 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md)：Host/Client 分层与 UI 数据路径。
- [DSH Web Client Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)：原生 Slot 注册方式。
- [Istanbul FileCoverage](https://github.com/istanbuljs/istanbuljs/blob/main/packages/istanbul-lib-coverage/lib/file-coverage.js)：行覆盖率由语句位置和命中次数计算。
- [Vitest CLI](https://github.com/vitest-dev/vitest/blob/main/docs/guide/cli.md)：`vitest related` 的静态导入范围与使用方式。
- [Vitest coverage 配置](https://vitest.dev/config/coverage)：JSON 报告器与覆盖率阈值。
- [第三方 GenUI 插件目录](https://dsharness.org/zh/plugin/pengyue-polaron/deepseek-harness-genui)：说明它是独立插件，不能替代原生 Slot 接线。
