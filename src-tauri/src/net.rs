// SPDX-License-Identifier: Apache-2.0
//! All outbound HTTP (red line 12). Whitelisted origins, secrets injected
//! from the keyring, streaming back to the webview over a Channel, no
//! cross-origin redirects, Codex Device Code flow, external file landing.

use crate::error::err;
use crate::ipc::*;
use crate::paths::{app_data_dir, ensure_dir, now_iso, sha256_hex, write_atomic};
use crate::state::AppState;
use base64::Engine as _;
use futures_util::StreamExt;
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tauri::ipc::Channel;

pub const BUILTIN_ORIGINS: &[(&str, &str)] = &[
    ("anthropic", "https://api.anthropic.com"),
    ("openai", "https://api.openai.com"),
    ("google", "https://generativelanguage.googleapis.com"),
    ("openrouter", "https://openrouter.ai"),
    ("xai", "https://api.x.ai"),
    ("groq", "https://api.groq.com"),
    ("mistral", "https://api.mistral.ai"),
    ("openai-codex", "https://chatgpt.com"),
    ("openai-codex-auth", "https://auth.openai.com"),
];

pub const PARTS_ORIGINS: &[&str] = &[
    "https://jlcsearch.tscircuit.com",
    "https://easyeda.com",
    "https://modules.easyeda.com",
    "https://www.lcsc.com",
    "https://datasheet.lcsc.com",
    "https://wmsc.lcsc.com",
    "https://atta.szlcsc.com",
    "https://item.szlcsc.com",
    "https://www.szlcsc.com",
    "https://jlcpcb.com",
    "https://lceda.cn",
    "https://modules.lceda.cn",
];

/// Official Codex CLI client id (public; Device Code flow, see SECURITY.md).
pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Client identity reported to OpenAI. fluxsmith borrows the Codex CLI client id but is not an
/// official OpenAI client; declaring our own originator makes that visible instead of presenting
/// as the Codex CLI, and keeps any provider-side limiting scoped to fluxsmith. See SECURITY.md.
pub const FLUXSMITH_ORIGINATOR: &str = "fluxsmith";

/// Codex CLI release whose Responses wire format fluxsmith implements. The backend gates models
/// on the `version` header ("The 'gpt-5.6-sol' model requires a newer version of Codex",
/// 2026-09-03); the app's own version is meaningless to it, so `version` carries this compat
/// level while `originator` / `User-Agent` keep naming fluxsmith. Bump together with the
/// pinned `pi-ai` when the wire format is re-verified. See SECURITY.md.
pub const CODEX_COMPAT_VERSION: &str = "0.153.0";

/// Header names carrying client identity. Kept together so stripping and setting cannot drift.
const IDENTITY_HEADERS: &[&str] = &["originator", "version", "user-agent"];

fn fluxsmith_user_agent(app_version: &str) -> String {
    format!("{FLUXSMITH_ORIGINATOR}/{app_version};codex-compat/{CODEX_COMPAT_VERSION}")
}

