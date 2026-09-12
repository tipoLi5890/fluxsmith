// SPDX-License-Identifier: Apache-2.0
// Provider → model catalogue for the settings UI and the lead fallback: a
// build-time snapshot of pi-ai's registry (scripts/gen-model-catalog.mjs)
// merged with the models fetched/typed for a provider. Pure, no SDK import,
// so the settings dialog never pulls provider SDKs into the entry bundle.
import generated from "./catalog.generated.json";
import type { ProviderConfig, Settings } from "../../ipc/types";

const CATALOG = generated as { models: Record<string, string[]>; baseUrls: Record<string, string> };

export function knownModels(kind: string): string[] {
  return CATALOG.models[kind] ?? [];
}

/** The API base URL pi-ai expects for a built-in provider kind (e.g. `https://chatgpt.com/backend-api`). */
export function knownBaseUrl(kind: string): string | null {
  return CATALOG.baseUrls[kind] || null;
}

export function modelsFor(p: Pick<ProviderConfig, "kind" | "models">): string[] {
  const out: string[] = [];
  for (const m of [...p.models, ...knownModels(p.kind)]) if (m && !out.includes(m)) out.push(m);
  return out;
}

/**
 * The lead model the next turn would use: `models_by_role.lead` when its
 * provider is enabled (falling back to the provider's first catalogue entry
 * when the configured id disappeared), else the first enabled provider with
 * credentials. Shared by the harness and the composer chip.
 */
export function effectiveLead(s: Pick<Settings, "providers" | "models_by_role">): { provider: ProviderConfig; model: string } | null {
  const id = s.models_by_role.lead;
  if (id) {
    const [pid, ...rest] = id.split("/");
    const provider = s.providers.find((p) => p.id === pid && p.enabled);
    if (provider) {
      const wanted = rest.join("/");
      const available = modelsFor(provider);
      const model = wanted && (available.length === 0 || available.includes(wanted)) ? wanted : available[0] ?? wanted;
      if (model) return { provider, model };
    }
  }
  const provider = s.providers.find((p) => p.enabled && (p.has_secret || p.kind === "openai-codex") && modelsFor(p).length > 0);
  return provider ? { provider, model: modelsFor(provider)[0] } : null;
}
