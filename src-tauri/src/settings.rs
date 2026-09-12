// SPDX-License-Identifier: Apache-2.0
//! `settings.json` in app data (docs/settings.md). Secret-free; unknown
//! keys preserved; atomic writes.

use crate::error::err;
use crate::ipc::*;
use crate::paths::{app_data_dir, write_atomic};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const SETTINGS_SCHEMA: u32 = 2;

pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

pub fn builtin_providers() -> Vec<ProviderConfig> {
    let mk =
        |id: &str, kind: &str, label: &str, base: &str, ctx: u32, vision: bool| ProviderConfig {
            id: id.into(),
            kind: kind.into(),
            label: label.into(),
            base_url: base.into(),
            enabled: false,
            rates: [0.0; 4],
            context_window: ctx,
            build_capable: "unknown".into(),
            vision,
            cache_reporting: kind == "anthropic" || kind == "openai",
            raw_base64_images: false,
            models: vec![],
            probed_at: None,
            has_secret: false,
        };
    vec![
        mk(
            "anthropic",
            "anthropic",
            "Anthropic",
            "https://api.anthropic.com",
            200_000,
            true,
        ),
        mk(
            "openai",
            "openai",
            "OpenAI",
            "https://api.openai.com",
            200_000,
            true,
        ),
        mk(
            "google",
            "google",
            "Google Gemini",
            "https://generativelanguage.googleapis.com",
            1_000_000,
            true,
        ),
        mk(
            "openrouter",
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai",
            128_000,
            true,
        ),
        mk("xai", "xai", "xAI", "https://api.x.ai", 128_000, true),
        mk(
            "groq",
            "groq",
            "Groq",
            "https://api.groq.com",
            128_000,
            false,
        ),
        mk(
            "mistral",
            "mistral",
            "Mistral",
            "https://api.mistral.ai",
            128_000,
            false,
        ),
        mk(
            "openai-codex",
            "openai-codex",
            "OpenAI Codex (OAuth)",
            "https://chatgpt.com",
            200_000,
            true,
        ),
    ]
}

pub fn defaults() -> Settings {
    let mut shortcuts = BTreeMap::new();
    for (k, v) in [
        ("send", "Enter"),
        ("newline", "Shift+Enter"),
        ("stop", "Escape"),
        ("mode.plan", "Mod+1"),
        ("mode.build", "Mod+2"),
        ("mode.review", "Mod+3"),
        ("settings", "Mod+,"),
        ("search", "Mod+K"),
        ("canvas.fit", "F"),
        ("canvas.follow", "Mod+Shift+F"),
        ("help.shortcuts", "?"),
        ("tab.next", "Mod+Shift+]"),
        ("tab.prev", "Mod+Shift+["),
    ] {
        shortcuts.insert(k.to_string(), v.to_string());
    }
    let mut intake = BTreeMap::new();
    for (k, v) in [
        ("lib", "keep"),
        ("pdf", "keep"),
        ("sch", "reference"),
        ("bom", "keep"),
        ("image", "attach"),
        ("project_zip", "ask"),
    ] {
        intake.insert(k.to_string(), v.to_string());
    }
    Settings {
        schema_version: SETTINGS_SCHEMA,
        language: "auto".into(),
        theme: "system".into(),
        restore_tabs_on_launch: true,
        notifications: true,
        shortcuts,
        kicad: KicadSettings {
            app_path: None,
            cli_path: None,
            symbol_dir_override: None,
            target_version: 10,
        },
        providers: builtin_providers(),
        models_by_role: BTreeMap::new(),
        rates_as_of: None,
        disclosed_version: None,
        agent: AgentSettings {
            default_policy: "review".into(),
            continuous_run: true,
            session_ceiling_components_added: 24,
            budget_defaults: BudgetDefaults {
                plan_tokens: None,
                plan_usd: Some(5.0),
                plan_tool_calls: Some(400),
                plan_wall_min: Some(60),
                turn_tool_calls: Some(200),
                turn_wall_min: Some(15),
                warn_pct: 80,
            },
            canvas_follow: true,
            canvas_grid: false,
            canvas_changes: true,
            canvas_drag_selects: false,
            chat_attach_selection: true,
            intake_defaults: intake,
            chat_density: "compact".into(),
            thinking_level: "medium".into(),
            budget_enabled: true,
        },
        context: ContextSettings {
            hint_pct: 60,
            auto_pct: 80,
            emergency_pct: 92,
            keep_recent_tasks: 2,
            reserve_output_tokens: 8000,
        },
        storage: StorageSettings {
            checkpoint_turns: 50,
            checkpoint_mb: 500,
            external_cache_mb: 2048,
            datasheets_copy_to_project_default: false,
        },
        privacy: PrivacySettings {
            log_level: "info".into(),
        },
        advanced: AdvancedSettings {
            step_throttle: false,
            images_size: "standard".into(),
            tool_parallel_max: 4,
            drafter_concurrency: 3,
            provider_conn_max: 6,
            sandbox_enabled: true,
            router_path: None,
            release_dir: None,
        },
        parts: PartsSettings {
            enabled: false,
            lib_nickname: "jlc".into(),
            with_3d: true,
        },
        unknown: BTreeMap::new(),
    }
}

pub fn load() -> Settings {
    let p = settings_path();
    let Ok(bytes) = std::fs::read(&p) else {
        return defaults();
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) => merge_into_defaults(v),
        Err(_) => defaults(),
    }
}