/// Identity headers sent on every Codex request, mirroring the Codex wire contract.
/// This is a vendor-hidden contract, not a documented API: it may change without notice.
fn codex_identity_headers(app_version: &str) -> [(&'static str, String); 3] {
    [
        ("originator", FLUXSMITH_ORIGINATOR.to_string()),
        ("version", CODEX_COMPAT_VERSION.to_string()),
        ("User-Agent", fluxsmith_user_agent(app_version)),
    ]
}

/// Remove any identity headers already in the map, comparing case-insensitively.
///
/// `NetRequest::headers` is a case-sensitive `BTreeMap` while HTTP header names are not, and
/// `fetch` applies entries one by one via `RequestBuilder::header`, which *appends* rather than
/// replaces. Without this, a `User-Agent` left by the webview plus our `user-agent` would go out
/// as two values. (reqwest's client-level defaults do not overwrite request headers -- see
/// `Entry::Vacant` in reqwest's `async_impl/client.rs` -- so only map keys we add can collide.)
fn strip_identity_headers(headers: &mut BTreeMap<String, String>) {
    headers.retain(|k, _| {
        let k = k.to_ascii_lowercase();
        !IDENTITY_HEADERS.contains(&k.as_str())
    });
}

pub const MAX_EXTERNAL_BYTES: u64 = 50 * 1024 * 1024;
pub const EXTERNAL_TYPES: &[&str] = &[
    "application/pdf",
    "text/html",
    "text/plain",
    "application/json",
    "text/csv",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/octet-stream",
    "application/zip",
];

pub struct NetState {
    pub client: reqwest::Client,
    pub aborts: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    pub semaphore: Arc<tokio::sync::Semaphore>,
    pub codex: Mutex<Option<CodexPending>>,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserOutcome {
    /// `pending` | `authorized` | `denied` | `error`
    pub status: String,
    pub message: Option<String>,
}

pub struct CodexPending {
    /// Browser (PKCE + loopback callback) login: shared outcome written by the
    /// listener task; `None` for the device-code flow.
    pub browser: Option<std::sync::Arc<parking_lot::Mutex<BrowserOutcome>>>,
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_at: std::time::Instant,
    pub interval_s: u64,
    pub last_status: String,
    /// Loopback listener task of the browser flow; aborting it frees 127.0.0.1:1455 at once.
    pub abort: Option<tokio::task::AbortHandle>,
}

impl NetState {
    pub fn new(conn_max: usize, app_version: &str) -> NetState {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(fluxsmith_user_agent(app_version))
            .build()
            .expect("reqwest client");
        NetState {
            client,
            aborts: Mutex::new(HashMap::new()),
            semaphore: Arc::new(tokio::sync::Semaphore::new(conn_max.max(1))),
            codex: Mutex::new(None),
        }
    }
}

pub fn origin_of(url: &str) -> Result<String, IpcError> {
    let u = url::Url::parse(url).map_err(|e| err("NET_ORIGIN_DENIED", format!("bad url: {e}")))?;
    let host = u
        .host_str()
        .ok_or_else(|| err("NET_ORIGIN_DENIED", "url without host"))?;
    let default_port = match u.scheme() {
        "https" => 443,
        "http" => 80,
        _ => return Err(err("NET_ORIGIN_DENIED", "only http(s) is allowed")),
    };
    let port = u.port().unwrap_or(default_port);
    if port == default_port {
        Ok(format!("{}://{}", u.scheme(), host))
    } else {
        Ok(format!("{}://{}:{}", u.scheme(), host, port))
    }
}

fn is_localhost(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Custom provider origins: https anywhere, http only on localhost.
pub fn validate_custom_origin(url: &str) -> Result<String, IpcError> {
    let o = origin_of(url)?;
    let u = url::Url::parse(&o).unwrap();
    if u.scheme() == "http" && !is_localhost(u.host_str().unwrap_or("")) {
        return Err(err(
            "NET_ORIGIN_DENIED",
            "plain http is only allowed for localhost",
        )
        .with_remediation("use https or a local endpoint"));
    }
    Ok(o)
}

/// Pure whitelist decision.
pub fn origin_allowed(
    origin: &str,
    purpose: &str,
    registered: &[String],
    approved_fetch: &[String],
) -> bool {
    match purpose {
        "provider" => {
            BUILTIN_ORIGINS.iter().any(|(_, o)| *o == origin)
                || registered.iter().any(|r| r == origin)
        }
        "parts" => PARTS_ORIGINS.contains(&origin) || registered.iter().any(|r| r == origin),
        "web_fetch" => approved_fetch.iter().any(|r| r == origin),
        _ => false,
    }
}

fn registered_origins(state: &AppState) -> Vec<String> {
    let mut v = state.db.lock().approved_refs("origin").unwrap_or_default();
    for p in &state.settings.read().providers {
        if p.kind == "custom" && p.enabled {
            if let Ok(o) = validate_custom_origin(&p.base_url) {
                v.push(o);
            }
        }
    }
    v
}

fn inject_auth(
    state: &AppState,
    req: &NetRequest,
    headers: &mut BTreeMap<String, String>,
) -> Result<(), IpcError> {
    // Never let the webview supply credentials itself.
    headers.retain(|k, _| {
        let k = k.to_ascii_lowercase();
        k != "authorization"
            && k != "x-api-key"
            && k != "x-goog-api-key"
            && k != "cookie"
            && k != "chatgpt-account-id"
    });
    let Some(pid) = &req.provider else {
        return Ok(());
    };
    let kind = state
        .settings
        .read()
        .providers
        .iter()
        .find(|p| &p.id == pid)
        .map(|p| p.kind.clone())
        .unwrap_or_else(|| pid.clone());
    let secret = crate::keyring::get(pid)?.ok_or_else(|| {
        err("PROVIDER_AUTH", format!("no API key stored for {pid}"))
            .with_remediation("add the key in Settings > AI models")
    })?;
    match kind.as_str() {
        "anthropic" => {
            headers.insert("x-api-key".into(), secret);
            headers
                .entry("anthropic-version".into())
                .or_insert_with(|| "2023-06-01".into());
        }
        "google" => {
            headers.insert("x-goog-api-key".into(), secret);
        }
        "openai-codex" => {
            let tok: serde_json::Value = serde_json::from_str(&secret)
                .map_err(|_| err("PROVIDER_AUTH", "codex token malformed"))?;
            let access = tok
                .get("access_token")
                .and_then(|a| a.as_str())
                .ok_or_else(|| err("PROVIDER_AUTH", "codex token missing"))?;
            headers.insert("Authorization".into(), format!("Bearer {access}"));
            if let Some(acc) = tok.get("account_id").and_then(|a| a.as_str()) {
                headers.insert("chatgpt-account-id".into(), acc.into());
            }
            // Identify as fluxsmith. The webview's model library sets its own originator/User-Agent;
            // strip those first so usage is attributed here and no header goes out twice.
            strip_identity_headers(headers);
            for (k, v) in codex_identity_headers(&state.app_version) {
                headers.insert(k.into(), v);
            }
        }
        _ => {
            headers.insert("Authorization".into(), format!("Bearer {secret}"));
        }
    }
    Ok(())
}

pub async fn fetch(
    state: Arc<AppStateRef>,
    req: NetRequest,
    on_chunk: Channel<NetChunk>,
) -> Result<(), IpcError> {
    let st = &state.0;
    let origin = origin_of(&req.url)?;
    let registered = registered_origins(st);
    let approved_fetch = st
        .db
        .lock()
        .approved_refs("fetch_origin")
        .unwrap_or_default();
    if !origin_allowed(&origin, &req.purpose, &registered, &approved_fetch) {
        return Err(err(
            "NET_ORIGIN_DENIED",
            format!("{origin} is not an allowed origin for {}", req.purpose),
        )
        .with_remediation("register the origin in Settings > AI models (custom provider) first"));
    }
    if !matches!(req.method.as_str(), "GET" | "POST") {
        return Err(err("NET_ORIGIN_DENIED", "only GET and POST are allowed"));
    }
    let provider_kind = req.provider.as_ref().and_then(|pid| {
        st.settings
            .read()
            .providers
            .iter()
            .find(|p| &p.id == pid)
            .map(|p| p.kind.clone())
    });
    let is_codex = provider_kind.as_deref() == Some("openai-codex");
    if is_codex && codex_token_stale(120) {
        match codex_refresh(st).await {
            Ok(_) => {}
            Err(e) => {
                let _ = on_chunk.send(NetChunk::Error { error: e });
                return Ok(());
            }
        }
    }
    let mut headers = req.headers.clone();
    inject_auth(st, &req, &mut headers)?;
    let permit = st
        .net
        .semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| err("NET_OFFLINE", "connection pool closed"))?;
    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel::<()>();
    st.net.aborts.lock().insert(req.id.clone(), abort_tx);
    let client = st.net.client.clone();
    let mut builder = match req.method.as_str() {
        "POST" => client.post(&req.url),
        _ => client.get(&req.url),
    };
    for (k, v) in &headers {
        builder = builder.header(k, v);
    }
    if let Some(b) = &req.body {
        builder = builder.body(b.clone());
    }
    let (head_timeout, idle_timeout) = stream_timeouts(&req.purpose, req.timeout_ms);
    // The reqwest timeout covers the whole exchange including the streamed body; for a provider
    // stream that would cut a long completion off at the head timeout (both 2026-08-30 and
    // 2026-09-03 "error decoding response body" failures happened at exactly 120 s). Provider
    // streams therefore get only a head timeout here plus a per-chunk idle timeout below.
    if let Some(t) = head_timeout {
        builder = builder.timeout(t);
    }
    crate::log::write(
        "debug",
        &format!("net_fetch {} {} {}", req.purpose, req.method, origin),
        &req.id,
    );
    let resp = tokio::select! {
        r = builder.send() => r,
        _ = &mut abort_rx => {
            st.net.aborts.lock().remove(&req.id);
            drop(permit);
            let _ = on_chunk.send(NetChunk::Error { error: err("ENGINE_CANCELLED", "aborted") });
            return Ok(());
        }
    };
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            st.net.aborts.lock().remove(&req.id);
            let code = if e.is_timeout() {
                "NET_TIMEOUT"
            } else if e.is_connect() {
                "NET_OFFLINE"
            } else {
                "PROVIDER_STREAM_BROKEN"
            };
            let _ = on_chunk.send(NetChunk::Error {
                error: err(code, e.to_string()),
            });
            return Ok(());
        }
    };
    let mut resp = resp;
    if resp.status().as_u16() == 401 && is_codex {
        // Expired mid-flight: refresh once and replay the request.
        if let Ok(true) = codex_refresh(st).await {
            let mut headers = req.headers.clone();
            inject_auth(st, &req, &mut headers)?;
            let mut b = match req.method.as_str() {
                "POST" => client.post(&req.url),
                _ => client.get(&req.url),
            };
            for (k, v) in &headers {
                b = b.header(k, v);
            }
            if let Some(body) = &req.body {
                b = b.body(body.clone());
            }
            if let Some(t) = head_timeout {
                b = b.timeout(t);
            }
            if let Ok(r) = b.send().await {
                resp = r;
            }
        }
    }
    let status = resp.status().as_u16();
    crate::log::event(
        "info",
        "net.fetch",
        serde_json::json!({"origin": origin, "method": req.method, "status": status, "purpose": req.purpose}),
        Some(&req.id),
    );
    if (300..400).contains(&status) {
        st.net.aborts.lock().remove(&req.id);
        let _ = on_chunk.send(NetChunk::Error {
            error: err("NET_REDIRECT_BLOCKED", "redirects are not followed"),
        });
        return Ok(());
    }
    let mut hmap = BTreeMap::new();
    for (k, v) in resp.headers() {
        let k = k.as_str().to_ascii_lowercase();
        if k == "set-cookie" {
            continue;
        }
        hmap.insert(k, v.to_str().unwrap_or("").to_string());
    }
    let _ = on_chunk.send(NetChunk::Head {
        status,
        headers: hmap,
    });
    let mut stream = resp.bytes_stream();
    let mut total = 0u64;
    loop {
        tokio::select! {
            item = tokio::time::timeout(idle_timeout, stream.next()) => match item {
                Ok(Some(Ok(bytes))) => {
                    total += bytes.len() as u64;
                    let _ = on_chunk.send(NetChunk::Body { data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes) });
                }
                Ok(Some(Err(e))) => {
                    let _ = on_chunk.send(NetChunk::Error { error: err("PROVIDER_STREAM_BROKEN", e.to_string()) });
                    break;
                }
                Ok(None) => {
                    let _ = on_chunk.send(NetChunk::Done { bytes: total });
                    break;
                }
                Err(_) => {
                    let _ = on_chunk.send(NetChunk::Error { error: err("NET_TIMEOUT", format!("no bytes for {} s", idle_timeout.as_secs())) });
                    break;
                }
            },
            _ = &mut abort_rx => {
                let _ = on_chunk.send(NetChunk::Error { error: err("ENGINE_CANCELLED", "aborted") });
                break;
            }
        }
    }
    st.net.aborts.lock().remove(&req.id);
    drop(permit);
    Ok(())
}

