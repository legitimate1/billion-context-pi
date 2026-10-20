import assert from "node:assert/strict";
import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function context(
  entries: unknown[] = [],
  sessionFile?: string,
  sessionId = "compression-provider-test",
  cwd = "/tmp",
) {
  return {
    mode: "rpc",
    hasUI: false,
    cwd,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  };
}

function historicalEntries() {
  return Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    id: `native-${index + 1}`,
    parentId: null,
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Historical turn ${index + 1}: preserve the decision, file path, and failure boundary across a fresh runtime. ${"中".repeat(6000)}`,
      timestamp: 1_700_000_000_000 + index * 1_000,
    },
  }));
}

function compressionArgs(startId: string, endId: string) {
  return {
    content: [{
      startId,
      endId,
      summary: "Historical compression summary preserves the decision, file path, and failure boundary across reload.",
    }],
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

test("real compression sidecar survives a fresh runtime loading historical entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "bcp-pidian-sidecar-reload-"));
  const sessionFile = join(root, "historical.session.jsonl");
  const sessionId = "historical-sidecar-reload";
  const entries = historicalEntries();

  try {
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }),
        ...entries.map((entry) => JSON.stringify(entry)),
        "",
      ].join("\n"),
      "utf8",
    );

    const firstCapture = captureApi();
    createAcpExtension({ preserveRecentMessages: 1 })(firstCapture.api as any);
    const firstProvider = firstCapture.getProvider();
    assert.ok(firstProvider);
    const firstPhases: string[] = [];
    const firstReports: any[] = [];
    const firstResult = await firstProvider.run({
      args: compressionArgs("m00001", "m00004"),
      context: context(entries, sessionFile, sessionId, root),
      toolCallId: "historical-compress-1",
      reportPhase: (phase: string) => firstPhases.push(phase),
      reportResult: (report: unknown) => firstReports.push(report),
    });

    assert.match(firstResult.text, /▣ ACP \|/);
    assert.deepEqual(firstPhases, [
      "prepare",
      "load-state",
      "process-turn",
      "apply-compression",
      "persist",
      "finalize",
    ]);
    assert.equal(firstReports.at(-1)?.noop, false, JSON.stringify({ text: firstResult.text, reports: firstReports }));

    const firstSidecar = JSON.parse(await readFile(`${sessionFile}.acp.json`, "utf8")) as {
      schemaVersion: number;
      blocks: Array<{ blockId: string; effectiveMessageIds: string[] }>;
    };
    assert.equal(firstSidecar.schemaVersion, 1);
    assert.equal(firstSidecar.blocks.length, 1);
    assert.equal(firstSidecar.blocks[0]?.blockId, "b1");
    assert.deepEqual(firstSidecar.blocks[0]?.effectiveMessageIds, [
      "native-1",
      "native-2",
      "native-3",
      "native-4",
    ]);

    // A new extension factory creates a new AcpRuntime and SessionStateStore;
    // this is the boundary that an in-process cache-only test would miss.
    const secondCapture = captureApi();
    createAcpExtension({ preserveRecentMessages: 1 })(secondCapture.api as any);
    const secondProvider = secondCapture.getProvider();
    assert.ok(secondProvider);
    const duplicate = await secondProvider.run({
      args: compressionArgs("m00001", "m00004"),
      context: context(entries, sessionFile, sessionId, root),
      toolCallId: "historical-compress-duplicate",
    });
    assert.match(duplicate.text, /already compressed|covered|Errors:/i);

    const afterDuplicate = JSON.parse(await readFile(`${sessionFile}.acp.json`, "utf8")) as {
      blocks: Array<{ blockId: string }>;
    };
    assert.deepEqual(afterDuplicate.blocks.map((block) => block.blockId), ["b1"]);

    const secondResult = await secondProvider.run({
      args: compressionArgs("m00005", "m00008"),
      context: context(entries, sessionFile, sessionId, root),
      toolCallId: "historical-compress-2",
    });
    assert.match(secondResult.text, /▣ ACP \|/);

    const finalSidecar = JSON.parse(await readFile(`${sessionFile}.acp.json`, "utf8")) as {
      blocks: Array<{ blockId: string; effectiveMessageIds: string[] }>;
    };
    assert.deepEqual(finalSidecar.blocks.map((block) => block.blockId), ["b1", "b2"]);
    assert.deepEqual(finalSidecar.blocks[1]?.effectiveMessageIds, [
      "native-5",
      "native-6",
      "native-7",
      "native-8",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
