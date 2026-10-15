import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";

const packageRoot = process.cwd();
const extensionEntry = path.join(packageRoot, "dist", "pidian.js");
const root = await mkdtemp(path.join(os.tmpdir(), "pidian-context-loader-"));
const agentDir = path.join(root, "agent");

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

  console.log(`Pidian loader verified: ${extensionEntry}`);
  console.log(`Registered tools: ${toolNames.join(", ")}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