/// Timeouts for one fetch: `(whole-request timeout, idle timeout between body chunks)`.
/// Provider streams have no whole-request timeout (a completion may legitimately run for
/// minutes); everything else keeps `timeout_ms` (default 120 s) as the total. The idle timeout
/// is what catches a dead provider connection: 300 s for providers (reasoning models can be
/// silent for a while before the first delta), `timeout_ms` for the rest.
pub fn stream_timeouts(
    purpose: &str,
    timeout_ms: Option<u64>,
) -> (Option<std::time::Duration>, std::time::Duration) {
    let total = std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000));
    if purpose == "provider" {
        (
            None,
            std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000)),
        )
    } else {
        (Some(total), total)
    }
}

#[cfg(test)]
mod timeout_tests {
    use super::stream_timeouts;
    #[test]
    fn provider_streams_have_no_total_timeout_only_idle() {
        let (head, idle) = stream_timeouts("provider", None);
        assert!(head.is_none());
        assert_eq!(idle.as_secs(), 300);
        let (head, idle) = stream_timeouts("provider", Some(30_000));
        assert!(head.is_none());
        assert_eq!(idle.as_secs(), 30);
    }
    #[test]
    fn other_purposes_keep_the_total_timeout() {
        let (head, idle) = stream_timeouts("parts", None);
        assert_eq!(head.unwrap().as_secs(), 120);
        assert_eq!(idle.as_secs(), 120);
        let (head, _) = stream_timeouts("web_fetch", Some(5_000));
        assert_eq!(head.unwrap().as_millis(), 5_000);
    }
}

