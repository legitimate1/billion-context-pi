import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  readPidianFeatureObservation,
  registerPidianFeatureObservationProvider,
} from "../src/pidian-observation.js";

function context(entries: SessionEntry[]): ExtensionContext {
  const sessionManager = {
    getSessionId: () => "session-1",
    getLeafId: () => "leaf-2",
    buildContextEntries: () => entries,
  };
  return {
    sessionManager,
    model: { input: ["text"] },
  } as unknown as ExtensionContext;
}

function message(id: string, role: "user" | "assistant", content: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content } as never,
  } as SessionEntry;
}

test("task-effective observation counts the active branch source messages once", () => {
  const entries: SessionEntry[] = [
    message("u1", "user", "first task message"),
    message("a1", "assistant", [
      { type: "toolCall", name: "compress", id: "call-1", arguments: { content: "range" } },
    ]),
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "compress",
        content: "compressed summary",
      } as never,
    } as SessionEntry,
    message("u2", "user", "second task message"),
    {
      type: "compaction",
      id: "native-compaction",
      parentId: "u2",
      timestamp: new Date().toISOString(),
      summary: "native summary is not a source message",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    } as SessionEntry,
  ];

  const observation = readPidianFeatureObservation(
    context(entries),
    { refused: false } as never,
    { featureId: "context-usage", capabilityId: "task-effective-tokens" },
  );

  assert.equal(observation.status, "available");
  assert.deepEqual(observation.scope, {
    kind: "branch",
    sessionId: "session-1",
    activeLeafId: "leaf-2",
  });
  assert.equal(observation.value?.messageCount, 2);
  assert.equal(observation.value?.semantics, "branch-cumulative-distinct-source-messages");
  assert.ok((observation.value?.tokens ?? 0) > 0);
  assert.equal(observation.sequence, entries.length);
});

test("task-effective observation reports stand-down as unsupported", () => {
  const observation = readPidianFeatureObservation(
    context([]),
    { refused: true } as never,
    { featureId: "context-usage", capabilityId: "task-effective-tokens" },
  );
  assert.equal(observation.status, "unsupported");
  assert.equal(observation.value, null);
});

test("registers through the shared Pi event bus when direct injection is absent", () => {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
    on(event: string, handler: (value: unknown, ctx: ExtensionContext) => void) {
      lifecycle.set(event, handler);
      return () => lifecycle.delete(event);
    },
  } as unknown as ExtensionAPI;

  registerPidianFeatureObservationProvider(pi, { refused: false } as never);
  const ctx = context([]);
  lifecycle.get("session_start")?.({}, ctx);

  const registration = emitted[0];
  assert.equal(registration?.channel, "pidian.feature-observation-provider");
  assert.equal((registration?.data as { type: string }).type, "register");
  assert.equal(
    (registration?.data as { provider: { providerId: string } }).provider.providerId,
    "billion-context-pi",
  );

  lifecycle.get("session_shutdown")?.({}, ctx);
  const unregistration = emitted[1];
  assert.equal(unregistration?.channel, "pidian.feature-observation-provider");
  assert.equal((unregistration?.data as { type: string }).type, "unregister");
});
