# Pidian SDK Host Adapter

This document describes the Pidian-specific integration kept in this repository. It does not replace the upstream documentation for billion-context's compression model, ACP kernel, tools, or Pi host contract.

## Position of the adapter

This repository remains a `billion-context-pi` package. The Pidian integration is an adapter and entry policy inside the package; it is not a second compression implementation inside the Pidian application.

```text
Pidian renderer
    → Pidian generic SDK Host
        → Pi public ExtensionAPI
            → this billion-context-pi package
                ├ upstream-compatible compression core
                └ Pidian adapter entry and SDK compatibility
```

The adapter exists because Pidian embeds the Pi SDK in a fixed, headless Node host. Pidian is not merely a Pi RPC client, but the extension still sees only the Pi SDK's public extension boundary.

## Runtime and loading

Pidian currently uses:

- fixed Node `24.14.0`;
- `@earendil-works/pi-coding-agent@1.0.0`;
- the same user-level Pi `agentDir` used by the normal Pi client;
- the Pi `DefaultResourceLoader` to discover extensions.

The package advertises the Pidian entry through its `pi.extensions` field:

```json
{
  "pi": {
    "extensions": ["./dist/pidian.js"]
  }
}
```

`src/pidian.ts` creates the normal ACP extension with the Pidian host policy:

```ts
createAcpExtension({
  autoUpdate: false,
  delegate: false,
  rules: false,
});
```

This keeps compression and context management active while leaving self-update, child-process delegation, and optional rules under the host/application policy. The entry runs inside the SDK Host. It is not loaded into the Obsidian renderer and does not create a second persistence process.

## Ownership boundary

| Responsibility | Owner |
| --- | --- |
| Native `<sessionFile>.jsonl` and Pi Session lifecycle | Pi SDK Host |
| ACP refs, compression blocks, statistics, and `<sessionFile>.jsonl.acp.json` | this extension |
| Extension discovery, SDK Host lifecycle, binding, IPC, and diagnostics | Pidian generic host |
| Message bubbles, queue state, and user controls | Pidian renderer |

The extension must use the Pi SDK public API. It must not import Pidian private modules, IPC code, Obsidian views/tabs, or write the native session JSONL itself.

The sidecar is derived extension state. It does not replace the native session log and it does not give the extension a way to persist native JSONL after the SDK Host process has died.

## Pidian compatibility surface

The current adapter work is concentrated in the normal package code rather than in a Pidian import:

- `src/pidian.ts` — Pidian-specific production entry and optional-feature policy;
- `src/index.ts` — extension factory and lifecycle registration;
- `src/messages.ts` — projection from Pi `SessionEntry` values to compression-core messages, including SDK `context_edit` replacement semantics;
- `src/runtime.ts` — per-session runtime, context transformation, and projection cache;
- `src/host.ts` and `src/compat.ts` — host/API capability detection and compatibility helpers.

The projection layer must preserve the distinction between:

1. the host's persisted session entries;
2. the host's currently visible but not-yet-persisted live tail; and
3. the extension's derived compression view.

When the SDK represents a replacement through `context_edit`, the adapter must apply that replacement before building the compression view. When the host exposes an in-flight tail, the adapter may project it for context calculation, but it must not pretend that the tail is already durable native JSONL.

## Interruption and process-death semantics

For a normal user stop, the host can emit an abort/end lifecycle event and the extension can update its projection and sidecar at the boundary it receives. This is the recoverable path.

If the SDK Host or its parent process dies before the relevant event and file flush complete, no code inside this extension can reliably write the native session JSONL afterward. In particular:

- the renderer must not become a second native-session writer;
- sidecar persistence must not be mistaken for native transcript persistence;
- a test that kills Obsidian/renderer and a test that kills the SDK Host are different failure classes;
- the adapter should make all content already exposed by the host visible at the next lifecycle boundary, but cannot promise bytes that the host never exposed or flushed.

This boundary is important when diagnosing partial streamed messages: first determine whether the native session entry exists, whether only an in-memory live tail existed, and which process died.

## Development directory and user-level extension directory

The current development deployment is transitional:

```text
C:/Users/m/Project/pidian-context-extension       ← Git worktree
        ↑
        │ junction
C:/Users/m/.pi/agent/extensions/billion-context-pi ← Pi/Pidian loader path
```

The intended simpler layout is to make the Git worktree itself:

```text
C:/Users/m/.pi/agent/extensions/billion-context-pi
```

A junction is not required by Pi or by this adapter. It is useful only when the runtime path and development worktree must be separate. Until the migration is performed and verified, do not remove the existing junction as part of an unrelated change.

## Upstream synchronization

- The maintained fork is `origin`; the original author repository is a read-only `upstream`.
- Generic Pi SDK compatibility fixes may be proposed upstream when they have a host-neutral reproduction and tests.
- Pidian-private paths, modules, UI assumptions, and closed-source application details stay in this fork.
- An upstream merge never removes the need to run the fixed-SDK Pidian loader and lifecycle tests; public SDK behavior can still differ at the adapter boundary.

Do not make the upstream project depend on Pidian merely because Pidian uses this package.

## Validation

From this repository:

```bash
npm run build
npm run typecheck
npm test
npm run verify:pidian-loader
```

The extension repository owns ACP-specific tests: context projection, `context_edit`, interrupted/partial messages, sidecar atomic writes, restart recovery, branches, and ref continuity. Pidian owns generic host tests: resource discovery, ExtensionAPI loading, binding, IPC, and host diagnostics. Pidian tests should not depend on ACP tool names or sidecar schema.

When changing this package, a running SDK Session may still hold the old loaded module. Start a new Session or let the user explicitly reload Pidian; an Agent must not reload Obsidian on its own.

## Non-goals

This adapter does not:

- implement Pi RPC or `pi_agent_rust` behavior;
- add a Pidian-specific compression engine to the renderer;
- modify the fixed Pi SDK package;
- make native JSONL durable after the SDK Host has already died.

## Related documents

- [`docs/host-adapter.md`](./host-adapter.md) — generic multi-session host contract;
- [`README.md`](../README.md) — compression behavior and user-facing setup;
- Pidian-side design: `Pidian/docs/design/pi-sdk/target-context-extension.md` in the Pidian repository.