/// Newtype so async commands can hold an `Arc` to the state.
pub struct AppStateRef(pub Arc<AppState>);

pub fn abort(state: &AppState, id: &str) {
    if let Some(tx) = state.net.aborts.lock().remove(id) {
        let _ = tx.send(());
    }
}

// ----------------------------------------------------------- Codex OAuth

pub const CODEX_ISSUER: &str = "https://auth.openai.com";

/// Codex device-code login, mirroring the official Codex CLI
/// (`codex-rs/login/src/device_code_auth.rs`): user code from
/// `/api/accounts/deviceauth/usercode`, poll `/api/accounts/deviceauth/token`
/// (403/404 = still pending), then a PKCE authorization-code exchange at
/// `/oauth/token` with the verifier the server hands back.
pub async fn codex_begin(state: &AppState) -> Result<DeviceCodeState, IpcError> {
    let resp = state
        .net
        .client
        .post(format!("{CODEX_ISSUER}/api/accounts/deviceauth/usercode"))
        .json(&serde_json::json!({ "client_id": CODEX_CLIENT_ID }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        crate::log::warn(&format!("codex usercode request failed: {status} {text}"));
        return Err(err(
            "PROVIDER_AUTH",
            format!(
                "device code request failed ({status}): {}",
                text.chars().take(300).collect::<String>()
            ),
        ));
    }
    let device_auth_id = v["device_auth_id"].as_str().unwrap_or("").to_string();
    let user_code = v["user_code"]
        .as_str()
        .or(v["usercode"].as_str())
        .unwrap_or("")
        .to_string();
    let interval = v["interval"].as_u64().unwrap_or(5).max(1);
    let url = format!("{CODEX_ISSUER}/codex/device");
    let expires_in = 15 * 60;
    if device_auth_id.is_empty() || user_code.is_empty() {
        return Err(err(
            "PROVIDER_AUTH",
            format!("unexpected device code response: {text}"),
        ));
    }
    *state.net.codex.lock() = Some(CodexPending {
        browser: None,
        device_code: device_auth_id,
        user_code: user_code.clone(),
        verification_url: url.clone(),
        expires_at: std::time::Instant::now() + std::time::Duration::from_secs(expires_in),
        interval_s: interval,
        last_status: "pending".into(),
        abort: None,
    });
    Ok(DeviceCodeState {
        status: "pending".into(),
        user_code: Some(user_code),
        verification_url: Some(url),
        expires_at: Some(
            (chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64)).to_rfc3339(),
        ),
        message: None,
    })
}

/// Loopback callback port used by the official Codex CLI (its client id only
/// accepts `http://localhost:1455/auth/callback`). The listener lives for one
/// login attempt (≤ 5 min), binds 127.0.0.1 only and accepts a single request
/// with a matching `state`; this is the one sanctioned exception to "no
/// inbound port" (CLAUDE.md red line 19).
pub const CODEX_CALLBACK_PORT: u16 = 1455;

fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(d)
}

