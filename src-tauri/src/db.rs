// SPDX-License-Identifier: Apache-2.0
//! `fluxsmith.db` (docs/workspace-format.md §13). Only Rust opens the
//! connection; the webview sends the closed `DbQuery` enum.

use crate::error::err;
use crate::ipc::{DbQuery, IpcError};
use crate::paths::{app_data_dir, ensure_dir, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const DB_SCHEMA: u32 = 2;

pub struct Db {
    pub conn: Connection,
    pub path: PathBuf,
    pub rebuilt: bool,
}

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL, app_version TEXT NOT NULL, migrated_at TEXT NOT NULL, last_seen_app_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, root_uuid TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, last_opened TEXT NOT NULL, last_mode TEXT NOT NULL DEFAULT 'plan', last_sheet TEXT, policy_override TEXT, cloud_sync_notified INTEGER NOT NULL DEFAULT 0, identity_decision TEXT, last_env_check TEXT, last_turn INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT, kind TEXT NOT NULL, ref TEXT NOT NULL, sha256 TEXT NOT NULL, consent_event_id TEXT NOT NULL, granted_at TEXT NOT NULL, app_version TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS approvals_lookup ON approvals(kind, ref, sha256);
CREATE TABLE IF NOT EXISTS consent_events (id TEXT PRIMARY KEY, project_key TEXT, card_kind TEXT NOT NULL, payload_sha TEXT NOT NULL, ts TEXT NOT NULL, input_kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (project_key TEXT NOT NULL, turn INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, created TEXT NOT NULL, kind TEXT NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(project_key, turn, kind));
CREATE TABLE IF NOT EXISTS external_files (sha256 TEXT PRIMARY KEY, ext TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, source_origin TEXT, source_url TEXT, fetched_at TEXT NOT NULL, last_used TEXT NOT NULL, trust TEXT NOT NULL DEFAULT 'untrusted');
CREATE TABLE IF NOT EXISTS external_refs (sha256 TEXT NOT NULL, project_key TEXT NOT NULL, pointer_path TEXT NOT NULL, PRIMARY KEY(sha256, project_key, pointer_path));
CREATE TABLE IF NOT EXISTS lib_files (path TEXT PRIMARY KEY, nickname TEXT NOT NULL, scope TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (lib_id TEXT PRIMARY KEY, lib_file TEXT NOT NULL, name TEXT NOT NULL, nickname TEXT NOT NULL, units INTEGER NOT NULL, pins INTEGER NOT NULL, default_footprint TEXT, extends TEXT, description TEXT, keywords TEXT, is_power INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(lib_id UNINDEXED, name, keywords, description, tokenize='unicode61 tokenchars ''-_.''');
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, title TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project_key TEXT NOT NULL, turn INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, ts TEXT NOT NULL, compacted_by INTEGER);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS attachments (sha256 TEXT NOT NULL, project_key TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, bound_to TEXT, added_at TEXT NOT NULL, PRIMARY KEY(sha256, project_key));
CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, dims_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compactions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, session_id TEXT NOT NULL, level INTEGER NOT NULL, from_turn INTEGER NOT NULL, to_turn INTEGER NOT NULL, reclaimed INTEGER NOT NULL, block_sha256 TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, plan_id TEXT, plan_version INTEGER, turn INTEGER, step TEXT, role TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, cache_creation INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, retry_of INTEGER, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crashes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, req_id TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parts_cache (lcsc TEXT PRIMARY KEY, mpn TEXT NOT NULL DEFAULT '', package TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', basic INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, price REAL, fetched_at TEXT NOT NULL, last_used TEXT NOT NULL, has_cad INTEGER NOT NULL DEFAULT 0, has_symbol INTEGER NOT NULL DEFAULT 0, has_footprint INTEGER NOT NULL DEFAULT 0, has_step INTEGER NOT NULL DEFAULT 0, datasheet_sha TEXT, pins INTEGER NOT NULL DEFAULT 0);
"#;

pub fn db_path() -> PathBuf {
    app_data_dir().join("fluxsmith.db")
}

impl Db {
    pub fn open(path: &Path, app_version: &str) -> Result<Db, IpcError> {
        if let Some(p) = path.parent() {
            ensure_dir(p)?;
        }
        let mut rebuilt = false;
        let conn = match Self::try_open(path) {
            Ok(c) => c,
            Err(_) => {
                // Corrupt: rename and rebuild empty.
                let corrupt =
                    path.with_extension(format!("corrupt-{}", now_iso().replace(':', "-")));
                let _ = std::fs::rename(path, &corrupt);
                rebuilt = true;
                Self::try_open(path)?
            }
        };
        let mut db = Db {
            conn,
            path: path.to_path_buf(),
            rebuilt,
        };
        db.migrate(app_version)?;
        Ok(db)
    }

    fn try_open(path: &Path) -> Result<Connection, IpcError> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(err("DB_CORRUPT", check));
        }
        Ok(conn)
    }

    pub fn open_memory() -> Result<Db, IpcError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let mut db = Db {
            conn,
            path: PathBuf::from(":memory:"),
            rebuilt: false,
        };
        db.migrate("test")?;
        Ok(db)
    }

    fn migrate(&mut self, app_version: &str) -> Result<(), IpcError> {
        let has_meta: bool = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_meta'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        let current: u32 = if has_meta {
            self.conn
                .query_row("SELECT version FROM schema_meta LIMIT 1", [], |r| r.get(0))
                .optional()?
                .unwrap_or(0)
        } else {
            0
        };
        if current > DB_SCHEMA {
            return Err(err(
                "APP_DATA_TOO_NEW",
                format!("database schema {current} is newer than this app ({DB_SCHEMA})"),
            )
            .with_remediation("restore fluxsmith.db.bak-<ver> or upgrade the app"));
        }
        if current < DB_SCHEMA {
            if current > 0 && self.path.exists() && self.path.to_str() != Some(":memory:") {
                let _ = std::fs::copy(
                    &self.path,
                    self.path.with_extension(format!("db.bak-{current}")),
                );
            }
            self.conn.execute_batch(SCHEMA_V1)?;
            self.conn.execute("DELETE FROM schema_meta", [])?;
            self.conn.execute(
                "INSERT INTO schema_meta(version, app_version, migrated_at, last_seen_app_version) VALUES (?1, ?2, ?3, ?2)",
                params![DB_SCHEMA, app_version, now_iso()],
            )?;
        } else {
            self.conn.execute(
                "UPDATE schema_meta SET last_seen_app_version = ?1",
                params![app_version],
            )?;
        }
        Ok(())
    }

    pub fn last_seen_app_version(&self) -> Option<String> {
        self.conn
            .query_row(
                "SELECT last_seen_app_version FROM schema_meta LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()
    }

    // ------------------------------------------------------------- projects
    pub fn project_upsert(
        &self,
        key: &str,
        root_uuid: &str,
        path: &str,
        name: &str,
    ) -> Result<(), IpcError> {
        self.conn.execute(
            "INSERT INTO projects(key, root_uuid, path, name, last_opened) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET path=excluded.path, name=excluded.name, last_opened=excluded.last_opened",
            params![key, root_uuid, path, name, now_iso()],
        )?;
        Ok(())
    }

    pub fn project_row(&self, key: &str) -> Result<Option<Value>, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT key, root_uuid, path, name, last_opened, last_mode, last_sheet, policy_override, cloud_sync_notified, identity_decision, last_env_check, last_turn, state_json FROM projects WHERE key=?1",
                params![key],
                |r| {
                    Ok(json!({
                        "key": r.get::<_, String>(0)?, "root_uuid": r.get::<_, String>(1)?, "path": r.get::<_, String>(2)?, "name": r.get::<_, String>(3)?,
                        "last_opened": r.get::<_, String>(4)?, "last_mode": r.get::<_, String>(5)?, "last_sheet": r.get::<_, Option<String>>(6)?,
                        "policy_override": r.get::<_, Option<String>>(7)?, "cloud_sync_notified": r.get::<_, i64>(8)? != 0,
                        "identity_decision": r.get::<_, Option<String>>(9)?, "last_env_check": r.get::<_, Option<String>>(10)?,
                        "last_turn": r.get::<_, i64>(11)?, "state": serde_json::from_str::<Value>(&r.get::<_, String>(12)?).unwrap_or(json!({}))
                    }))
                },
            )
            .optional()?)
    }

    pub fn project_set_turn(&self, key: &str, turn: u32) -> Result<(), IpcError> {
        self.conn.execute(
            "UPDATE projects SET last_turn=?2 WHERE key=?1",
            params![key, turn],
        )?;
        Ok(())
    }

    pub fn project_last_turn(&self, key: &str) -> Result<u32, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT last_turn FROM projects WHERE key=?1",
                params![key],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0) as u32)
    }

    /// The most recently opened row with this root uuid (a moved or copied project keeps its uuid).
    pub fn project_by_uuid(&self, root_uuid: &str) -> Result<Option<Value>, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT key, path, identity_decision, last_turn FROM projects WHERE root_uuid=?1 ORDER BY last_opened DESC LIMIT 1",
                params![root_uuid],
                |r| {
                    Ok(json!({
                        "key": r.get::<_, String>(0)?, "path": r.get::<_, String>(1)?,
                        "identity_decision": r.get::<_, Option<String>>(2)?, "last_turn": r.get::<_, i64>(3)?
                    }))
                },
            )
            .optional()?)
    }

    /// The row for this exact root (uuid + path), if the project was opened here before.
    pub fn project_key_for(&self, root_uuid: &str, path: &str) -> Result<Option<String>, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT key FROM projects WHERE root_uuid=?1 AND path=?2 ORDER BY last_opened DESC LIMIT 1",
                params![root_uuid, path],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    pub fn project_identity_set(&self, key: &str, decision: &str) -> Result<(), IpcError> {
        self.conn.execute(
            "UPDATE projects SET identity_decision=?2 WHERE key=?1",
            params![key, decision],
        )?;
        Ok(())
    }

    pub fn projects_recent(&self) -> Result<Vec<Value>, IpcError> {
        let mut st = self.conn.prepare(
            "SELECT key, path, name, last_opened FROM projects ORDER BY last_opened DESC LIMIT 50",
        )?;
        let rows = st.query_map([], |r| {
            let path: String = r.get(1)?;
            Ok(json!({"key": r.get::<_, String>(0)?, "path": path.clone(), "name": r.get::<_, String>(2)?, "last_opened": r.get::<_, String>(3)?, "exists": Path::new(&path).exists()}))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ------------------------------------------------------------ approvals
    pub fn consent_insert(
        &self,
        id: &str,
        project_key: Option<&str>,
        card_kind: &str,
        payload_sha: &str,
        input_kind: &str,
    ) -> Result<(), IpcError> {
        self.conn.execute(
            "INSERT INTO consent_events(id, project_key, card_kind, payload_sha, ts, input_kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, project_key, card_kind, payload_sha, now_iso(), input_kind],
        )?;
        Ok(())
    }

    /// The payload hash a consent event was recorded with; `None` when there is no such event.
    /// A grant that claims to act on a recorded decision is checked against this (`grant_create`).
    pub fn consent_payload_sha(&self, id: &str) -> Result<Option<String>, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT payload_sha FROM consent_events WHERE id=?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    pub fn consent_exists(&self, id: &str) -> Result<bool, IpcError> {
        Ok(self.conn.query_row(
            "SELECT count(*) FROM consent_events WHERE id=?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )? > 0)
    }

    pub fn approval_upsert(
        &self,
        project_key: Option<&str>,
        kind: &str,
        r#ref: &str,
        sha256: &str,
        consent: &str,
        app_version: &str,
    ) -> Result<i64, IpcError> {
        self.conn.execute(
            "INSERT INTO approvals(project_key, kind, ref, sha256, consent_event_id, granted_at, app_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![project_key, kind, r#ref, sha256, consent, now_iso(), app_version],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn approval_check(
        &self,
        project_key: Option<&str>,
        kind: &str,
        r#ref: &str,
        sha256: &str,
    ) -> Result<bool, IpcError> {
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM approvals WHERE kind=?1 AND ref=?2 AND sha256=?3 AND revoked_at IS NULL AND (project_key IS ?4 OR project_key IS NULL)",
            params![kind, r#ref, sha256, project_key],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn approval_list(
        &self,
        project_key: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Vec<Value>, IpcError> {
        let mut st = self.conn.prepare(
            "SELECT id, project_key, kind, ref, sha256, consent_event_id, granted_at, app_version, revoked_at FROM approvals
             WHERE (?1 IS NULL OR project_key IS ?1 OR project_key IS NULL) AND (?2 IS NULL OR kind = ?2) ORDER BY id DESC",
        )?;
        let rows = st.query_map(params![project_key, kind], |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "project_key": r.get::<_, Option<String>>(1)?, "kind": r.get::<_, String>(2)?, "ref": r.get::<_, String>(3)?,
                "sha256": r.get::<_, String>(4)?, "consent_event_id": r.get::<_, String>(5)?, "granted_at": r.get::<_, String>(6)?, "app_version": r.get::<_, String>(7)?, "revoked_at": r.get::<_, Option<String>>(8)?}))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn approval_revoke(&self, id: i64) -> Result<(), IpcError> {
        self.conn.execute(
            "UPDATE approvals SET revoked_at=?2 WHERE id=?1",
            params![id, now_iso()],
        )?;
        Ok(())
    }

    pub fn approved_refs(&self, kind: &str) -> Result<Vec<String>, IpcError> {
        let mut st = self
            .conn
            .prepare("SELECT DISTINCT ref FROM approvals WHERE kind=?1 AND revoked_at IS NULL")?;
        let rows = st.query_map(params![kind], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ---------------------------------------------------------- checkpoints
    pub fn checkpoint_insert(
        &self,
        project_key: &str,
        turn: u32,
        manifest_sha: &str,
        bytes: u64,
        kind: &str,
    ) -> Result<(), IpcError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO checkpoints(project_key, turn, manifest_sha256, bytes, created, kind, pruned, verified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 1)",
            params![project_key, turn, manifest_sha, bytes as i64, now_iso(), kind],
        )?;
        Ok(())
    }

    pub fn checkpoint_list(&self, project_key: &str) -> Result<Vec<Value>, IpcError> {
        let mut st = self.conn.prepare("SELECT project_key, turn, manifest_sha256, bytes, created, kind, pruned, verified FROM checkpoints WHERE project_key=?1 ORDER BY turn")?;
        let rows = st.query_map(params![project_key], |r| {
            Ok(json!({"project_key": r.get::<_, String>(0)?, "turn": r.get::<_, i64>(1)?, "manifest_sha256": r.get::<_, String>(2)?, "bytes": r.get::<_, i64>(3)?,
                "created": r.get::<_, String>(4)?, "kind": r.get::<_, String>(5)?, "pruned": r.get::<_, i64>(6)? != 0, "verified": r.get::<_, i64>(7)? != 0}))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn checkpoint_get(
        &self,
        project_key: &str,
        turn: u32,
        kind: &str,
    ) -> Result<Option<(String, bool)>, IpcError> {
        Ok(self
            .conn
            .query_row("SELECT manifest_sha256, pruned FROM checkpoints WHERE project_key=?1 AND turn=?2 AND kind=?3", params![project_key, turn, kind], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0))
            })
            .optional()?)
    }

    /// `kind` is part of the primary key: a `pre_rollback` snapshot and a turn
    /// checkpoint can share a turn number, and pruning one must not touch the other.
    pub fn checkpoint_mark_pruned(
        &self,
        project_key: &str,
        turn: u32,
        kind: &str,
    ) -> Result<(), IpcError> {
        self.conn.execute(
            "UPDATE checkpoints SET pruned=1 WHERE project_key=?1 AND turn=?2 AND kind=?3",
            params![project_key, turn, kind],
        )?;
        Ok(())
    }

    // ------------------------------------------------------- external files
    pub fn external_upsert(
        &self,
        sha: &str,
        ext: &str,
        ct: &str,
        size: u64,
        origin: Option<&str>,
        url: Option<&str>,
    ) -> Result<(), IpcError> {
        self.conn.execute(
            "INSERT INTO external_files(sha256, ext, content_type, size, source_origin, source_url, fetched_at, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(sha256) DO UPDATE SET last_used=excluded.last_used",
            params![sha, ext, ct, size as i64, origin, url, now_iso()],
        )?;
        Ok(())
    }

    pub fn external_get(&self, sha: &str) -> Result<Option<(String, String, u64)>, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT ext, content_type, size FROM external_files WHERE sha256=?1",
                params![sha],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u64)),
            )
            .optional()?)
    }

    pub fn external_ref(
        &self,
        sha: &str,
        project_key: &str,
        pointer: &str,
    ) -> Result<(), IpcError> {
        self.conn.execute("INSERT OR IGNORE INTO external_refs(sha256, project_key, pointer_path) VALUES (?1, ?2, ?3)", params![sha, project_key, pointer])?;
        Ok(())
    }

    // ---------------------------------------------------------- parts cache
    /// Upsert one shared-library row (shape: `parts_cache::row_from_meta`).
    pub fn parts_cache_upsert(&self, row: &Value) -> Result<(), IpcError> {
        let s = |k: &str| {
            row.get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let b = |k: &str| row.get(k).and_then(|v| v.as_bool()).unwrap_or(false) as i64;
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO parts_cache(lcsc, mpn, package, description, basic, stock, price, fetched_at, last_used, has_cad, has_symbol, has_footprint, has_step, datasheet_sha, pins) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(lcsc) DO UPDATE SET mpn=excluded.mpn, package=excluded.package, description=excluded.description, basic=excluded.basic, stock=excluded.stock, price=excluded.price, fetched_at=excluded.fetched_at, last_used=excluded.last_used, has_cad=excluded.has_cad, has_symbol=excluded.has_symbol, has_footprint=excluded.has_footprint, has_step=excluded.has_step, datasheet_sha=COALESCE(excluded.datasheet_sha, parts_cache.datasheet_sha), pins=excluded.pins",
            params![
                s("lcsc"), s("mpn"), s("package"), s("description"), b("basic"),
                row.get("stock").and_then(|v| v.as_i64()).unwrap_or(0),
                row.get("price_usd").and_then(|v| v.as_f64()),
                if s("fetched_at").is_empty() { now.clone() } else { s("fetched_at") },
                now, b("has_cad"), b("has_symbol"), b("has_footprint"), b("has_step"),
                row.get("datasheet_sha").and_then(|v| v.as_str()),
                row.get("pins").and_then(|v| v.as_i64()).unwrap_or(0),
            ],
        )?;
        Ok(())
    }

    pub fn parts_cache_touch(&self, lcsc: &str) -> Result<(), IpcError> {
        self.conn.execute(
            "UPDATE parts_cache SET last_used=?2 WHERE lcsc=?1",
            params![lcsc, now_iso()],
        )?;
        Ok(())
    }

    /// Rows matching every whitespace-separated term of `query` (LIKE on
    /// lcsc / mpn / package / description), newest use first.
    pub fn parts_cache_list(&self, query: Option<&str>) -> Result<Vec<Value>, IpcError> {
        let terms: Vec<String> = query
            .unwrap_or("")
            .split_whitespace()
            .map(|t| format!("%{}%", t.replace('%', "")))
            .collect();
        let mut sql = String::from("SELECT lcsc, mpn, package, description, basic, stock, price, fetched_at, last_used, has_cad, has_symbol, has_footprint, has_step, datasheet_sha, pins FROM parts_cache");
        for i in 0..terms.len() {
            sql.push_str(if i == 0 { " WHERE " } else { " AND " });
            let n = i + 1;
            sql.push_str(&format!(
                "(lcsc LIKE ?{n} OR mpn LIKE ?{n} OR package LIKE ?{n} OR description LIKE ?{n})"
            ));
        }
        sql.push_str(" ORDER BY last_used DESC LIMIT 500");
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(terms.iter()), |r| {
            Ok(json!({
                "lcsc": r.get::<_, String>(0)?, "mpn": r.get::<_, String>(1)?, "package": r.get::<_, String>(2)?,
                "description": r.get::<_, String>(3)?, "basic": r.get::<_, i64>(4)? != 0, "stock": r.get::<_, i64>(5)?,
                "price_usd": r.get::<_, Option<f64>>(6)?, "fetched_at": r.get::<_, String>(7)?, "last_used": r.get::<_, String>(8)?,
                "has_cad": r.get::<_, i64>(9)? != 0, "has_symbol": r.get::<_, i64>(10)? != 0, "has_footprint": r.get::<_, i64>(11)? != 0,
                "has_step": r.get::<_, i64>(12)? != 0, "datasheet_sha": r.get::<_, Option<String>>(13)?, "pins": r.get::<_, i64>(14)?,
            }))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn parts_cache_forget(&self, lcsc: &str) -> Result<(), IpcError> {
        self.conn
            .execute("DELETE FROM parts_cache WHERE lcsc=?1", params![lcsc])?;
        Ok(())
    }

    pub fn parts_cache_clear(&self) -> Result<(), IpcError> {
        self.conn.execute("DELETE FROM parts_cache", [])?;
        Ok(())
    }

    pub fn parts_cache_count(&self) -> i64 {
        self.conn
            .query_row("SELECT count(*) FROM parts_cache", [], |r| r.get(0))
            .unwrap_or(0)
    }

    // ------------------------------------------------------------- sessions
    pub fn query(&self, q: DbQuery, app_version: &str) -> Result<Value, IpcError> {
        match q {
            DbQuery::SessionCreate { project_key, title } => {
                let id = uuid::Uuid::new_v4().to_string();
                let now = now_iso();
                self.conn.execute("INSERT INTO sessions(session_id, project_key, title, created, updated) VALUES (?1, ?2, ?3, ?4, ?4)", params![id, project_key, title, now])?;
                Ok(
                    json!({"session_id": id, "project_key": project_key, "title": title, "created": now}),
                )
            }
            DbQuery::SessionList { project_key } => {
                let mut st = self.conn.prepare("SELECT session_id, title, created, updated, (SELECT count(*) FROM messages m WHERE m.session_id = s.session_id) FROM sessions s WHERE project_key=?1 ORDER BY updated DESC")?;
                let rows = st.query_map(params![project_key], |r| Ok(json!({"session_id": r.get::<_, String>(0)?, "title": r.get::<_, Option<String>>(1)?, "created": r.get::<_, String>(2)?, "updated": r.get::<_, String>(3)?, "messages": r.get::<_, i64>(4)?})))?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::SessionRename { session_id, title } => {
                self.conn.execute(
                    "UPDATE sessions SET title=?2, updated=?3 WHERE session_id=?1",
                    params![session_id, title, now_iso()],
                )?;
                Ok(Value::Null)
            }
            DbQuery::SessionDelete { session_id } => {
                self.conn.execute(
                    "DELETE FROM messages WHERE session_id=?1",
                    params![session_id],
                )?;
                self.conn.execute(
                    "DELETE FROM compactions WHERE session_id=?1",
                    params![session_id],
                )?;
                self.conn.execute(
                    "DELETE FROM sessions WHERE session_id=?1",
                    params![session_id],
                )?;
                Ok(Value::Null)
            }
            DbQuery::MessageAppend {
                session_id,
                turn,
                role,
                content,
            } => {
                let pk: String = self
                    .conn
                    .query_row(
                        "SELECT project_key FROM sessions WHERE session_id=?1",
                        params![session_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| err("NOT_FOUND", "session"))?;
                self.conn.execute(
                    "INSERT INTO messages(session_id, project_key, turn, role, content, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![session_id, pk, turn, role, serde_json::to_string(&content)?, now_iso()],
                )?;
                self.conn.execute(
                    "UPDATE sessions SET updated=?2 WHERE session_id=?1",
                    params![session_id, now_iso()],
                )?;
                Ok(json!({"id": self.conn.last_insert_rowid()}))
            }
            DbQuery::MessageList {
                session_id,
                after_id,
                limit,
            } => {
                let mut st = self.conn.prepare("SELECT id, turn, role, content, ts, compacted_by FROM messages WHERE session_id=?1 AND id > ?2 ORDER BY id LIMIT ?3")?;
                let rows = st.query_map(params![session_id, after_id.unwrap_or(0), limit.unwrap_or(5000)], |r| {
                    Ok(json!({"id": r.get::<_, i64>(0)?, "turn": r.get::<_, i64>(1)?, "role": r.get::<_, String>(2)?, "content": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(Value::Null), "ts": r.get::<_, String>(4)?, "compacted_by": r.get::<_, Option<i64>>(5)?}))
                })?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::MessageSearch {
                project_key,
                query,
                limit,
            } => {
                let pat = format!("%{}%", query.replace('%', "\\%"));
                let mut st = self.conn.prepare("SELECT id, session_id, turn, role, substr(content, 1, 300), ts FROM messages WHERE project_key=?1 AND content LIKE ?2 ESCAPE '\\' ORDER BY id DESC LIMIT ?3")?;
                let rows = st.query_map(params![project_key, pat, limit.unwrap_or(50)], |r| {
                    Ok(json!({"id": r.get::<_, i64>(0)?, "session_id": r.get::<_, String>(1)?, "turn": r.get::<_, i64>(2)?, "role": r.get::<_, String>(3)?, "snippet": r.get::<_, String>(4)?, "ts": r.get::<_, String>(5)?}))
                })?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::MessagesCompact {
                session_id,
                from_turn: range_from,
                to_turn: range_to,
                keep_turns,
                min_task,
                compaction,
            } => {
                let pk: String = self
                    .conn
                    .query_row(
                        "SELECT project_key FROM sessions WHERE session_id=?1",
                        params![session_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| err("NOT_FOUND", "session"))?;
                let level = compaction
                    .get("level")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(2);
                let from_turn = compaction
                    .get("from_turn")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let to_turn = compaction
                    .get("to_turn")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let reclaimed = compaction
                    .get("reclaimed")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let block = compaction
                    .get("block_sha256")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                self.conn.execute(
                    "INSERT INTO compactions(project_key, session_id, level, from_turn, to_turn, reclaimed, block_sha256, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![pk, session_id, level as i64, from_turn as i64, to_turn as i64, reclaimed as i64, block, now_iso()],
                )?;
                let cid = self.conn.last_insert_rowid();
                // The block messages that replace the summarised range are appended by the caller (they are
                // ordinary history rows), so only the marking happens here.
                let keep = keep_turns
                    .iter()
                    .map(|t| t.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "UPDATE messages SET compacted_by=?1 WHERE session_id=?2 AND compacted_by IS NULL AND turn BETWEEN ?3 AND ?4 \
                     AND role != 'compaction' AND turn NOT IN ({}) \
                     AND COALESCE(json_extract(content, '$.meta.kind'), '') NOT IN ('marker', 'plan_snapshot') \
                     AND COALESCE(json_extract(content, '$.meta.task'), 0) <= ?5",
                    if keep.is_empty() { "-1".to_string() } else { keep }
                );
                let marked = self.conn.execute(
                    &sql,
                    params![cid, session_id, range_from, range_to, min_task],
                )?;
                Ok(json!({"compaction_id": cid, "marked": marked}))
            }
            DbQuery::MessagesExport { session_id } => {
                let mut st = self.conn.prepare("SELECT id, turn, role, content, ts FROM messages WHERE session_id=?1 ORDER BY id")?;
                let rows = st.query_map(params![session_id], |r| Ok(json!({"id": r.get::<_, i64>(0)?, "turn": r.get::<_, i64>(1)?, "role": r.get::<_, String>(2)?, "content": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(Value::Null), "ts": r.get::<_, String>(4)?})))?;
                let lines: Vec<String> =
                    rows.filter_map(|r| r.ok()).map(|v| v.to_string()).collect();
                Ok(json!({"jsonl": lines.join("\n")}))
            }
            DbQuery::ApprovalUpsert {
                project_key,
                kind_,
                r#ref,
                sha256,
                consent_event_id,
            } => {
                if !self.consent_exists(&consent_event_id)? {
                    return Err(err("CONSENT_REQUIRED", "unknown consent event"));
                }
                let id = self.approval_upsert(
                    Some(&project_key),
                    &kind_,
                    &r#ref,
                    &sha256,
                    &consent_event_id,
                    app_version,
                )?;
                Ok(json!({"id": id}))
            }
            DbQuery::ApprovalList { project_key, kind_ } => Ok(Value::Array(
                self.approval_list(project_key.as_deref(), kind_.as_deref())?,
            )),
            DbQuery::ApprovalRevoke { id } => {
                self.approval_revoke(id)?;
                Ok(Value::Null)
            }
            DbQuery::ApprovalCheck {
                project_key,
                kind_,
                r#ref,
                sha256,
            } => Ok(json!(self.approval_check(
                project_key.as_deref(),
                &kind_,
                &r#ref,
                &sha256
            )?)),
            DbQuery::MetricAppend {
                project_key,
                kind_,
                value,
                dims,
            } => {
                self.conn.execute("INSERT INTO metrics(project_key, ts, kind, value, dims_json) VALUES (?1, ?2, ?3, ?4, ?5)", params![project_key, now_iso(), kind_, value, serde_json::to_string(&dims)?])?;
                Ok(Value::Null)
            }
            DbQuery::MetricSummary { project_key } => {
                let mut st = self.conn.prepare("SELECT kind, count(*), avg(value), sum(value), min(ts), max(ts) FROM metrics WHERE (?1 IS NULL OR project_key=?1) GROUP BY kind")?;
                let rows = st.query_map(params![project_key], |r| Ok(json!({"kind": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)?, "avg": r.get::<_, f64>(2)?, "sum": r.get::<_, f64>(3)?, "first": r.get::<_, String>(4)?, "last": r.get::<_, String>(5)?})))?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::ModelCallAppend { project_key, call } => {
                let g = |k: &str| call.get(k).cloned().unwrap_or(Value::Null);
                self.conn.execute(
                    "INSERT INTO model_calls(project_key, plan_id, plan_version, turn, step, role, model, input, cache_creation, cache_read, output, cost_usd, latency_ms, retry_of, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        project_key,
                        g("plan_id").as_str(),
                        g("plan_version").as_i64(),
                        g("turn").as_i64(),
                        g("step").as_str(),
                        g("role").as_str().unwrap_or("lead"),
                        g("model").as_str().unwrap_or(""),
                        g("input").as_i64().unwrap_or(0),
                        g("cache_creation").as_i64().unwrap_or(0),
                        g("cache_read").as_i64().unwrap_or(0),
                        g("output").as_i64().unwrap_or(0),
                        g("cost_usd").as_f64().unwrap_or(0.0),
                        g("latency_ms").as_i64().unwrap_or(0),
                        g("retry_of").as_i64(),
                        now_iso()
                    ],
                )?;
                Ok(json!({"id": self.conn.last_insert_rowid()}))
            }
            DbQuery::ModelCallSummary {
                project_key,
                plan_id,
            } => {
                let mut st = self.conn.prepare(
                    "SELECT role, model, count(*), sum(input), sum(cache_creation), sum(cache_read), sum(output), sum(cost_usd), avg(latency_ms) FROM model_calls WHERE project_key=?1 AND (?2 IS NULL OR plan_id=?2) GROUP BY role, model",
                )?;
                let rows = st.query_map(params![project_key, plan_id], |r| {
                    let input: i64 = r.get(3)?;
                    let cr: i64 = r.get(5)?;
                    let cc: i64 = r.get(4)?;
                    let denom = input + cr + cc;
                    Ok(json!({"role": r.get::<_, String>(0)?, "model": r.get::<_, String>(1)?, "calls": r.get::<_, i64>(2)?, "input": input, "cache_creation": cc, "cache_read": cr, "output": r.get::<_, i64>(6)?, "cost_usd": r.get::<_, f64>(7)?, "latency_ms": r.get::<_, f64>(8)?, "cache_hit_ratio": if denom > 0 { cr as f64 / denom as f64 } else { 0.0 }}))
                })?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::ModelCallByTurn {
                project_key,
                from_turn,
                to_turn,
            } => {
                // One row per (turn, role), summed in SQL and ordered (turn, role) so a replay emits
                // the same events in the same order every time. Rows without a turn (a call recorded
                // outside a turn) belong to no turn block and are left out.
                let mut st = self.conn.prepare(
                    "SELECT turn, role, sum(input), sum(cache_creation), sum(cache_read), sum(output), sum(cost_usd), count(*) FROM model_calls WHERE project_key=?1 AND turn IS NOT NULL AND (?2 IS NULL OR turn>=?2) AND (?3 IS NULL OR turn<=?3) GROUP BY turn, role ORDER BY turn, role",
                )?;
                let rows = st.query_map(params![project_key, from_turn, to_turn], |r| {
                    Ok(json!({"turn": r.get::<_, i64>(0)?, "role": r.get::<_, String>(1)?, "input": r.get::<_, i64>(2)?, "cache_creation": r.get::<_, i64>(3)?, "cache_read": r.get::<_, i64>(4)?, "output": r.get::<_, i64>(5)?, "cost_usd": r.get::<_, f64>(6)?, "calls": r.get::<_, i64>(7)?}))
                })?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::ModelCallExport { project_key } => {
                let mut st = self.conn.prepare("SELECT id, plan_id, plan_version, turn, step, role, model, input, cache_creation, cache_read, output, cost_usd, latency_ms, retry_of, ts FROM model_calls WHERE project_key=?1 ORDER BY id")?;
                let rows = st.query_map(params![project_key], |r| {
                    Ok(json!({"id": r.get::<_, i64>(0)?, "plan_id": r.get::<_, Option<String>>(1)?, "plan_version": r.get::<_, Option<i64>>(2)?, "turn": r.get::<_, Option<i64>>(3)?, "step": r.get::<_, Option<String>>(4)?, "role": r.get::<_, String>(5)?, "model": r.get::<_, String>(6)?, "input": r.get::<_, i64>(7)?, "cache_creation": r.get::<_, i64>(8)?, "cache_read": r.get::<_, i64>(9)?, "output": r.get::<_, i64>(10)?, "cost_usd": r.get::<_, f64>(11)?, "latency_ms": r.get::<_, i64>(12)?, "retry_of": r.get::<_, Option<i64>>(13)?, "ts": r.get::<_, String>(14)?}))
                })?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::AttachmentUpsert {
                project_key,
                sha256,
                kind_,
                label,
                bound_to,
            } => {
                self.conn.execute(
                    "INSERT INTO attachments(sha256, project_key, kind, label, bound_to, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(sha256, project_key) DO UPDATE SET label=excluded.label, bound_to=COALESCE(excluded.bound_to, attachments.bound_to)",
                    params![sha256, project_key, kind_, label, bound_to, now_iso()],
                )?;
                Ok(Value::Null)
            }
            DbQuery::AttachmentList { project_key } => {
                let mut st = self.conn.prepare("SELECT a.sha256, a.kind, a.label, a.bound_to, a.added_at, e.size, e.content_type FROM attachments a LEFT JOIN external_files e ON e.sha256 = a.sha256 WHERE a.project_key=?1 ORDER BY a.added_at DESC")?;
                let rows = st.query_map(params![project_key], |r| Ok(json!({"sha256": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "label": r.get::<_, String>(2)?, "bound_to": r.get::<_, Option<String>>(3)?, "added_at": r.get::<_, String>(4)?, "size": r.get::<_, Option<i64>>(5)?, "content_type": r.get::<_, Option<String>>(6)?})))?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::AttachmentBind {
                project_key,
                sha256,
                bound_to,
            } => {
                self.conn.execute(
                    "UPDATE attachments SET bound_to=?3 WHERE project_key=?1 AND sha256=?2",
                    params![project_key, sha256, bound_to],
                )?;
                Ok(Value::Null)
            }
            DbQuery::AttachmentRemove {
                project_key,
                sha256,
            } => {
                self.conn.execute(
                    "DELETE FROM attachments WHERE project_key=?1 AND sha256=?2",
                    params![project_key, sha256],
                )?;
                Ok(Value::Null)
            }
            DbQuery::CompactionAppend {
                project_key,
                session_id,
                level,
                from_turn,
                to_turn,
                reclaimed,
                block_sha256,
            } => {
                self.conn.execute(
                    "INSERT INTO compactions(project_key, session_id, level, from_turn, to_turn, reclaimed, block_sha256, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![project_key, session_id, level, from_turn, to_turn, reclaimed as i64, block_sha256, now_iso()],
                )?;
                Ok(json!({"id": self.conn.last_insert_rowid()}))
            }
            DbQuery::CompactionList { session_id } => {
                let mut st = self.conn.prepare("SELECT id, level, from_turn, to_turn, reclaimed, block_sha256, ts FROM compactions WHERE session_id=?1 ORDER BY id")?;
                let rows = st.query_map(params![session_id], |r| Ok(json!({"id": r.get::<_, i64>(0)?, "level": r.get::<_, i64>(1)?, "from_turn": r.get::<_, i64>(2)?, "to_turn": r.get::<_, i64>(3)?, "reclaimed": r.get::<_, i64>(4)?, "block_sha256": r.get::<_, String>(5)?, "ts": r.get::<_, String>(6)?})))?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::ProjectState { project_key } => {
                Ok(self.project_row(&project_key)?.unwrap_or(Value::Null))
            }
            DbQuery::ProjectStateSet { project_key, patch } => {
                if let Some(o) = patch.as_object() {
                    for (k, v) in o {
                        match k.as_str() {
                            "last_mode" => {
                                self.conn.execute(
                                    "UPDATE projects SET last_mode=?2 WHERE key=?1",
                                    params![project_key, v.as_str().unwrap_or("plan")],
                                )?;
                            }
                            "last_sheet" => {
                                self.conn.execute(
                                    "UPDATE projects SET last_sheet=?2 WHERE key=?1",
                                    params![project_key, v.as_str()],
                                )?;
                            }
                            "policy_override" => {
                                self.conn.execute(
                                    "UPDATE projects SET policy_override=?2 WHERE key=?1",
                                    params![project_key, v.as_str()],
                                )?;
                            }
                            "cloud_sync_notified" => {
                                self.conn.execute(
                                    "UPDATE projects SET cloud_sync_notified=?2 WHERE key=?1",
                                    params![project_key, v.as_bool().unwrap_or(false) as i64],
                                )?;
                            }
                            "identity_decision" => {
                                self.conn.execute(
                                    "UPDATE projects SET identity_decision=?2 WHERE key=?1",
                                    params![project_key, v.as_str()],
                                )?;
                            }
                            "last_env_check" => {
                                self.conn.execute(
                                    "UPDATE projects SET last_env_check=?2 WHERE key=?1",
                                    params![project_key, v.as_str()],
                                )?;
                            }
                            _ => {
                                let mut state: Value = self
                                    .conn
                                    .query_row(
                                        "SELECT state_json FROM projects WHERE key=?1",
                                        params![project_key],
                                        |r| r.get::<_, String>(0),
                                    )
                                    .optional()?
                                    .and_then(|s| serde_json::from_str(&s).ok())
                                    .unwrap_or(json!({}));
                                state[k] = v.clone();
                                self.conn.execute(
                                    "UPDATE projects SET state_json=?2 WHERE key=?1",
                                    params![project_key, state.to_string()],
                                )?;
                            }
                        }
                    }
                }
                Ok(self.project_row(&project_key)?.unwrap_or(Value::Null))
            }
            DbQuery::ProjectForget { project_key } => {
                for t in [
                    "messages",
                    "sessions",
                    "attachments",
                    "metrics",
                    "compactions",
                    "model_calls",
                    "checkpoints",
                    "external_refs",
                    "approvals",
                    "consent_events",
                ] {
                    self.conn.execute(
                        &format!("DELETE FROM {t} WHERE project_key=?1"),
                        params![project_key],
                    )?;
                }
                self.conn
                    .execute("DELETE FROM projects WHERE key=?1", params![project_key])?;
                Ok(Value::Null)
            }
            DbQuery::OrphanProjects {} => {
                let rows = self.projects_recent()?;
                Ok(Value::Array(
                    rows.into_iter()
                        .filter(|r| r.get("exists").and_then(|e| e.as_bool()) == Some(false))
                        .collect(),
                ))
            }
            DbQuery::Storage {} => Ok(crate::diag::storage_report(self)?),
            DbQuery::StorageClear { area } => {
                crate::diag::storage_clear(self, &area)?;
                Ok(crate::diag::storage_report(self)?)
            }
            DbQuery::CrashList {} => {
                let mut st = self.conn.prepare(
                    "SELECT id, ts, req_id, kind, message FROM crashes ORDER BY id DESC LIMIT 100",
                )?;
                let rows = st.query_map([], |r| Ok(json!({"id": r.get::<_, i64>(0)?, "ts": r.get::<_, String>(1)?, "req_id": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?, "message": r.get::<_, String>(4)?})))?;
                Ok(Value::Array(rows.filter_map(|r| r.ok()).collect()))
            }
            DbQuery::PartsCacheList { query } => {
                Ok(Value::Array(self.parts_cache_list(query.as_deref())?))
            }
            DbQuery::PartsCacheForget { lcsc } => {
                let lcsc = easyeda_convert::normalize_lcsc(&lcsc);
                let d = crate::parts_cache::dir(&lcsc);
                if d.exists() {
                    std::fs::remove_dir_all(&d).map_err(|e| crate::error::io_err(&d, e))?;
                }
                self.parts_cache_forget(&lcsc)?;
                Ok(json!({"forgotten": lcsc}))
            }
            DbQuery::LibIndexState {} => {
                let files: i64 =
                    self.conn
                        .query_row("SELECT count(*) FROM lib_files", [], |r| r.get(0))?;
                let symbols: i64 =
                    self.conn
                        .query_row("SELECT count(*) FROM symbols", [], |r| r.get(0))?;
                let last: Option<String> =
                    self.conn
                        .query_row("SELECT max(indexed_at) FROM lib_files", [], |r| r.get(0))?;
                Ok(json!({"files": files, "symbols": symbols, "indexed_at": last}))
            }
        }
    }

    pub fn crash_insert(&self, req_id: &str, kind: &str, message: &str) -> Result<(), IpcError> {
        self.conn.execute(
            "INSERT INTO crashes(ts, req_id, kind, message) VALUES (?1, ?2, ?3, ?4)",
            params![now_iso(), req_id, kind, crate::log::mask(message)],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------- symbol index
    pub fn lib_file_state(&self, path: &str) -> Result<Option<(i64, i64)>, IpcError> {
        Ok(self
            .conn
            .query_row(
                "SELECT mtime, size FROM lib_files WHERE path=?1",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    pub fn lib_file_replace(
        &mut self,
        path: &str,
        nickname: &str,
        scope: &str,
        mtime: i64,
        size: i64,
        symbols: &[sch_model::LibSymbol],
    ) -> Result<(), IpcError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM symbols_fts WHERE lib_id IN (SELECT lib_id FROM symbols WHERE lib_file=?1)", params![path])?;
        tx.execute("DELETE FROM symbols WHERE lib_file=?1", params![path])?;
        tx.execute(
            "INSERT OR REPLACE INTO lib_files(path, nickname, scope, mtime, size, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![path, nickname, scope, mtime, size, now_iso()],
        )?;
        for s in symbols {
            let name = s.id.split_once(':').map(|(_, n)| n).unwrap_or(&s.id);
            let desc = s.property("Description").unwrap_or("");
            let kw = s.property("ki_keywords").unwrap_or("");
            let fp = s.property("Footprint").unwrap_or("");
            tx.execute(
                "INSERT OR REPLACE INTO symbols(lib_id, lib_file, name, nickname, units, pins, default_footprint, extends, description, keywords, is_power) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![s.id, path, name, nickname, s.unit_count, s.pins.len() as i64, fp, s.extends, desc, kw, s.is_power as i64],
            )?;
            tx.execute("INSERT INTO symbols_fts(lib_id, name, keywords, description) VALUES (?1, ?2, ?3, ?4)", params![s.id, name, kw, desc])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn lib_files_remove_missing(&self, present: &[String]) -> Result<(), IpcError> {
        let mut st = self.conn.prepare("SELECT path FROM lib_files")?;
        let all: Vec<String> = st
            .query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        for p in all {
            if !present.contains(&p) {
                self.conn.execute("DELETE FROM symbols_fts WHERE lib_id IN (SELECT lib_id FROM symbols WHERE lib_file=?1)", params![p])?;
                self.conn
                    .execute("DELETE FROM symbols WHERE lib_file=?1", params![p])?;
                self.conn
                    .execute("DELETE FROM lib_files WHERE path=?1", params![p])?;
            }
        }
        Ok(())
    }

    pub fn lib_index_clear(&self) -> Result<(), IpcError> {
        self.conn.execute_batch(
            "DELETE FROM symbols_fts; DELETE FROM symbols; DELETE FROM lib_files;",
        )?;
        Ok(())
    }

    /// Symbol search: exact lib_id, else FTS prefix match, fixed ordering.
    pub fn symbol_search(
        &self,
        query: Option<&str>,
        lib_id: Option<&str>,
        category: Option<&str>,
        pins: Option<u32>,
        limit: u32,
    ) -> Result<(Vec<Value>, i64), IpcError> {
        let limit = limit.clamp(1, 20) as i64;
        let row = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
            Ok(
                json!({"lib_id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "description": r.get::<_, Option<String>>(2)?, "keywords": r.get::<_, Option<String>>(3)?, "units": r.get::<_, i64>(4)?, "pins": r.get::<_, i64>(5)?, "default_footprint": r.get::<_, Option<String>>(6)?, "nickname": r.get::<_, String>(7)?, "is_power": r.get::<_, i64>(8)? != 0}),
            )
        };
        const COLS: &str = "s.lib_id, s.name, s.description, s.keywords, s.units, s.pins, s.default_footprint, s.nickname, s.is_power";
        if let Some(id) = lib_id {
            let mut st = self.conn.prepare(&format!("SELECT {COLS} FROM symbols s WHERE s.lib_id = ?1 OR s.lib_id LIKE ?2 ORDER BY s.lib_id LIMIT ?3"))?;
            let rows: Vec<Value> = st
                .query_map(params![id, format!("%:{id}"), limit], row)?
                .filter_map(|r| r.ok())
                .collect();
            let total = rows.len() as i64;
            return Ok((rows, total));
        }
        let q = query.unwrap_or("").trim();
        let cat = category.map(|c| format!("{c}:%"));
        let pin_filter = pins.map(|p| p as i64);
        if q.is_empty() {
            let mut st = self.conn.prepare(&format!("SELECT {COLS} FROM symbols s WHERE (?1 IS NULL OR s.lib_id LIKE ?1) AND (?2 IS NULL OR s.pins = ?2) ORDER BY s.lib_id LIMIT ?3"))?;
            let rows: Vec<Value> = st
                .query_map(params![cat, pin_filter, limit], row)?
                .filter_map(|r| r.ok())
                .collect();
            let total: i64 = self.conn.query_row("SELECT count(*) FROM symbols s WHERE (?1 IS NULL OR s.lib_id LIKE ?1) AND (?2 IS NULL OR s.pins = ?2)", params![cat, pin_filter], |r| r.get(0))?;
            return Ok((rows, total));
        }
        // FTS prefix query: each token becomes `tok*`; quote to avoid syntax errors.
        let fts: Vec<String> = q
            .split_whitespace()
            .map(|t| format!("\"{}\"*", t.replace('"', "")))
            .collect();
        let fts_q = fts.join(" ");
        let sql = format!("SELECT {COLS} FROM symbols_fts f JOIN symbols s ON s.lib_id = f.lib_id WHERE symbols_fts MATCH ?1 AND (?2 IS NULL OR s.lib_id LIKE ?2) AND (?3 IS NULL OR s.pins = ?3) ORDER BY bm25(symbols_fts), s.lib_id LIMIT ?4");
        let mut st = self.conn.prepare(&sql)?;
        let rows: Vec<Value> = match st.query_map(params![fts_q, cat, pin_filter, limit], row) {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        };
        let total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM symbols_fts f JOIN symbols s ON s.lib_id = f.lib_id WHERE symbols_fts MATCH ?1 AND (?2 IS NULL OR s.lib_id LIKE ?2) AND (?3 IS NULL OR s.pins = ?3)", params![fts_q, cat, pin_filter], |r| r.get(0))
            .unwrap_or(rows.len() as i64);
        Ok((rows, total))
    }

    pub fn symbol_count(&self) -> i64 {
        self.conn
            .query_row("SELECT count(*) FROM symbols", [], |r| r.get(0))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_compact_marks_by_turn_range_with_protected_exclusions() {
        let db = Db::open_memory().unwrap();
        db.project_upsert("k1", "u1", "/tmp/p", "p").unwrap();
        let v = db
            .query(
                DbQuery::SessionCreate {
                    project_key: "k1".into(),
                    title: None,
                },
                "test",
            )
            .unwrap();
        let sid = v["session_id"].as_str().unwrap().to_string();
        let append = |turn: i64, kind: &str, task: i64| {
            db.query(
                DbQuery::MessageAppend {
                    session_id: sid.clone(),
                    turn: turn as u32,
                    role: "user".into(),
                    content: json!({"role": "user", "content": [], "meta": {"turn": turn, "task": task, "kind": kind}}),
                },
                "test",
            )
            .unwrap();
        };
        append(1, "prose", 1); // summarised
        append(2, "marker", 2); // never marked
        append(2, "prose", 2); // summarised
        append(3, "prose", 3); // hard-stop turn: kept
        append(4, "prose", 5); // recent task: kept
        append(5, "prose", 6); // current turn (outside range): kept
        let r = db
            .query(
                DbQuery::MessagesCompact {
                    session_id: sid.clone(),
                    from_turn: 1,
                    to_turn: 4,
                    keep_turns: vec![3, 5],
                    min_task: 4,
                    compaction: json!({"level": 2, "from_turn": 1, "to_turn": 4, "reclaimed": 100, "block_sha256": "x"}),
                },
                "test",
            )
            .unwrap();
        assert_eq!(r["marked"].as_u64(), Some(2));
        let list = db
            .query(
                DbQuery::MessageList {
                    session_id: sid.clone(),
                    after_id: None,
                    limit: None,
                },
                "test",
            )
            .unwrap();
        let visible: Vec<(i64, String)> = list
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["compacted_by"].is_null())
            .map(|m| {
                (
                    m["turn"].as_i64().unwrap(),
                    m["content"]["meta"]["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            visible,
            vec![
                (2, "marker".to_string()),
                (3, "prose".to_string()),
                (4, "prose".to_string()),
                (5, "prose".to_string())
            ]
        );
    }

    #[test]
    fn migrate_and_basic_queries() {
        let db = Db::open_memory().unwrap();
        db.project_upsert("k1", "u1", "/tmp/p", "p").unwrap();
        let v = db
            .query(
                DbQuery::SessionCreate {
                    project_key: "k1".into(),
                    title: None,
                },
                "test",
            )
            .unwrap();
        let sid = v["session_id"].as_str().unwrap().to_string();
        db.query(
            DbQuery::MessageAppend {
                session_id: sid.clone(),
                turn: 1,
                role: "user".into(),
                content: json!({"text": "hello world"}),
            },
            "test",
        )
        .unwrap();
        let list = db
            .query(
                DbQuery::MessageList {
                    session_id: sid.clone(),
                    after_id: None,
                    limit: None,
                },
                "test",
            )
            .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        let found = db
            .query(
                DbQuery::MessageSearch {
                    project_key: "k1".into(),
                    query: "hello".into(),
                    limit: None,
                },
                "test",
            )
            .unwrap();
        assert_eq!(found.as_array().unwrap().len(), 1);
        db.consent_insert("c1", Some("k1"), "plan", "abc", "click")
            .unwrap();
        db.query(
            DbQuery::ApprovalUpsert {
                project_key: "k1".into(),
                kind_: "plan".into(),
                r#ref: "plan:1".into(),
                sha256: "abc".into(),
                consent_event_id: "c1".into(),
            },
            "test",
        )
        .unwrap();
        assert_eq!(
            db.query(
                DbQuery::ApprovalCheck {
                    project_key: Some("k1".into()),
                    kind_: "plan".into(),
                    r#ref: "plan:1".into(),
                    sha256: "abc".into()
                },
                "test"
            )
            .unwrap(),
            json!(true)
        );
        assert!(db
            .query(
                DbQuery::ApprovalUpsert {
                    project_key: "k1".into(),
                    kind_: "plan".into(),
                    r#ref: "x".into(),
                    sha256: "y".into(),
                    consent_event_id: "nope".into()
                },
                "test"
            )
            .is_err());
        db.query(
            DbQuery::ProjectStateSet {
                project_key: "k1".into(),
                patch: json!({"last_mode": "build", "custom": 3}),
            },
            "test",
        )
        .unwrap();
        let st = db
            .query(
                DbQuery::ProjectState {
                    project_key: "k1".into(),
                },
                "test",
            )
            .unwrap();
        assert_eq!(st["last_mode"], "build");
        assert_eq!(st["state"]["custom"], 3);
    }

    #[test]
    fn symbol_index_search() {
        let mut db = Db::open_memory().unwrap();
        let sym = sch_model::LibSymbol {
            id: "Device:R".into(),
            pins: vec![],
            unit_count: 1,
            is_power: false,
            power_scope: Default::default(),
            extends: None,
            properties: vec![
                ("Description".into(), "Resistor".into()),
                ("ki_keywords".into(), "R res resistor".into()),
            ],
        };
        db.lib_file_replace("/x/Device.kicad_sym", "Device", "global", 1, 1, &[sym])
            .unwrap();
        let (rows, total) = db
            .symbol_search(Some("resis"), None, None, None, 20)
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows[0]["lib_id"], "Device:R");
        let (rows, _) = db
            .symbol_search(None, Some("Device:R"), None, None, 20)
            .unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn model_calls_aggregate_per_turn_and_role() {
        let db = Db::open_memory().unwrap();
        db.project_upsert("k1", "u1", "/tmp/p", "p").unwrap();
        let append = |project: &str,
                      turn: i64,
                      role: &str,
                      input: i64,
                      cc: i64,
                      cr: i64,
                      out: i64,
                      cost: f64| {
            db.query(
                DbQuery::ModelCallAppend {
                    project_key: project.into(),
                    call: json!({"turn": turn, "step": "s0", "role": role, "model": "m", "input": input, "cache_creation": cc, "cache_read": cr, "output": out, "cost_usd": cost, "latency_ms": 5}),
                },
                "test",
            )
            .unwrap();
        };
        append("k1", 1, "lead", 100, 0, 900, 50, 0.01);
        append("k1", 1, "lead", 10, 20, 30, 5, 0.02);
        append("k1", 1, "drafter", 200, 100, 0, 300, 0.05);
        append("k1", 2, "lead", 1, 2, 3, 4, 0.5);
        // Another project must not leak into the aggregate, and a call outside a turn has no turn block.
        append("k2", 1, "lead", 999, 999, 999, 999, 9.0);
        db.query(
            DbQuery::ModelCallAppend {
                project_key: "k1".into(),
                call: json!({"role": "probe", "model": "m", "input": 7}),
            },
            "test",
        )
        .unwrap();

        let rows = db
            .query(
                DbQuery::ModelCallByTurn {
                    project_key: "k1".into(),
                    from_turn: None,
                    to_turn: None,
                },
                "test",
            )
            .unwrap();
        let rows = rows.as_array().unwrap();
        // Deterministic order: turn then role.
        let order: Vec<(i64, String)> = rows
            .iter()
            .map(|r| {
                (
                    r["turn"].as_i64().unwrap(),
                    r["role"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            order,
            vec![
                (1, "drafter".to_string()),
                (1, "lead".to_string()),
                (2, "lead".to_string())
            ]
        );
        let lead1 = &rows[1];
        assert_eq!(lead1["calls"], 2);
        assert_eq!(lead1["input"], 110);
        assert_eq!(lead1["cache_creation"], 20);
        assert_eq!(lead1["cache_read"], 930);
        assert_eq!(lead1["output"], 55);
        assert!((lead1["cost_usd"].as_f64().unwrap() - 0.03).abs() < 1e-9);
        assert_eq!(rows[0]["calls"], 1);
        assert_eq!(rows[0]["cache_read"], 0);

        // Narrowing to the restored turn range drops everything else.
        let only2 = db
            .query(
                DbQuery::ModelCallByTurn {
                    project_key: "k1".into(),
                    from_turn: Some(2),
                    to_turn: Some(2),
                },
                "test",
            )
            .unwrap();
        assert_eq!(only2.as_array().unwrap().len(), 1);
        assert_eq!(only2[0]["turn"], 2);
        assert_eq!(only2[0]["output"], 4);
    }
}
