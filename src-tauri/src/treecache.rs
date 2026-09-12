// SPDX-License-Identifier: Apache-2.0
//! Per-project parsed-tree and render-geometry cache (canvas plan P2.4).
//!
//! `sch_read::read_project` re-parses every sheet file; a canvas refresh, every thumbnail and
//! most read requests paid that in full. The cache is keyed on the sha256 of every file the tree
//! was built from (`tree.files` — a child added or removed also rewrites its parent, so the set
//! covers structure changes). Freshness is re-checked on every lookup (hashing a few hundred kB
//! is ~1 ms versus tens to hundreds of ms of parsing); the watcher and a successful apply drop it
//! explicitly as well. Scratch trees (previews, plans) never come through here.

use crate::ipc::IpcError;
use parking_lot::Mutex;
use sch_read::SheetTree;
use sch_write::atomic::file_sha;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// One source file as the cache saw it. `stamp` (length + mtime in ns) is the cheap first check;
/// only a changed stamp costs a sha256 (a same-content rewrite then still counts as fresh).
struct Source {
    sha: String,
    stamp: Option<(u64, u128)>,
}

pub struct TreeCache {
    sources: BTreeMap<PathBuf, Source>,
    pub tree: Arc<SheetTree>,
    renders: HashMap<String, Arc<Value>>,
}

pub type Slot = Mutex<Option<TreeCache>>;

fn stamp(p: &Path) -> Option<(u64, u128)> {
    let m = std::fs::metadata(p).ok()?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((m.len(), t))
}

impl TreeCache {
    fn fresh(&mut self) -> bool {
        for (p, src) in self.sources.iter_mut() {
            let now = stamp(p);
            if now.is_some() && now == src.stamp {
                continue;
            }
            if file_sha(p).as_deref() != Some(src.sha.as_str()) {
                return false;
            }
            src.stamp = now;
        }
        true
    }
}

/// The parsed project tree, from the cache when every source file is unchanged.
pub fn tree(slot: &Slot, root_sheet: &Path) -> Result<Arc<SheetTree>, IpcError> {
    {
        let mut g = slot.lock();
        if let Some(c) = g.as_mut() {
            if c.fresh() {
                return Ok(c.tree.clone());
            }
        }
    }
    let t = Arc::new(sch_read::read_project(root_sheet)?);
    let sources = t
        .files
        .keys()
        .map(|p| {
            (
                p.clone(),
                Source {
                    sha: file_sha(p).unwrap_or_default(),
                    stamp: stamp(p),
                },
            )
        })
        .collect();
    *slot.lock() = Some(TreeCache {
        sources,
        tree: t.clone(),
        renders: HashMap::new(),
    });
    Ok(t)
}

/// `render_sheet` as JSON for one sheet path, memoised per cached tree. `None` = unknown sheet.
pub fn render(
    slot: &Slot,
    root_sheet: &Path,
    sheet_path: &str,
) -> Result<Option<Arc<Value>>, IpcError> {
    let t = tree(slot, root_sheet)?;
    {
        let g = slot.lock();
        if let Some(c) = g.as_ref() {
            if Arc::ptr_eq(&c.tree, &t) {
                if let Some(v) = c.renders.get(sheet_path) {
                    return Ok(Some(v.clone()));
                }
            }
        }
    }
    let Some(rs) = sch_geom::render_sheet(&t, sheet_path) else {
        return Ok(None);
    };
    let v = Arc::new(serde_json::to_value(rs)?);
    if let Some(c) = slot.lock().as_mut() {
        if Arc::ptr_eq(&c.tree, &t) {
            c.renders.insert(sheet_path.to_string(), v.clone());
        }
    }
    Ok(Some(v))
}

