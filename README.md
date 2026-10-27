# dsh-test-guard

面向测试开发工程师的 DeepSeek Harness（DSH）Cordis 插件。智能路由、测试感知上下文管理、代码审查和审查质量门禁已实现；测试生成目前仍是 TypeScript 契约。

> 当前为 0.1.0 预览版：Host 服务可挂载并通过单元测试。审查面板尚未接入 DSH Web Client Slot，也没有 Git hook/CI 提交拦截器；`gateCheck()` 仅返回可由宿主执行的判断。请勿把 UI 演示组件当作已集成的 DSH 界面。

## 安装与验证

要求 Node.js 20+ 和 DSH。公开仓库可按 [DSH 官方插件发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)从源码安装：

```bash
dsh plugin --profile headless add github:ZhaoZiyangShaanxi/dsh-test-guard
dsh --profile headless --dump-config
```

源码依赖 `prepare` 编译 TypeScript；如果 pnpm 拒绝运行构建脚本，请把错误信息中打印的**完整包键**复制到对应 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`（GitHub 安装时包键通常包含 tarball URL 和提交 SHA），再重新安装。也可以在本仓库执行 `npm ci && npm pack`，用生成的 `.tgz` 执行 `dsh plugin --profile headless add ./dsh-test-guard-0.1.0.tgz`。npm 发布后可直接 `dsh plugin --profile headless add dsh-test-guard`。

安装仅挂载服务，不会自动发出 LLM 请求。编辑 profile 的插件配置，为 `providers` 添加自己的 OpenAI 兼容 endpoint、模型和任务标签，例如 `review` 使用强模型，`test-gen` 使用快模型。当前补丁的 `providers: []` 是安全的空配置；空配置下调用审查会明确失败。密钥应通过部署环境的配置注入，不要提交到 Git。

## 目录

```text
src/
  index.ts             Cordis 插件入口，注册 ctx.smartRoute / ctx.testAwareContext / ctx.codeReview
  config.ts            运行时配置 schema
  types/               闭环共享数据类型
  router/              智能路由接口与状态类型
  services/smart-route.ts  智能路由实现
  services/test-aware-context.ts  测试感知上下文压缩实现
  services/code-review.ts  测试感知代码审查实现
  context/             测试感知上下文接口
  review/              代码审查接口
  frontend/gate-status.ts  前端提交按钮和状态面板适配器
  frontend/components/ReviewPanel.ts  审查结果面板与测试生成交互
  generator/           测试用例生成接口
