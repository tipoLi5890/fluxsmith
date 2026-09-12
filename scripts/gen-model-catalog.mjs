// SPDX-License-Identifier: Apache-2.0
// Regenerates src/agent/models/catalog.generated.json from pi-ai's registry so
// the settings UI can list models without loading provider SDKs eagerly.
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { writeFileSync } from "node:fs";
const out = { models: {}, baseUrls: {} };
for (const p of getProviders()) {
  try {
    const ms = getModels(p);
    out.models[p] = ms.map((m) => m.id).sort();
    out.baseUrls[p] = ms[0]?.baseUrl ?? "";
  } catch { out.models[p] = []; }
}
writeFileSync(new URL("../src/agent/models/catalog.generated.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`catalog: ${Object.keys(out.models).length} providers`);