/// Drop everything (called after our own writes and by the watcher; the sha check would catch
/// the change anyway, this just skips the hashing on the next request).
pub fn invalidate(slot: &Slot) {
    slot.lock().take();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(dir: &Path) -> PathBuf {
        let root_uuid = "11111111-1111-4111-8111-111111111111";
        let sch = dir.join("t.kicad_sch");
        std::fs::write(&sch, sch_write::nodes::empty_schematic(root_uuid, "A4")).unwrap();
        std::fs::write(
            dir.join("t.kicad_pro"),
            sch_write::nodes::empty_project("t"),
        )
        .unwrap();
        sch
    }

    #[test]
    fn hit_then_miss_after_touch() {
        let dir = tempfile::tempdir().unwrap();
        let sch = project(dir.path());
        let slot: Slot = Mutex::new(None);
        let a = tree(&slot, &sch).unwrap();
        let b = tree(&slot, &sch).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "unchanged files hit the cache");
        let r1 = render(&slot, &sch, "/").unwrap().unwrap();
        let r2 = render(&slot, &sch, "/").unwrap().unwrap();
        assert!(Arc::ptr_eq(&r1, &r2), "render memoised per tree");
        // touch: append a text item -> different sha -> new tree, renders dropped
        let mut s = std::fs::read_to_string(&sch).unwrap();
        let at = s.rfind(')').unwrap();
        s.insert_str(at, "\t(text \"hello\" (at 25.4 25.4 0) (effects (font (size 1.27 1.27))) (uuid \"22222222-2222-4222-8222-222222222222\"))\n");
        std::fs::write(&sch, s).unwrap();
        let c = tree(&slot, &sch).unwrap();
        assert!(!Arc::ptr_eq(&a, &c), "changed bytes miss the cache");
        let r3 = render(&slot, &sch, "/").unwrap().unwrap();
        assert!(!Arc::ptr_eq(&r1, &r3));
        assert_eq!(r3["texts"].as_array().map(|a| a.len()), Some(1));
        assert!(render(&slot, &sch, "/nope/").unwrap().is_none());
    }

    /// `FLUXSMITH_BENCH_SCH=<root.kicad_sch> cargo test -p fluxsmith-app treecache -- --ignored --nocapture`
    #[test]
    #[ignore = "timing only; needs FLUXSMITH_BENCH_SCH"]
    fn bench_cache_hit() {
        let Ok(p) = std::env::var("FLUXSMITH_BENCH_SCH") else {
            return;
        };
        let sch = PathBuf::from(p);
        let slot: Slot = Mutex::new(None);
        let t0 = std::time::Instant::now();
        let _ = tree(&slot, &sch).unwrap();
        let cold = t0.elapsed();
        let t1 = std::time::Instant::now();
        let _ = render(&slot, &sch, "/").unwrap();
        let render_cold = t1.elapsed();
        let t2 = std::time::Instant::now();
        let _ = tree(&slot, &sch).unwrap();
        let warm = t2.elapsed();
        let t3 = std::time::Instant::now();
        let _ = render(&slot, &sch, "/").unwrap();
        let render_warm = t3.elapsed();
        eprintln!("treecache: parse cold {cold:?} warm {warm:?}; render cold {render_cold:?} warm {render_warm:?}");
    }

    #[test]
    fn miss_after_child_sheet_added() {
        let dir = tempfile::tempdir().unwrap();
        let sch = project(dir.path());
        let slot: Slot = Mutex::new(None);
        let a = tree(&slot, &sch).unwrap();
        // add a child sheet file + a sheet symbol in the root referencing it
        std::fs::write(
            dir.path().join("child.kicad_sch"),
            sch_write::nodes::empty_schematic("33333333-3333-4333-8333-333333333333", "A4"),
        )
        .unwrap();
        let mut s = std::fs::read_to_string(&sch).unwrap();
        let at = s.rfind(')').unwrap();
        s.insert_str(at, "\t(sheet (at 50.8 50.8) (size 25.4 12.7) (uuid \"44444444-4444-4444-8444-444444444444\") (property \"Sheetname\" \"child\" (at 50.8 50 0) (effects (font (size 1.27 1.27)))) (property \"Sheetfile\" \"child.kicad_sch\" (at 50.8 64 0) (effects (font (size 1.27 1.27)))))\n");
        std::fs::write(&sch, s).unwrap();
        let b = tree(&slot, &sch).unwrap();
        assert!(!Arc::ptr_eq(&a, &b));
        assert_eq!(b.files.len(), 2);
        invalidate(&slot);
        assert!(slot.lock().is_none());
    }
}
