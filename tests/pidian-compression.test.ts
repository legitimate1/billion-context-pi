import assert from "node:assert/strict";
import test from "node:test";
import { createAcpExtension } from "../src/index.js";

function captureApi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let provider: any;
  const api = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
    registerPidianSessionCompressionProvider(value: any) {
      provider = value;
      return () => {};
    },
  };
  return { api, handlers, getProvider: () => provider };
}

function context() {
  return {
    mode: "rpc",
    hasUI: false,
    cwd: "/tmp",
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    sessionManager: {
      buildContextEntries: () => [],
      getSessionId: () => "compression-provider-test",
      getSessionFile: () => undefined,
    },
  };
}

test("Pidian compression provider forwards phases and structured engine results", async () => {
  const { api, getProvider } = captureApi();
  createAcpExtension()(api as any);
  const provider = getProvider();
  assert.ok(provider, "the extension must register a Pidian compression provider");
  assert.equal(provider.providerId, "billion-context-pi");
  assert.equal(provider.apiVersion, 1);

  const phases: string[] = [];
  const reports: any[] = [];
  const result = await provider.run({
    args: { content: [] },
    context: context(),
    reportPhase: (phase: string) => phases.push(phase),
    reportResult: (report: unknown) => reports.push(report),
  });

  assert.deepEqual(result, { text: "No ranges provided." });
  assert.deepEqual(phases, ["prepare"]);
  assert.deepEqual(reports, [{ noop: true }]);
});
