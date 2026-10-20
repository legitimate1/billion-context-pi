import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CoreMessage } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import { collectImageTokens, estimateTokens, modelSupportsImages } from "./tokens.js";
import { readContextEntries, type AcpRuntime } from "./runtime.js";

const FEATURE_OBSERVATION_SCHEMA_VERSION = 1 as const;
const PROVIDER_ID = "billion-context-pi";
const FEATURE_ID = "context-usage";
const CAPABILITY_ID = "task-effective-tokens";
const PIDIAN_FEATURE_OBSERVATION_EVENT = "pidian.feature-observation-provider";

interface FeatureObservationQuery {
  featureId?: string;
  capabilityId?: string | null;
}

interface FeatureObservationSnapshot {
  schemaVersion: typeof FEATURE_OBSERVATION_SCHEMA_VERSION;
  featureId: string;
  capabilityId: string | null;
  scope: {
    kind: "branch";
    sessionId: string;
    activeLeafId: string | null;
  };
  source: {
    componentKind: "pi-extension";
    componentId: string;
  };
  status: "available" | "unsupported" | "unavailable" | "stale" | "error";
  sequence: number | null;
  observedAt: string;
  value: {
    tokens: number;
    messageCount: number;
    semantics: "branch-cumulative-distinct-source-messages";
  } | null;
  checkpoints: Record<string, unknown>;
  warnings: string[];
  redactions: string[];
  truncated: boolean;
}

interface FeatureObservationProvider {
  apiVersion: 1;
  providerId: string;
  read(query: FeatureObservationQuery): FeatureObservationSnapshot;
}

interface PidianObservationExtensionApi {
  registerPidianFeatureObservationProvider?: (
    provider: FeatureObservationProvider,
  ) => () => void;
  events?: {
    emit(channel: string, data: unknown): void;
  };
}

export function registerPidianFeatureObservationProvider(
  pi: ExtensionAPI,
  runtime: AcpRuntime,
): void {
  const api = pi as ExtensionAPI & PidianObservationExtensionApi;
  let activeContext: ExtensionContext | null = null;
  let eventProviderRegistered = false;
  const provider: FeatureObservationProvider = {
    apiVersion: 1,
    providerId: PROVIDER_ID,
    read: (query) => readPidianFeatureObservation(activeContext, runtime, query),
  };
  if (typeof api.registerPidianFeatureObservationProvider === "function") {
    api.registerPidianFeatureObservationProvider(provider);
  } else if (typeof api.events?.emit === "function") {
    // Pi creates one ExtensionAPI per extension. Register on session_start so
    // the host has finished loading its own factory and has subscribed to the
    // shared public event bus channel.
  } else {
    return;
  }

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    if (typeof api.registerPidianFeatureObservationProvider !== "function") {
      api.events?.emit(PIDIAN_FEATURE_OBSERVATION_EVENT, {
        type: "register",
        provider,
      });
      eventProviderRegistered = true;
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (activeContext?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()) {
      if (eventProviderRegistered) {
        api.events?.emit(PIDIAN_FEATURE_OBSERVATION_EVENT, {
          type: "unregister",
          providerId: PROVIDER_ID,
          provider,
        });
        eventProviderRegistered = false;
      }
      activeContext = null;
    }
  });
}

export function readPidianFeatureObservation(
  ctx: ExtensionContext | null,
  runtime: AcpRuntime,
  query: FeatureObservationQuery,
): FeatureObservationSnapshot {
  const observedAt = new Date().toISOString();
  const sessionId = ctx?.sessionManager.getSessionId() ?? "unknown-session";
  const activeLeafId = ctx?.sessionManager.getLeafId() ?? null;
  const scope = { kind: "branch" as const, sessionId, activeLeafId };
  if (query.featureId && query.featureId !== FEATURE_ID) {
    return unavailableObservation(scope, observedAt, "feature query is outside provider scope");
  }
  if (query.capabilityId !== undefined && query.capabilityId !== CAPABILITY_ID) {
    return unavailableObservation(scope, observedAt, "capability query is outside provider scope");
  }
  if (!ctx) return unavailableObservation(scope, observedAt, "session context is not ready");
  if (runtime.refused) return unsupportedObservation(scope, observedAt);

  const entries = readContextEntries(ctx.sessionManager);
  const projected = uniqueMessages(entriesToCoreMessages(entries));
  const imageTokens = collectImageTokens(entries, modelSupportsImages(ctx.model));
  const tokens = estimateTokens(projected, undefined, imageTokens);
  return {
    schemaVersion: FEATURE_OBSERVATION_SCHEMA_VERSION,
    featureId: FEATURE_ID,
    capabilityId: CAPABILITY_ID,
    scope,
    source: { componentKind: "pi-extension", componentId: PROVIDER_ID },
    status: "available",
    sequence: Math.max(1, entries.length),
    observedAt,
    value: {
      tokens,
      messageCount: projected.length,
      semantics: "branch-cumulative-distinct-source-messages",
    },
    checkpoints: {
      produced: {
        status: "complete",
        observedAt,
        sequence: Math.max(1, entries.length),
        detail: { branchOnly: true, compressionSummariesExcluded: true },
      },
    },
    warnings: ["压缩摘要不作为新的任务信息重复计数"],
    redactions: [],
    truncated: false,
  };
}

function uniqueMessages(messages: CoreMessage[]): CoreMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (message.toolName === "compress") return false;
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function unavailableObservation(
  scope: FeatureObservationSnapshot["scope"],
  observedAt: string,
  warning: string,
): FeatureObservationSnapshot {
  return {
    schemaVersion: FEATURE_OBSERVATION_SCHEMA_VERSION,
    featureId: FEATURE_ID,
    capabilityId: CAPABILITY_ID,
    scope,
    source: { componentKind: "pi-extension", componentId: PROVIDER_ID },
    status: "unavailable",
    sequence: null,
    observedAt,
    value: null,
    checkpoints: {
      produced: { status: "missing", observedAt, sequence: null },
    },
    warnings: [warning],
    redactions: [],
    truncated: false,
  };
}

function unsupportedObservation(
  scope: FeatureObservationSnapshot["scope"],
  observedAt: string,
): FeatureObservationSnapshot {
  return {
    ...unavailableObservation(scope, observedAt, "compression extension stood down for this host"),
    status: "unsupported",
  };
}