/// PKCE authorization-code exchange shared by both login methods
/// (`codex-rs/login/src/server.rs::exchange_code_for_tokens`).
async fn codex_exchange(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<(), String> {
    let resp = client
        .post(format!("{CODEX_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", CODEX_CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let Some(access) = v.get("access_token").and_then(|a| a.as_str()) else {
        crate::log::warn(&format!("codex token exchange failed: {status}"));
        return Err(format!("token exchange failed ({status})"));
    };
    let account_id = jwt_claim(access, "https://api.openai.com/auth")
        .or_else(|| {
            v.get("id_token")
                .and_then(|t| t.as_str())
                .and_then(|t| jwt_claim(t, "https://api.openai.com/auth"))
        })
        .and_then(|c| {
            c.get("chatgpt_account_id")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string())
        });
    let stored = serde_json::json!({"access_token": access, "refresh_token": v.get("refresh_token"), "id_token": v.get("id_token"), "account_id": account_id, "obtained": now_iso()});
    crate::keyring::set("openai-codex", &stored.to_string()).map_err(|e| e.message)?;
    Ok(())
}

/// Browser login: open `/oauth/authorize` (PKCE S256) and wait for the
/// loopback callback, exactly like `codex login`.
pub async fn codex_browser_begin(state: &AppState) -> Result<DeviceCodeState, IpcError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", CODEX_CALLBACK_PORT))
        .await
        .map_err(|e| {
            err(
                "PORT_BUSY",
                format!("cannot listen on 127.0.0.1:{CODEX_CALLBACK_PORT}: {e}"),
            )
            .with_remediation("close the other program using the port (often another Codex login) or use the device-code method")
        })?;
    let verifier = random_token();
    let challenge = pkce_challenge(&verifier);
    let state_tok = random_token();
    let redirect_uri = format!("http://localhost:{CODEX_CALLBACK_PORT}/auth/callback");
    let mut url = url::Url::parse(&format!("{CODEX_ISSUER}/oauth/authorize")).unwrap();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CODEX_CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair(
            "scope",
            "openid profile email offline_access api.connectors.read api.connectors.invoke",
        )
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", &state_tok)
        .append_pair("originator", FLUXSMITH_ORIGINATOR);
    let outcome = std::sync::Arc::new(parking_lot::Mutex::new(BrowserOutcome {
        status: "pending".into(),
        message: None,
    }));
    let expires_in = 5 * 60;
    // A previous (cancelled or stale) flow must not keep the port or answer this one's poll.
    if let Some(prev) = state.net.codex.lock().take() {
        if let Some(h) = prev.abort {
            h.abort();
        }
    }
    let client = state.net.client.clone();
    let outcome_task = outcome.clone();
    let task = tokio::spawn(async move {
        let outcome = outcome_task;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let accept = tokio::time::timeout(std::time::Duration::from_secs(expires_in), async {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { continue };
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let line = req.lines().next().unwrap_or("").to_string();
                let path = line.split_whitespace().nth(1).unwrap_or("");
                if !path.starts_with("/auth/callback") {
                    let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    continue;
                }
                let q = path.split_once('?').map(|x| x.1).unwrap_or("");
                let params: std::collections::HashMap<String, String> = url::form_urlencoded::parse(q.as_bytes())
                    .into_owned()
                    .collect();
                let body_ok = "<!doctype html><html><body style=\"font-family:system-ui;padding:2em\"><h2>fluxsmith</h2><p>Login complete. You can close this window.</p></body></html>";
                let body_err = "<!doctype html><html><body style=\"font-family:system-ui;padding:2em\"><h2>fluxsmith</h2><p>Login failed. Return to the app and try again.</p></body></html>";
                let ok = params.get("state").map(|s| s == &state_tok).unwrap_or(false) && params.contains_key("code");
                let body = if ok { body_ok } else { body_err };
                let _ = sock
                    .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes())
                    .await;
                let _ = sock.shutdown().await;
                return if ok { Ok(params.get("code").cloned().unwrap_or_default()) } else { Err(params.get("error").cloned().unwrap_or_else(|| "state mismatch or missing code".into())) };
            }
        })
        .await;
        let mut o = outcome.lock();
        match accept {
            Err(_) => {
                o.status = "expired".into();
            }
            Ok(Err(e)) => {
                o.status = if e == "access_denied" {
                    "denied".into()
                } else {
                    "error".into()
                };
                o.message = Some(e);
            }
            Ok(Ok(code)) => {
                drop(o);
                let r = codex_exchange(&client, &code, &verifier, &redirect_uri).await;
                let mut o = outcome.lock();
                match r {
                    Ok(()) => o.status = "authorized".into(),
                    Err(e) => {
                        o.status = "error".into();
                        o.message = Some(e);
                    }
                }
            }
        }
    });
    *state.net.codex.lock() = Some(CodexPending {
        browser: Some(outcome.clone()),
        device_code: String::new(),
        user_code: String::new(),
        verification_url: url.to_string(),
        expires_at: std::time::Instant::now() + std::time::Duration::from_secs(expires_in),
        interval_s: 2,
        last_status: "pending".into(),
        abort: Some(task.abort_handle()),
    });
    Ok(DeviceCodeState {
        status: "pending".into(),
        user_code: None,
        verification_url: Some(url.to_string()),
        expires_at: Some(
            (chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64)).to_rfc3339(),
        ),
        message: None,
    })
}

