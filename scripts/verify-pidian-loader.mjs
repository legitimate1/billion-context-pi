import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";

const packageRoot = process.cwd();
const extensionEntry = path.join(packageRoot, "dist", "pidian.js");
const root = await mkdtemp(path.join(os.tmpdir(), "pidian-context-loader-"));
const agentDir = path.join(root, "agent");
const sessionDir = path.join(root, "sessions");

try {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: [packageRoot] }),
    "utf8",
  );

  const settingsManager = sdk.SettingsManager.create(root, agentDir, {
    projectTrusted: false,
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const extensions = resourceLoader.getExtensions?.().extensions ?? [];
  const loaded = extensions.find((extension) => extension.resolvedPath === extensionEntry);
  assert.ok(loaded, `Pidian entry was not loaded: ${extensionEntry}`);

  const toolNames = loaded.tools instanceof Map ? [...loaded.tools.keys()] : [];
  for (const required of ["compress", "decompress", "search_context", "acp_status"]) {
    assert.ok(toolNames.includes(required), `missing required tool: ${required}`);
  }

  const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const sdkRoot = path.resolve(path.dirname(sdkEntry), "..");
  const aiCompat = path.join(sdkRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js");
  const { EventStream } = await import(pathToFileURL(aiCompat).href);
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const stream = (model, _context, options) => {
    const events = new EventStream(
      (event) => event.type === "done" || event.type === "error",
      (event) => event.type === "done" ? event.message : event.error,
    );
    const message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage,
      content: [{ type: "text", text: "offline-pidian-context-ok" }],
      stopReason: "stop",
    };
    setTimeout(() => {
      events.push({ type: "done", reason: "stop", message });
    }, 0);
    return events;
  };

  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("offline-probe", {
    api: "anthropic-messages",
    baseUrl: "https://offline.invalid",
    apiKey: "offline",
    streamSimple: stream,
    models: [{
      id: "offline",
      name: "Offline",
      reasoning: false,
      input: ["text"],
      cost: usage.cost,
      contextWindow: 32768,
      maxTokens: 256,
    }],
  });
  const model = modelRuntime.getModel("offline-probe", "offline");
  assert.ok(model, "offline model was not registered");

  const createLoader = async () => {
    const loaderSettings = sdk.SettingsManager.create(root, agentDir, { projectTrusted: false });
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: loaderSettings,
      noExtensions: false,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    return { loader, loaderSettings };
  };

  const firstRuntime = await createLoader();
  const firstManager = sdk.SessionManager.create(root, sessionDir);
  const first = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader: firstRuntime.loader,
    settingsManager: firstRuntime.loaderSettings,
    sessionManager: firstManager,
    tools: [],
  });
  let sessionFile;
  try {
    await first.session.prompt("first Pidian ACP lifecycle probe");
    sessionFile = first.session.sessionFile;
    assert.ok(sessionFile, "the first prompt did not create a session file");
  } finally {
    first.session.dispose();
  }

  const sidecarPath = `${sessionFile}.acp.json`;
  const firstSidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  assert.equal(firstSidecar.schemaVersion, 1, "unexpected ACP sidecar schema version");
  assert.match(firstSidecar.producer, /^billion-context-pi@/);
  assert.ok(Array.isArray(firstSidecar.blocks), "ACP sidecar is missing blocks");
  assert.ok(firstSidecar.messageRefs && typeof firstSidecar.messageRefs === "object", "ACP sidecar is missing message refs");
  const firstRefs = Object.keys(firstSidecar.messageRefs.byRef ?? {});
  assert.ok(firstRefs.length > 0, "the context lifecycle did not persist message refs");

  const secondRuntime = await createLoader();
  const secondManager = sdk.SessionManager.open(sessionFile, sessionDir);
  const second = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    resourceLoader: secondRuntime.loader,
    settingsManager: secondRuntime.loaderSettings,
    sessionManager: secondManager,
    tools: [],
  });
  try {
    await second.session.prompt("second Pidian ACP lifecycle probe");
  } finally {
    second.session.dispose();
  }

  const secondSidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  const secondRefs = Object.keys(secondSidecar.messageRefs?.byRef ?? {});
  for (const ref of firstRefs) assert.ok(secondRefs.includes(ref), `ACP ref was lost after reopen: ${ref}`);
  assert.ok(secondRefs.length > firstRefs.length, "reopened session did not extend ACP refs");

  console.log(`Pidian loader verified: ${extensionEntry}`);
  console.log(`Registered tools: ${toolNames.join(", ")}`);
  console.log(`ACP lifecycle verified: ${sidecarPath}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
