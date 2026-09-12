// SPDX-License-Identifier: Apache-2.0
//! Provider capability probe (D-52): a tiny tool-use request through the
//! same network path. Sets build_capable / vision heuristically.

use crate::error::err;
use crate::ipc::{IpcError, ProviderConfig};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct ProbeResult {
    pub build_capable: String,
    pub vision: bool,
    pub context_window: Option<u32>,
}

pub async fn run(
    state: Arc<AppState>,
    cfg: &ProviderConfig,
    model: &str,
) -> Result<ProbeResult, IpcError> {
    let secret = crate::keyring::get(&cfg.id)?.ok_or_else(|| {
        err("PROVIDER_AUTH", "no API key stored").with_remediation("add the key first")
    })?;
    let client = &state.net.client;
    let origin = crate::net::validate_custom_origin(&cfg.base_url)
        .or_else(|_| crate::net::origin_of(&cfg.base_url))?;
    let tool = json!({"name": "ping", "description": "Return the given number", "parameters": {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}});
    let (url, body, mut req) = match cfg.kind.as_str() {
        "anthropic" => {
            let b = json!({"model": model, "max_tokens": 64, "tools": [{"name": "ping", "description": tool["description"], "input_schema": tool["parameters"]}], "messages": [{"role": "user", "content": "Call ping with n=7."}]});
            let r = client
                .post(format!("{origin}/v1/messages"))
                .header("x-api-key", &secret)
                .header("anthropic-version", "2023-06-01");
            (format!("{origin}/v1/messages"), b, r)
        }
        "google" => {
            let b = json!({"contents": [{"role": "user", "parts": [{"text": "Call ping with n=7."}]}], "tools": [{"functionDeclarations": [tool]}]});
            let u = format!("{origin}/v1beta/models/{model}:generateContent");
            let r = client.post(&u).header("x-goog-api-key", &secret);
            (u, b, r)
        }
        _ => {
            let base = cfg.base_url.trim_end_matches('/').to_string();
            let u = if base.ends_with("/v1") {
                format!("{base}/chat/completions")
            } else {
                format!("{base}/v1/chat/completions")
            };
            let b = json!({"model": model, "max_tokens": 64, "tools": [{"type": "function", "function": tool}], "messages": [{"role": "user", "content": "Call ping with n=7."}]});
            let r = client
                .post(&u)
                .header("Authorization", format!("Bearer {secret}"));
            (u, b, r)
        }
    };
    let _ = url;
    req = req.json(&body).timeout(std::time::Duration::from_secs(45));
    let resp = req
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(err("PROVIDER_AUTH", "the provider rejected the key"));
    }
    if !status.is_success() {
        return Err(err(
            "PROVIDER_BAD_REQUEST",
            format!("{status}: {}", crate::log::mask(&v.to_string())),
        ));
    }
    let s = v.to_string();
    let used_tool = s.contains("\"ping\"")
        && (s.contains("tool_use") || s.contains("tool_calls") || s.contains("functionCall"));
    let build_capable = if used_tool {
        if cfg.context_window >= 128_000 {
            "full"
        } else {
            "degraded"
        }
    } else {
        "none"
    };
    // Vision: providers we know; custom endpoints keep the user's manual flag.
    let vision = matches!(
        cfg.kind.as_str(),
        "anthropic" | "openai" | "google" | "openrouter" | "xai"
    ) || cfg.vision;
    let _ = state;
    Ok(ProbeResult {
        build_capable: build_capable.into(),
        vision,
        context_window: None,
    })
}