pub async fn codex_poll(state: &AppState) -> Result<DeviceCodeState, IpcError> {
    let (device_auth_id, user_code, url, expired) = {
        let g = state.net.codex.lock();
        let Some(p) = g.as_ref() else {
            return Ok(DeviceCodeState {
                status: "cancelled".into(),
                user_code: None,
                verification_url: None,
                expires_at: None,
                message: Some("no login in progress".into()),
            });
        };
        (
            p.device_code.clone(),
            p.user_code.clone(),
            p.verification_url.clone(),
            std::time::Instant::now() > p.expires_at,
        )
    };
    let pending = |status: &str, message: Option<String>| DeviceCodeState {
        status: status.into(),
        user_code: Some(user_code.clone()),
        verification_url: Some(url.clone()),
        expires_at: None,
        message,
    };
    let browser = state
        .net
        .codex
        .lock()
        .as_ref()
        .and_then(|p| p.browser.clone());
    if let Some(o) = browser {
        let o = o.lock().clone();
        if o.status != "pending" {
            *state.net.codex.lock() = None;
        }
        if expired && o.status == "pending" {
            *state.net.codex.lock() = None;
            return Ok(pending("expired", None));
        }
        return Ok(DeviceCodeState {
            status: o.status.clone(),
            user_code: None,
            verification_url: if o.status == "pending" {
                Some(url.clone())
            } else {
                None
            },
            expires_at: None,
            message: o.message,
        });
    }
    if expired {
        *state.net.codex.lock() = None;
        return Ok(DeviceCodeState {
            status: "expired".into(),
            user_code: None,
            verification_url: None,
            expires_at: None,
            message: None,
        });
    }
    let resp = state
        .net
        .client
        .post(format!("{CODEX_ISSUER}/api/accounts/deviceauth/token"))
        .json(&serde_json::json!({ "device_auth_id": device_auth_id, "user_code": user_code }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 403 || status.as_u16() == 404 {
        return Ok(pending("pending", None));
    }
    if !status.is_success() {
        crate::log::warn(&format!("codex token poll failed: {status} {text}"));
        *state.net.codex.lock() = None;
        return Ok(pending(
            "error",
            Some(format!(
                "{status}: {}",
                text.chars().take(300).collect::<String>()
            )),
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| err("PROVIDER_BAD_REQUEST", e.to_string()))?;
    let code = v["authorization_code"].as_str().unwrap_or("");
    let verifier = v["code_verifier"].as_str().unwrap_or("");
    if code.is_empty() || verifier.is_empty() {
        return Ok(pending("pending", None));
    }
    let redirect_uri = format!("{CODEX_ISSUER}/deviceauth/callback");
    if let Err(e) = codex_exchange(&state.net.client, code, verifier, &redirect_uri).await {
        *state.net.codex.lock() = None;
        return Ok(pending("error", Some(e)));
    }
    *state.net.codex.lock() = None;
    Ok(DeviceCodeState {
        status: "authorized".into(),
        user_code: None,
        verification_url: None,
        expires_at: None,
        message: None,
    })
}

fn jwt_claim(token: &str, key: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get(key).cloned()
}

pub fn codex_revoke(state: &AppState) -> Result<(), IpcError> {
    // Cancel an in-progress login: abort the loopback listener (frees the port) and forget the flow.
    if let Some(p) = state.net.codex.lock().take() {
        if let Some(h) = p.abort {
            h.abort();
        }
    }
    crate::keyring::delete("openai-codex")
}

// ------------------------------------------------------- external landing

pub fn external_dir() -> std::path::PathBuf {
    app_data_dir().join("external")
}

/// Store bytes content-addressed; returns (sha256, path).
pub fn land_bytes(
    state: &AppState,
    bytes: &[u8],
    ext: &str,
    content_type: &str,
    origin: Option<&str>,
    url: Option<&str>,
) -> Result<String, IpcError> {
    if bytes.len() as u64 > MAX_EXTERNAL_BYTES {
        return Err(err(
            "NET_TOO_LARGE",
            format!("{} bytes exceeds the 50 MB limit", bytes.len()),
        ));
    }
    let sha = sha256_hex(bytes);
    let dir = external_dir();
    ensure_dir(&dir)?;
    let p = dir.join(&sha);
    if !p.exists() {
        write_atomic(&p, bytes)?;
    }
    state
        .db
        .lock()
        .external_upsert(&sha, ext, content_type, bytes.len() as u64, origin, url)?;
    Ok(sha)
}

/// Fetch a URL (web_fetch purpose, origin must be approved) and land it.
pub async fn fetch_and_land(
    state: Arc<AppStateRef>,
    url: &str,
) -> Result<serde_json::Value, IpcError> {
    let st = &state.0;
    let origin = origin_of(url)?;
    let approved = st
        .db
        .lock()
        .approved_refs("fetch_origin")
        .unwrap_or_default();
    if !origin_allowed(&origin, "web_fetch", &[], &approved) {
        return Err(err(
            "CONSENT_REQUIRED",
            format!("{origin} needs a one-time fetch consent"),
        )
        .with_evidence(serde_json::json!({"origin": origin})));
    }
    let resp = st
        .net
        .client
        .get(url)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    if resp.status().is_redirection() {
        return Err(err("NET_REDIRECT_BLOCKED", "redirects are not followed"));
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !EXTERNAL_TYPES.contains(&ct.as_str()) {
        return Err(err(
            "NET_TYPE_REJECTED",
            format!("content-type {ct} is not accepted"),
        ));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_EXTERNAL_BYTES {
            return Err(err("NET_TOO_LARGE", "response exceeds 50 MB"));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| err("PROVIDER_STREAM_BROKEN", e.to_string()))?;
    let ext = match ct.as_str() {
        "application/pdf" => "pdf",
        "text/html" => "html",
        "text/plain" => "txt",
        "application/json" => "json",
        "text/csv" => "csv",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "application/zip" => "zip",
        _ => "bin",
    };
    let sha = land_bytes(st, &bytes, ext, &ct, Some(&origin), Some(url))?;
    let text = if ct.starts_with("text/") || ct == "application/json" {
        Some(String::from_utf8_lossy(&bytes[..bytes.len().min(32 * 1024)]).to_string())
    } else {
        None
    };
    Ok(
        serde_json::json!({"sha256": sha, "content_type": ct, "size": bytes.len(), "text": text, "url": url}),
    )
}

/// `web.fetch` tool body: land the URL (origin consent enforced by
/// `fetch_and_land`), then hand back text the model can read (HTML converted
/// in Rust) or only the sha256 handle for PDFs / binaries.
pub async fn fetch_text(state: Arc<AppStateRef>, url: &str) -> Result<serde_json::Value, IpcError> {
    let landed = fetch_and_land(state.clone(), url).await?;
    let sha = landed
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("BAD_CONFIG", "landed fetch has no sha"))?
        .to_string();
    let ct = landed
        .get("content_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Text-like bodies are re-read from the content-addressed store (bounded by MAX_EXTERNAL_BYTES).
    let body = if ct == "text/html" || ct.starts_with("text/") || ct == "application/json" {
        std::fs::read(external_dir().join(&sha)).unwrap_or_default()
    } else {
        Vec::new()
    };
    crate::webtext::shape(&landed, &body)
}

/// Approved `web.fetch` origins (DB `approvals` kind `fetch_origin`, the only truth).
pub fn fetch_origin_list(state: &AppState) -> Result<Vec<serde_json::Value>, IpcError> {
    let rows = state.db.lock().approval_list(None, Some("fetch_origin"))?;
    Ok(rows
        .into_iter()
        .filter(|r| r.get("revoked_at").map(|v| v.is_null()).unwrap_or(true))
        .map(|r| serde_json::json!({"id": r.get("id"), "origin": r.get("ref"), "granted_at": r.get("granted_at")}))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex_provider(id: &str) -> crate::ipc::ProviderConfig {
        crate::ipc::ProviderConfig {
            id: id.into(),
            kind: "openai-codex".into(),
            label: "Codex".into(),
            base_url: "https://chatgpt.com".into(),
            enabled: true,
            rates: [0.0; 4],
            context_window: 0,
            build_capable: "unknown".into(),
            vision: false,
            cache_reporting: false,
            raw_base64_images: false,
            models: vec![],
            probed_at: None,
            has_secret: true,
        }
    }

    fn net_request(provider: &str, headers: BTreeMap<String, String>) -> NetRequest {
        NetRequest {
            id: "r1".into(),
            method: "POST".into(),
            url: "https://chatgpt.com/backend-api/codex/responses".into(),
            headers,
            body: None,
            provider: Some(provider.into()),
            timeout_ms: None,
            purpose: "provider".into(),
        }
    }

    #[test]
    fn identity_headers_name_fluxsmith() {
        let h = codex_identity_headers("1.2.3");
        assert_eq!(h[0], ("originator", "fluxsmith".to_string()));
        assert_eq!(h[1], ("version", CODEX_COMPAT_VERSION.to_string()));
        assert_eq!(
            h[2],
            (
                "User-Agent",
                format!("fluxsmith/1.2.3;codex-compat/{CODEX_COMPAT_VERSION}")
            )
        );
        // The Codex CLI sanitizes user agents containing invalid header characters; ours must
        // never need that. Also guards against a version string picking up stray whitespace.
        for (_, v) in h.iter() {
            assert!(
                v.chars()
                    .all(|c| !c.is_control() && c.is_ascii() && c != ' '),
                "identity value is not a clean header value: {v:?}"
            );
        }
    }

    #[test]
    fn strip_identity_is_case_insensitive() {
        let mut h: BTreeMap<String, String> = BTreeMap::new();
        h.insert("User-Agent".into(), "pi (browser)".into());
        h.insert("USER-AGENT".into(), "dupe".into());
        h.insert("Originator".into(), "pi".into());
        h.insert("version".into(), "0.0.0".into());
        h.insert("content-type".into(), "application/json".into());
        strip_identity_headers(&mut h);
        assert_eq!(h.len(), 1);
        assert_eq!(
            h.get("content-type").map(String::as_str),
            Some("application/json")
        );
    }

    #[test]
    fn inject_auth_overwrites_library_identity_for_codex() {
        let state = crate::state::AppState::for_tests();
        state
            .settings
            .write()
            .providers
            .push(codex_provider("codex"));
        crate::keyring::set("codex", r#"{"access_token":"tok","account_id":"acc"}"#).unwrap();

        // What the vendored model library puts on the request today.
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        headers.insert("originator".into(), "pi".into());
        headers.insert("User-Agent".into(), "pi (browser)".into());
        headers.insert("content-type".into(), "application/json".into());
        let req = net_request("codex", headers.clone());

        inject_auth(&state, &req, &mut headers).unwrap();

        let ua: Vec<_> = headers
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("user-agent"))
            .collect();
        let orig: Vec<_> = headers
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("originator"))
            .collect();
        assert_eq!(ua.len(), 1, "user-agent must not go out twice");
        assert_eq!(orig.len(), 1, "originator must not go out twice");
        assert_eq!(
            headers.get("originator").map(String::as_str),
            Some("fluxsmith")
        );
        assert_eq!(
            headers.get("User-Agent").map(String::as_str),
            Some(fluxsmith_user_agent(&state.app_version).as_str())
        );
        assert_eq!(
            headers.get("version").map(String::as_str),
            Some(CODEX_COMPAT_VERSION)
        );
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Bearer tok")
        );
        assert_eq!(
            headers.get("chatgpt-account-id").map(String::as_str),
            Some("acc")
        );
        assert_eq!(
            headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
    }

    #[test]
    fn whitelist_decisions() {
        assert!(origin_allowed(
            "https://api.anthropic.com",
            "provider",
            &[],
            &[]
        ));
        assert!(!origin_allowed(
            "https://evil.example",
            "provider",
            &[],
            &[]
        ));
        assert!(origin_allowed(
            "http://localhost:11434",
            "provider",
            &["http://localhost:11434".into()],
            &[]
        ));
        assert!(!origin_allowed(
            "https://api.anthropic.com",
            "web_fetch",
            &[],
            &[]
        ));
        assert!(origin_allowed(
            "https://docs.example",
            "web_fetch",
            &[],
            &["https://docs.example".into()]
        ));
        assert!(origin_allowed("https://easyeda.com", "parts", &[], &[]));
        assert_eq!(
            origin_of("https://api.openai.com/v1/chat?x=1").unwrap(),
            "https://api.openai.com"
        );
        assert_eq!(
            origin_of("http://127.0.0.1:1234/v1").unwrap(),
            "http://127.0.0.1:1234"
        );
        assert!(validate_custom_origin("http://example.com/v1").is_err());
        assert!(validate_custom_origin("http://localhost:1234/v1").is_ok());
        assert!(origin_of("ftp://x").is_err());
    }
}

/// Ask the provider for its model catalogue (`GET …/models`). Secrets are
/// injected here, never returned; providers without a listing endpoint
/// (Codex) return an empty list so the caller falls back to the built-in
/// catalogue.
pub async fn provider_models(state: &AppState, provider_id: &str) -> Result<Vec<String>, IpcError> {
    let cfg = state
        .settings
        .read()
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .cloned()
        .ok_or_else(|| err("BAD_CONFIG", "unknown provider"))?;
    if cfg.kind == "openai-codex" {
        return codex_models(state, provider_id).await;
    }
    validate_custom_origin(&cfg.base_url).or_else(|_| origin_of(&cfg.base_url))?;
    let base = cfg.base_url.trim_end_matches('/').to_string();
    let url = match cfg.kind.as_str() {
        "anthropic" => format!("{base}/v1/models?limit=1000"),
        "google" => format!("{base}/v1beta/models?pageSize=1000"),
        "openrouter" => format!("{base}/api/v1/models"),
        "groq" => format!("{base}/openai/v1/models"),
        _ => {
            if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            }
        }
    };
    let mut headers = BTreeMap::new();
    let req = NetRequest {
        id: String::new(),
        method: "GET".into(),
        url: url.clone(),
        headers: BTreeMap::new(),
        body: None,
        provider: Some(provider_id.to_string()),
        timeout_ms: Some(20_000),
        purpose: "provider".into(),
    };
    inject_auth(state, &req, &mut headers)?;
    let mut rb = state
        .net
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(20));
    for (k, v) in &headers {
        rb = rb.header(k, v);
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(err(
            "PROVIDER_BAD_REQUEST",
            format!(
                "model listing failed ({status}): {}",
                text.chars().take(300).collect::<String>()
            ),
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| err("PROVIDER_BAD_REQUEST", e.to_string()))?;
    let mut out: Vec<String> = Vec::new();
    let items = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|d| d.as_array()))
        .cloned()
        .unwrap_or_default();
    for it in items {
        let id = it
            .get("id")
            .and_then(|x| x.as_str())
            .or_else(|| it.get("name").and_then(|x| x.as_str()))
            .map(|s| s.trim_start_matches("models/").to_string());
        if let Some(id) = id {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Refresh the Codex access token with the stored refresh token
/// (`/oauth/token`, `grant_type=refresh_token`). Returns false when there is
/// nothing to refresh; errors are logged, never surfaced with secrets.
pub async fn codex_refresh(state: &AppState) -> Result<bool, IpcError> {
    let Some(secret) = crate::keyring::get("openai-codex")? else {
        return Ok(false);
    };
    let tok: serde_json::Value = serde_json::from_str(&secret).unwrap_or(serde_json::Value::Null);
    let Some(refresh) = tok
        .get("refresh_token")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
    else {
        return Ok(false);
    };
    let resp = state
        .net
        .client
        .post(format!("{CODEX_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", CODEX_CLIENT_ID),
            ("scope", "openid profile email"),
        ])
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let Some(access) = v.get("access_token").and_then(|a| a.as_str()) else {
        crate::log::warn(&format!("codex refresh failed: {status}"));
        return Err(err("PROVIDER_AUTH", "Codex session expired; sign in again")
            .with_remediation("Settings > AI models > OpenAI Codex > sign in"));
    };
    let account_id = jwt_claim(access, "https://api.openai.com/auth")
        .and_then(|c| {
            c.get("chatgpt_account_id")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            tok.get("account_id")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string())
        });
    let stored = serde_json::json!({
        "access_token": access,
        "refresh_token": v.get("refresh_token").and_then(|r| r.as_str()).unwrap_or(&refresh),
        "id_token": v.get("id_token").cloned().unwrap_or(tok.get("id_token").cloned().unwrap_or(serde_json::Value::Null)),
        "account_id": account_id,
        "obtained": now_iso()
    });
    crate::keyring::set("openai-codex", &stored.to_string())?;
    Ok(true)
}

/// True when the stored Codex access token expires within `margin_s`.
pub fn codex_token_stale(margin_s: i64) -> bool {
    let Ok(Some(secret)) = crate::keyring::get("openai-codex") else {
        return false;
    };
    let tok: serde_json::Value = serde_json::from_str(&secret).unwrap_or(serde_json::Value::Null);
    let Some(access) = tok.get("access_token").and_then(|a| a.as_str()) else {
        return false;
    };
    let payload = access.split('.').nth(1).unwrap_or("");
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    match v.get("exp").and_then(|e| e.as_i64()) {
        Some(exp) => exp - chrono::Utc::now().timestamp() < margin_s,
        None => false,
    }
}

/// Codex model catalogue: `GET /backend-api/codex/models?client_version=…`
/// (the version gates which models are listed; a high value returns the
/// current set). Returns slugs; display names and context sizes are logged
/// at debug level only.
pub async fn codex_models(state: &AppState, provider_id: &str) -> Result<Vec<String>, IpcError> {
    let url = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
    let mut headers = BTreeMap::new();
    let req = NetRequest {
        id: String::new(),
        method: "GET".into(),
        url: url.into(),
        headers: BTreeMap::new(),
        body: None,
        provider: Some(provider_id.to_string()),
        timeout_ms: Some(20_000),
        purpose: "provider".into(),
    };
    if codex_token_stale(120) {
        codex_refresh(state).await?;
    }
    inject_auth(state, &req, &mut headers)?;
    let mut rb = state
        .net
        .client
        .get(url)
        // originator/User-Agent come from inject_auth; setting them here too would append a
        // second value rather than replace.
        .timeout(std::time::Duration::from_secs(20));
    for (k, v) in &headers {
        rb = rb.header(k, v);
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| err("NET_OFFLINE", e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(err(
            "PROVIDER_BAD_REQUEST",
            format!(
                "codex model listing failed ({status}): {}",
                text.chars().take(300).collect::<String>()
            ),
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| err("PROVIDER_BAD_REQUEST", e.to_string()))?;
    let mut out = Vec::new();
    for m in v
        .get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default()
    {
        if let Some(slug) = m.get("slug").and_then(|s| s.as_str()) {
            if !out.contains(&slug.to_string()) {
                out.push(slug.to_string());
            }
        }
    }
    Ok(out)
}
