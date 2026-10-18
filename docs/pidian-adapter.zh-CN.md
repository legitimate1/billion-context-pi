# Pidian SDK Host 适配层

本文只说明本仓库中的 Pidian 专用集成，不替代上游关于 billion-context 压缩模型、ACP 内核、工具或 Pi 宿主契约的文档。

## 适配层的位置

本仓库仍然是 `billion-context-pi` 包。Pidian 集成是包内部的适配层和入口策略，不是在 Pidian 应用中重新实现一套压缩能力。

```text
Pidian renderer
    → Pidian 通用 SDK Host
        → Pi 公共 ExtensionAPI
            → 本 billion-context-pi 包
                ├ 上游兼容的压缩核心
                └ Pidian 适配入口和 SDK 兼容逻辑
```

之所以需要适配层，是因为 Pidian 在固定的 headless Node Host 中嵌入 Pi SDK。Pidian 不只是一个 Pi RPC 客户端，但扩展仍然只能看到 Pi SDK 的公共扩展边界。

## 运行和加载

Pidian 当前使用：

- 固定 Node `24.14.0`；
- `@earendil-works/pi-coding-agent@1.0.0`；
- 与普通 Pi 客户端相同的用户级 Pi `agentDir`；
- Pi 的 `DefaultResourceLoader` 发现扩展。

包通过 `pi.extensions` 字段声明 Pidian 入口：

```json
{
  "pi": {
    "extensions": ["./dist/pidian.js"]
  }
}
```

`src/pidian.ts` 使用 Pidian 宿主策略创建普通 ACP 扩展：

```ts
createAcpExtension({
  autoUpdate: false,
  delegate: false,
  rules: false,
});
```

这样保留压缩和上下文管理，同时把自更新、子进程委派和可选 rules 留给宿主/应用策略处理。入口运行在 SDK Host 内，不加载到 Obsidian renderer，也不会创建第二个持久化进程。

## 所有权边界

| 职责 | 所有者 |
| --- | --- |
| 原生 `<sessionFile>.jsonl` 和 Pi Session 生命周期 | Pi SDK Host |
| ACP refs、压缩块、统计和 `<sessionFile>.jsonl.acp.json` | 本扩展 |
| 扩展发现、SDK Host 生命周期、binding、IPC 和诊断 | Pidian 通用 Host |
| 消息气泡、队列状态和用户操作 | Pidian renderer |

扩展必须使用 Pi SDK 公共 API。不得导入 Pidian 私有模块、IPC、Obsidian View/Tab，也不得自己写原生 session JSONL。

sidecar 是扩展派生状态，不替代原生 session log，也不能让扩展在 SDK Host 进程已经死亡后继续写入原生 JSONL。

## Pidian 兼容面

当前适配工作集中在包自身的普通源码中，而不是导入 Pidian：

- `src/pidian.ts`：Pidian 专用生产入口和可选能力策略；
- `src/index.ts`：扩展工厂和生命周期注册；
- `src/messages.ts`：Pi `SessionEntry` 到压缩核心消息的投影，包括 SDK `context_edit` replacement 语义；
- `src/runtime.ts`：按 session 隔离的运行时、context 变换和投影缓存；
- `src/host.ts`、`src/compat.ts`：宿主/API 能力检测和兼容辅助。

投影层必须区分：

1. 宿主已经持久化的 session entry；
2. 宿主当前可见但尚未持久化的 live tail；
3. 扩展派生的压缩视图。

当 SDK 通过 `context_edit` 表示替换时，适配层必须在构建压缩视图前应用 replacement。当宿主暴露正在生成的 tail 时，适配层可以用于 context 计算，但不能把它假定为已经持久化的原生 JSONL。

## 中断与进程死亡语义

正常点击停止时，宿主可能发出 abort/end 生命周期事件；扩展可以在收到的边界更新投影和 sidecar。这是可恢复路径。

如果 SDK Host 或其父进程在相关事件和文件 flush 完成前死亡，本扩展内部没有任何代码可以可靠地在事后写入原生 session JSONL。尤其要遵守：

- renderer 不能变成第二个原生 session writer；
- sidecar 持久化不能被误认为原生 transcript 持久化；
- 关闭 Obsidian/renderer 与结束 SDK Host 是两类不同的失败场景；
- 适配层应在下一次收到生命周期边界时显示宿主已经暴露的内容，但不能承诺宿主从未暴露或 flush 的字节。

排查流式消息缺失时，先确认原生 session entry 是否存在、内容是否只存在于内存 live tail，以及到底是哪一个进程死亡。

## 开发目录与用户级扩展目录

当前开发部署是过渡状态：

```text
C:/Users/m/Project/pidian-context-extension       ← Git 工作树
        ↑
        │ junction
C:/Users/m/.pi/agent/extensions/billion-context-pi ← Pi/Pidian loader 路径
```

已确定的简化目标是让 Git 工作树本身位于：

```text
C:/Users/m/.pi/agent/extensions/billion-context-pi
```

junction 不是 Pi 或本适配层的必要条件。只有运行路径和开发工作树必须分离时，junction 才有价值。在迁移完成并验证前，不要把删除现有 junction 混入无关修改。

## 上游同步

- 自维护 fork 是 `origin`；原作者仓库是只读 `upstream`。
- 有宿主无关复现和测试的通用 Pi SDK 兼容修复，可以整理后向上游提交。
- Pidian 私有路径、模块、UI 假设和闭源应用细节留在本 fork。
- 上游合并某个修复后，仍必须运行固定 SDK 的 Pidian loader 和生命周期测试；公共 SDK 行为仍可能在适配边界发生差异。

不要因为 Pidian 使用本包，就让上游项目依赖 Pidian。

## 验证

在本仓库运行：

```bash
npm run build
npm run typecheck
npm test
npm run verify:pidian-loader
```

扩展仓库负责 ACP 特有测试：context 投影、`context_edit`、中断/部分消息、sidecar 原子写入、重启恢复、分支和 ref 延续。Pidian 负责通用宿主测试：资源发现、ExtensionAPI 加载、binding、IPC 和 Host 诊断。Pidian 测试不应依赖 ACP 工具名或 sidecar schema。

修改本包后，已经运行的 SDK Session 可能仍然持有旧模块。应创建新 Session，或由用户明确重载 Pidian；Agent 不得自行重载 Obsidian。

## 非目标

本适配层不负责：

- 实现 Pi RPC 或 `pi_agent_rust` 行为；
- 在 renderer 中增加 Pidian 专用压缩引擎；
- 修改固定 Pi SDK 包；
- 在 SDK Host 已经死亡后让原生 JSONL 继续可靠持久化。

## 相关文档

- [`docs/host-adapter.md`](./host-adapter.md) — 通用多 Session 宿主契约；
- [`README.zh-CN.md`](../README.zh-CN.md) — 压缩行为和用户侧配置；
- Pidian 侧设计：Pidian 仓库中的 `docs/design/pi-sdk/target-context-extension.md`。
