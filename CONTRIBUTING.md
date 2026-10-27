# 参与 dsh-test-guard

欢迎提交 Issue 与 Pull Request。请在 Issue 中写清 DSH/Node 版本、复现步骤、预期与实际结果；涉及密钥或私有代码时请先脱敏。

开发前运行 `npm ci`。提交 PR 前运行 `npm run typecheck`、`npm test` 和 `npm pack --dry-run`，并描述变更、测试结果及兼容性影响。修复非平凡逻辑时附一条能复现问题的测试。

当前重点是 DSH Web Client Slot 接线、真实提交门禁和测试生成落地。请在 PR 中明确哪些能力已实现、哪些仍需宿主适配，避免把接口契约描述为可直接使用的功能。

项目采用 [MIT 许可证](./LICENSE)。参与者提交代码即同意以该许可证分发其贡献；请确认你有权提交相关代码与素材。
