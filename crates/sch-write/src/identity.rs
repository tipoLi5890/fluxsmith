// SPDX-License-Identifier: Apache-2.0
//! UUIDv5 content addressing (docs/identity.md, frozen).
//!
//! `node_uuid(namespace, seed)` where namespace is the sheet file's root uuid
//! and `seed` is `kind|field|field...` with nm integers.

use sch_model::{Nm, Pt};
use uuid::Uuid;

pub fn node_uuid(namespace: &str, seed: &str) -> String {
    let ns = Uuid::parse_str(namespace).unwrap_or(Uuid::NAMESPACE_OID);
    Uuid::new_v5(&ns, seed.as_bytes()).to_string()
}

pub fn seed_symbol(designator: &str, unit: u32) -> String {
    if unit <= 1 {
        format!("symbol|{designator}")
    } else {
        format!("symbol|{designator}|u{unit}")
    }
}

pub fn seed_pin(designator: &str, unit: u32, pin_number: &str, dup_index: usize) -> String {
    format!("pin|{designator}|u{unit}|{pin_number}|d{dup_index}")
}

fn sorted(a: Pt, b: Pt) -> (Pt, Pt) {
    if (a.x, a.y) <= (b.x, b.y) {
        (a, b)
    } else {
        (b, a)
    }
}

pub fn seed_wire(a: Pt, b: Pt) -> String {
    let (a, b) = sorted(a, b);
    format!("wire|{}|{}|{}|{}", a.x, a.y, b.x, b.y)
}

pub fn seed_bus(a: Pt, b: Pt) -> String {
    let (a, b) = sorted(a, b);
    format!("bus|{}|{}|{}|{}", a.x, a.y, b.x, b.y)
}

pub fn seed_junction(p: Pt) -> String {
    format!("junction|{}|{}", p.x, p.y)
}

pub fn seed_bus_entry(p: Pt) -> String {
    format!("bus_entry|{}|{}", p.x, p.y)
}

/// Anchor seed: a pin (`pin|...`) or a bare point (`pt|x|y`).
pub fn anchor_pt(p: Pt) -> String {
    format!("pt|{}|{}", p.x, p.y)
}

pub fn seed_no_connect(anchor_seed: &str) -> String {
    format!("no_connect|{anchor_seed}")
}

pub fn seed_label(scope: &str, name: &str, anchor_seed: &str) -> String {
    format!("label|{scope}|{name}|{anchor_seed}")
}

pub fn seed_power(net_name: &str, anchor_seed: &str) -> String {
    format!("power|{net_name}|{anchor_seed}")
}

pub fn seed_keyed(kind: &str, key: &str) -> String {
    format!("{kind}|key|{key}")
}

pub fn seed_text(kind: &str, p: Pt) -> String {
    format!("{kind}|{}|{}", p.x, p.y)
}

pub fn seed_rect(kind: &str, a: Pt, b: Pt) -> String {
    format!("{kind}|{}|{}|{}|{}", a.x, a.y, b.x, b.y)
}

pub fn seed_sheet(file: &str, name: &str) -> String {
    format!("sheet|{file}|{name}")
}

pub fn seed_sheet_pin(file: &str, name: &str, pin_name: &str) -> String {
    format!("sheetpin|{file}|{name}|{pin_name}")
}

pub fn seed_sheet_file(file: &str) -> String {
    format!("sheetfile|{file}")
}

#[allow(dead_code)]
pub fn nm(v: Nm) -> Nm {
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_direction_free() {
        let ns = "11111111-1111-4111-8111-111111111111";
        let a = node_uuid(ns, &seed_wire(Pt::new(1, 2), Pt::new(3, 4)));
        let b = node_uuid(ns, &seed_wire(Pt::new(3, 4), Pt::new(1, 2)));
        assert_eq!(a, b);
        assert_eq!(a, node_uuid(ns, "wire|1|2|3|4"));
        assert_ne!(
            a,
            node_uuid("22222222-2222-4222-8222-222222222222", "wire|1|2|3|4")
        );
        assert_eq!(seed_symbol("R3", 1), "symbol|R3");
        assert_eq!(seed_symbol("R3", 2), "symbol|R3|u2");
    }
}