__tests__/smart-route.test.ts  路由单元测试
__tests__/test-aware-context.test.ts  上下文压缩单元测试
__tests__/code-review.test.ts  代码审查单元测试
__tests__/review-panel.test.ts  面板交互单元测试
```

`cordis.patch.yml` 将编译后的包入口挂载到 DSH profile。`package.json` 中的 `dsh.bundle` 使 DSH 能识别该配置层。

## 开发

```bash
npm install
npm run typecheck
npm run build
npm test
```

## 智能路由

插件启动时注册 `ctx.smartRoute`。其他模块应只调用 `ctx.smartRoute.routeAndExecute(taskType, requestParams)` 发起 LLM 请求。路由先过滤 `enabled`、健康状态和 `taskTypes`，再按较小的 `priority` 值与最近十次的平均延迟选择 provider。失败会尝试下一个候选；连续三次失败后熔断。每 60 秒发起一次 GET 健康检查，成功后解除熔断。状态和平均/P95 延迟可通过 `getProviderState()`、`getProviderMetrics()` 读取。

为 `review`、`complex-logic` 配置强模型的任务标签；为 `test-gen`、`test-generation`、`text-formatting` 配置快模型；为 `context-analysis`、`summarization` 配置中等模型。`chat` 标签也可独立配置，但不会自动接管 DSH 的全局聊天请求。审查面板的生成按钮使用 `test-gen`。优先级只在同一任务的候选 provider 间比较。`endpoint` 应是完整的 OpenAI 兼容 chat completions URL；默认传输使用 POST JSON。默认 ping 先将 `/chat/completions` 改为 `/models`；该端点返回 404、405 或 501 时，再发送一次最多生成 1 token 的 chat 请求。其他 API 可配置 `healthCheckEndpoint` 或注入自定义 transport。

配置 `providers` 时，API Key 应从部署环境注入，勿提交明文凭据。当前 `cordis.patch.yml` 的空 provider 列表只用于挂载插件；发起请求前必须配置至少一个支持相应任务的 provider。

## 测试感知上下文管理

调用 `ctx.testAwareContext.compressContext(messages, maxTokens)` 压缩文本消息。模块按约 4 个 ASCII 字符或 1 个非 ASCII 字符估算一个 token，并为每条消息计入固定开销。测试代码、断言、错误堆栈、测试输出及当前编辑或选中的文件内容得分 100，绝不裁剪；源码和配置文件为高优先级，近期修改的文件优先于普通源码；重复工具结果、长注释文档、闲聊和未调用的辅助定义优先删除。

超限时按低分到高分处理。超过 4000 字符的非保护片段先保留头部 2000 字符和尾部 1000 字符，再按需删除。测试代码与普通文本混在同一条消息时也会分别处理。若仅受保护内容就超过 `maxTokens`，结果允许超出预算。`updateCoverageData()` 接收已解析的行覆盖率报告，提升含未覆盖行源码的优先级；带 `lineNumber` 的未覆盖片段按 100 分保留。门槛使用配置项 `lowCoverageThreshold`。

## 测试感知代码审查

调用 `ctx.codeReview.getCurrentCodeChanges()` 取得带 `isTestFile` 标记的结构化变更，再把结果传给 `ctx.codeReview.review(changes)`。Git 可用时读取相对 `HEAD` 的暂存区和工作区变更，并包含未跟踪文件；Git 不可用或 Diff 读取失败时记录警告并调用宿主提供的 `ctx.testGuardIdeChanges` 服务，其 `getRecentFileDiffs()` 返回文件路径、修改前后内容和 unified diff。没有可用变更源时会明确报错。

审查请求以 `review` 任务类型经 `ctx.smartRoute` 发出。Prompt 覆盖安全、性能、逻辑质量、缺测、回归影响、弱断言和新增测试的断言检查。服务会根据相对 `import`/`require` 关系补全受影响测试；新增测试文件完全没有 `expect/assert` 时会给出 `WEAK_ASSERTION` 警告。模型结果先尝试提取 JSON 对象，再校验字段，以 `summary`、`issues`、`affectedTests` 返回。无法修复的模型结果会报错，避免将失败审查误判为“0 个问题”。

先调用 `await ctx.codeReview.loadCoverageReport('coverage/coverage-final.json')` 加载 Istanbul JSON 报告，再调用 `review(changes)`。解析器按语句起始行及命中次数计算行覆盖率，并识别未执行的分支。新增行执行次数为 0 或分支未执行时，审查结果附加带文件和行号的 `MISSING_COVERAGE` 问题；即使有测试文件引用该源码，也不会据此假定新增代码已覆盖。报告未包含变更文件时会提示无法确认覆盖。覆盖率报告应在本次代码变更后重新生成。

`ctx.codeReview.gateCheck(result)` 返回可序列化的 `status`、`allowed`、覆盖率和阻断问题。严重问题位于未覆盖或无法确认覆盖的行、覆盖率报告缺失、或整体行覆盖率低于 `minLineCoverage` 时拦截；仅有警告时返回警告；覆盖率达标且无严重或警告问题时放行。严重问题所在行已覆盖时返回需人工确认的警告。前端可调用 `applyGateToControls(gate, { submitButton, statusText })` 更新提交按钮与状态文本，或使用 `toGateViewModel(gate)` 接入自己的 UI 框架。

审查只接受 TypeScript/JavaScript 源码与测试文件。Git/IDE 变更获取器跳过 `.env` 等非代码文件，防止把其内容送到远程模型。门禁会检查报告覆盖的源码修改时间；源码比报告新时阻断并要求重新生成覆盖率。时间检查无法证明报告与当前提交完全一致，CI 接入时仍应在同一任务内先运行测试、再生成报告、最后执行门禁。

## 审查面板

前端宿主挂载 `new ReviewPanel({ codeReview: ctx.codeReview, smartRoute: ctx.smartRoute, testAwareContext: ctx.testAwareContext }, container, ide)`。面板订阅 `codeReview.onReviewed()`，因此挂载后任意 `review(changes)` 完成都会显示摘要、门禁评级和问题卡片。`ide` 实现 `ReviewPanelIde`：打开文件、突出显示行、在编辑器行号槽标记水滴、读取/写入测试文件。重新审查或卸载时会清理旧标记；卸载调用 `panel.dispose()`。

缺测和弱断言卡片上的生成按钮会提取问题附近代码及现有测试，经上下文管理器压缩后调用 `smartRoute.routeAndExecute('test-gen', ...)`。面板先显示替换 Diff；“手动编辑”可改生成代码，“确认替换”才会调用 IDE 的 `writeTestFile()`。本仓库尚无 DSH Web Client Slot 或具体编辑器实现，因此实际应用需将该组件挂入宿主 Client Slot，并提供 `ReviewPanelIde` 适配器；Host 与 Client 分进程时还需把审查完成事件经宿主通信层转发到 Client。

## 参与协作

欢迎通过 [GitHub Issues](https://github.com/ZhaoZiyangShaanxi/dsh-test-guard/issues) 报告问题或提出改进，并通过 Pull Request 提交修复。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。本项目采用 MIT 许可证。
