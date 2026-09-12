// SPDX-License-Identifier: Apache-2.0
//! External subprocess sandbox (FR-1011): the only place fluxsmith spawns
//! anything. No shell, no network env, project root as cwd, timeout.

use crate::error::err;
use crate::ipc::IpcError;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub fn run(
    exe: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_s: u64,
) -> Result<Output, IpcError> {
    run_env(exe, args, cwd, timeout_s, &[])
}

/// `run` with extra environment variables for this child only (the process environment is never
/// touched). Later entries win over the defaults set here.
pub fn run_env(
    exe: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_s: u64,
    extra_env: &[(&str, &str)],
) -> Result<Output, IpcError> {
    for a in args {
        if *a == "--" || a.starts_with("--exit-code") {
            return Err(err("BAD_CONFIG", "forbidden argument"));
        }
    }
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("LANG", "C.UTF-8")
        .env("http_proxy", "127.0.0.1:9")
        .env("https_proxy", "127.0.0.1:9")
        .env("HTTP_PROXY", "127.0.0.1:9")
        .env("HTTPS_PROXY", "127.0.0.1:9")
        .env("no_proxy", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| err("KICAD_CLI_MISSING", format!("{}: {e}", exe.display())))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(timeout_s) {
                    let _ = child.kill();
                    return Err(err("NET_TIMEOUT", "external tool timed out"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(err("ROUTER_FAILED", e.to_string())),
        }
    }
    child
        .wait_with_output()
        .map_err(|e| err("ROUTER_FAILED", e.to_string()))
}