/// Deep-merge a stored JSON object over the defaults so that new keys get
/// defaults and unknown keys survive (kept under `unknown` via flatten).
fn merge_into_defaults(stored: serde_json::Value) -> Settings {
    let mut base = serde_json::to_value(defaults()).unwrap();
    deep_merge(&mut base, stored);
    if let Some(o) = base.as_object_mut() {
        o.insert("schema_version".into(), serde_json::json!(SETTINGS_SCHEMA));
    }
    serde_json::from_value(base).unwrap_or_else(|_| defaults())
}

pub fn deep_merge(base: &mut serde_json::Value, patch: serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(b), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                if k == "providers" {
                    // Providers are a list keyed by id: merge per id, keep unknown ids.
                    let mut list = b
                        .get(&k)
                        .and_then(|x| x.as_array().cloned())
                        .unwrap_or_default();
                    if let Some(pl) = v.as_array() {
                        for pv in pl {
                            let id = pv
                                .get("id")
                                .and_then(|s| s.as_str())
                                .unwrap_or("")
                                .to_string();
                            if let Some(existing) = list
                                .iter_mut()
                                .find(|e| e.get("id").and_then(|s| s.as_str()) == Some(id.as_str()))
                            {
                                deep_merge(existing, pv.clone());
                            } else {
                                list.push(pv.clone());
                            }
                        }
                    }
                    b.insert(k, serde_json::Value::Array(list));
                    continue;
                }
                match b.get_mut(&k) {
                    Some(slot) if slot.is_object() && v.is_object() => deep_merge(slot, v),
                    _ => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (b, p) => *b = p,
    }
}

pub fn save(s: &Settings) -> Result<(), IpcError> {
    let mut v = serde_json::to_value(s)?;
    // Never persist derived secret flags.
    if let Some(list) = v.get_mut("providers").and_then(|p| p.as_array_mut()) {
        for p in list {
            if let Some(o) = p.as_object_mut() {
                o.remove("has_secret");
            }
        }
    }
    write_atomic(
        &settings_path(),
        serde_json::to_string_pretty(&v)?.as_bytes(),
    )
}

pub fn apply_patch(current: &Settings, patch: serde_json::Value) -> Result<Settings, IpcError> {
    if !patch.is_object() {
        return Err(err("BAD_CONFIG", "settings patch must be an object"));
    }
    validate_patch(&patch)?;
    let mut v = serde_json::to_value(current)?;
    deep_merge(&mut v, patch);
    let s: Settings = serde_json::from_value(v).map_err(|e| err("BAD_CONFIG", e.to_string()))?;
    Ok(s)
}

fn validate_patch(p: &serde_json::Value) -> Result<(), IpcError> {
    if let Some(ctx) = p.get("context") {
        if let Some(e) = ctx.get("emergency_pct").and_then(|x| x.as_u64()) {
            if e > 95 {
                return Err(err("BAD_CONFIG", "context.emergency_pct must be <= 95"));
            }
        }
    }
    if let Some(a) = p.get("agent") {
        if let Some(pol) = a.get("default_policy").and_then(|x| x.as_str()) {
            if !["ask", "review", "auto"].contains(&pol) {
                return Err(err(
                    "BAD_CONFIG",
                    "agent.default_policy must be ask|review|auto",
                ));
            }
        }
    }
    if let Some(list) = p.get("providers").and_then(|x| x.as_array()) {
        for pv in list {
            if let Some(url) = pv.get("base_url").and_then(|x| x.as_str()) {
                crate::net::validate_custom_origin(url)?;
            }
        }
    }
    Ok(())
}

/// Reset a dotted key path (e.g. `agent.default_policy`) to its default.
pub fn reset_keys(current: &Settings, keys: &[String]) -> Result<Settings, IpcError> {
    let mut v = serde_json::to_value(current)?;
    let d = serde_json::to_value(defaults())?;
    for k in keys {
        let parts: Vec<&str> = k.split('.').collect();
        let mut dv = &d;
        for p in &parts {
            dv = dv.get(p).unwrap_or(&serde_json::Value::Null);
        }
        let mut slot = &mut v;
        for p in &parts[..parts.len().saturating_sub(1)] {
            slot = slot.get_mut(p).unwrap_or_else(|| unreachable!());
        }
        if let (Some(last), Some(o)) = (parts.last(), slot.as_object_mut()) {
            if dv.is_null() {
                o.remove(*last);
            } else {
                o.insert(last.to_string(), dv.clone());
            }
        }
    }
    serde_json::from_value(v).map_err(|e| err("BAD_CONFIG", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_and_unknown_keys_survive() {
        let d = defaults();
        let json = serde_json::to_string(&d).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.agent.default_policy, "review");
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v["future_key"] = serde_json::json!({"a": 1});
        let merged = merge_into_defaults(v);
        assert!(merged.unknown.contains_key("future_key"));
        let patched = apply_patch(
            &merged,
            serde_json::json!({"agent": {"default_policy": "auto"}}),
        )
        .unwrap();
        assert_eq!(patched.agent.default_policy, "auto");
        assert!(apply_patch(
            &merged,
            serde_json::json!({"context": {"emergency_pct": 99}})
        )
        .is_err());
        let reset = reset_keys(&patched, &["agent.default_policy".into()]).unwrap();
        assert_eq!(reset.agent.default_policy, "review");
    }
}
