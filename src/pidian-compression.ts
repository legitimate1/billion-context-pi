import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import {
  handleCompress,
  type CompressArgs,
  type CompressionExecutionObserver,
  type CompressionExecutionReport,
} from "./compress-tool.js";

export const PIDIAN_SESSION_COMPRESSION_API_VERSION = 1 as const;
export const PIDIAN_SESSION_COMPRESSION_EVENT = "pidian.session-compression-provider" as const;
const PROVIDER_ID = "billion-context-pi";
declare const CURRENT_VERSION: string;

export interface PidianSessionCompressionProviderRunRequest {
  args: unknown;
  context?: unknown;
  toolCallId?: string;
  runId?: string;
  signal?: AbortSignal;
  reportPhase?: (phase: string, detail?: unknown) => void;
  reportResult?: (result: unknown) => void;
}

export interface PidianSessionCompressionResult {
  text: string;
}

export interface PidianSessionCompressionProvider {
  apiVersion: typeof PIDIAN_SESSION_COMPRESSION_API_VERSION;
  providerId: string;
  engineVersion?: string;
  run(
    request: PidianSessionCompressionProviderRunRequest,
  ): Promise<PidianSessionCompressionResult>;
}

interface PidianCompressionExtensionApi {
  registerPidianSessionCompressionProvider?: (
    provider: PidianSessionCompressionProvider,
  ) => () => void;
  events?: {
    emit(channel: string, data: unknown): void;
  };
}

/**
 * Expose the existing compression engine through Pidian's Host-owned
 * lifecycle bridge.  The engine still runs in the extension; the Host owns
 * identity, phase events, cancellation and terminal error evidence.
 */
export function registerPidianSessionCompressionProvider(
  pi: ExtensionAPI,
  runtime: AcpRuntime,
): PidianSessionCompressionProvider {
  const api = pi as ExtensionAPI & PidianCompressionExtensionApi;
  let activeContext: ExtensionContext | null = null;
  let eventProviderRegistered = false;
  let unregisterDirect: (() => void) | null = null;

  const provider: PidianSessionCompressionProvider = {
    apiVersion: PIDIAN_SESSION_COMPRESSION_API_VERSION,
    providerId: PROVIDER_ID,
    ...(typeof CURRENT_VERSION !== "undefined" ? { engineVersion: CURRENT_VERSION } : {}),
    run: async (request) => {
      const context = (request.context as ExtensionContext | undefined) ?? activeContext;
      if (!context) throw new Error("Pidian session compression context is not ready");

      const observer: CompressionExecutionObserver = {
        phase: (phase) => request.reportPhase?.(phase),
        result: (report: CompressionExecutionReport) => request.reportResult?.(report),
      };
      const text = await handleCompress(
        request.args as CompressArgs,
        runtime,
        context,
        request.toolCallId,
        request.signal,
        observer,
      );
      return { text };
    },
  };

  if (typeof api.registerPidianSessionCompressionProvider === "function") {
    unregisterDirect = api.registerPidianSessionCompressionProvider(provider);
  }

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    if (typeof api.registerPidianSessionCompressionProvider !== "function") {
      api.events?.emit(PIDIAN_SESSION_COMPRESSION_EVENT, {
        type: "register",
        provider,
      });
      eventProviderRegistered = true;
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (activeContext?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
    unregisterDirect?.();
    unregisterDirect = null;
    if (eventProviderRegistered) {
      api.events?.emit(PIDIAN_SESSION_COMPRESSION_EVENT, {
        type: "unregister",
        providerId: PROVIDER_ID,
        provider,
      });
      eventProviderRegistered = false;
    }
    activeContext = null;
  });

  return provider;
}
