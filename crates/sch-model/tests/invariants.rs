// SPDX-License-Identifier: Apache-2.0
//! L1 invariants owned by sch-model (I5, I6) and format regressions on the transform.

use sch_model::{
    inverse_transform_point, mm_str_to_nm, mm_to_nm, nm_to_mm_str, transform_point, Mirror,
    Placement, Pt, Rot,
};

fn pt(x: i64, y: i64) -> Pt {
    Pt { x, y }
}

fn place(rot: Rot, mirror: Mirror) -> Placement {
    Placement {
        at: pt(0, 0),
        rot,
        mirror,
    }
}

#[test]
fn inv_5_coordinates_are_integer_nanometres() {
    // 1.27 mm = 1_270_000 nm exactly; no float survives into the model
    assert_eq!(mm_str_to_nm("1.27"), Some(1_270_000));
    assert_eq!(mm_str_to_nm("-0.005"), Some(-5_000));
    assert_eq!(mm_str_to_nm("50.8"), Some(50_800_000));
    assert_eq!(
        mm_to_nm(0.1) + mm_to_nm(0.2),
        mm_to_nm(0.3),
        "quantised comparison has no float drift"
    );
    assert_eq!(nm_to_mm_str(1_270_000), "1.27");
    assert_eq!(nm_to_mm_str(50_800_000), "50.8");
    assert_eq!(nm_to_mm_str(0), "0");
    // Pt is i64: adding is exact and associative
    let a = pt(i64::MAX / 4, 1);
    assert_eq!(a.add(pt(1, 1)).sub(pt(1, 1)), a);
}

#[test]
fn inv_6_rotate_then_mirror_and_file_plus90_maps_to_y_minus_x() {
    let up = pt(0, 1000); // library +Y up
                          // +Y up flips to +Y down first: (0,1000) -> (0,-1000)
    assert_eq!(
        transform_point(up, place(Rot::R0, Mirror::None)),
        pt(0, -1000)
    );
    // file angle +90 => (x,y) -> (y,-x)
    let p = pt(100, 0); // after flip stays (100, 0)
    assert_eq!(
        transform_point(p, place(Rot::R90, Mirror::None)),
        pt(0, -100)
    );
    assert_eq!(
        transform_point(p, place(Rot::R180, Mirror::None)),
        pt(-100, 0)
    );
    assert_eq!(
        transform_point(p, place(Rot::R270, Mirror::None)),
        pt(0, 100)
    );
    // rotate THEN mirror: R90 then mirror X (flip y) = (0, 100); mirror-then-rotate would give (0,-100)
    assert_eq!(transform_point(p, place(Rot::R90, Mirror::X)), pt(0, 100));
    assert_eq!(transform_point(p, place(Rot::R90, Mirror::Y)), pt(0, -100));
    // inverse round-trips for every combination
    for rot in [Rot::R0, Rot::R90, Rot::R180, Rot::R270] {
        for m in [Mirror::None, Mirror::X, Mirror::Y] {
            let pl = Placement {
                at: pt(50_800_000, 45_720_000),
                rot,
                mirror: m,
            };
            for src in [pt(0, 3_810_000), pt(2_540_000, -1_270_000), pt(-7, 13)] {
                assert_eq!(
                    inverse_transform_point(transform_point(src, pl), pl),
                    src,
                    "{rot:?} {m:?} {src:?}"
                );
            }
        }
    }
}

/// reg: 0.4.0 — 270° rotation swapped anode/cathode of polarised parts. R270 must be the
/// inverse of R90 and R90 twice must equal R180 (so polarity follows the file angle).
#[test]
fn reg_rotation_270_is_inverse_of_90_and_polarity_follows_angle() {
    let anode = pt(0, 3_810_000);
    let cathode = pt(0, -3_810_000);
    let r90 = place(Rot::R90, Mirror::None);
    let r270 = place(Rot::R270, Mirror::None);
    for p in [anode, cathode] {
        let once = transform_point(p, r90);
        // applying the +90 file rule twice on the world point equals R180
        let twice = Pt {
            x: once.y,
            y: -once.x,
        };
        let flipped = Pt { x: p.x, y: -p.y };
        assert_eq!(
            twice,
            Pt {
                x: -flipped.x,
                y: -flipped.y
            }
        );
        assert_eq!(
            transform_point(p, r270),
            Pt {
                x: -once.x,
                y: -once.y
            },
            "R270 = -R90"
        );
    }
    assert_ne!(
        transform_point(anode, r90),
        transform_point(anode, r270),
        "anode must land on opposite sides at 90 vs 270"
    );
    assert_eq!(transform_point(anode, r90), transform_point(cathode, r270));
}

/// reg: 0.4.0 — net comparison accumulated float error; the model compares integers only.
#[test]
fn reg_integer_nm_comparison_has_no_float_drift() {
    let mut acc = 0i64;
    for _ in 0..10_000 {
        acc += mm_str_to_nm("0.1").unwrap();
    }
    assert_eq!(acc, mm_str_to_nm("1000").unwrap());
}

/// reg: 0.3.0 — multi-unit symbols must not expose every unit's pins on one instance.
#[test]
fn reg_multi_unit_pins_are_per_unit_plus_common() {
    use sch_model::{LibPin, LibSymbol, PinType, SymbolInst};
    let pin = |n: &str, unit: u32| LibPin {
        number: n.into(),
        name: n.into(),
        kind: PinType::Passive,
        at: pt(0, 0),
        angle: 0,
        length: 2_540_000,
        unit,
        convert: 1,
        hide: false,
    };
    let lib = LibSymbol {
        id: "Amplifier_Operational:LM358".into(),
        pins: vec![
            pin("1", 1),
            pin("2", 1),
            pin("5", 2),
            pin("6", 2),
            pin("4", 0),
            pin("8", 0),
        ],
        unit_count: 2,
        is_power: false,
        power_scope: Default::default(),
        extends: None,
        properties: vec![],
    };
    let u2: Vec<String> = lib.pins_for_unit(2).map(|p| p.number.clone()).collect();
    assert_eq!(
        u2,
        vec!["5", "6", "4", "8"],
        "unit 2 = its own pins + common (unit 0) pins"
    );
    let inst = SymbolInst {
        uuid: "u".into(),
        lib_id: lib.id.clone(),
        placement: place(Rot::R0, Mirror::None),
        unit: 2,
        reference: "U1".into(),
        value: "LM358".into(),
        footprint: String::new(),
        dnp: false,
        in_bom: true,
        on_board: true,
        exclude_from_sim: false,
        properties: vec![],
        instances: vec![],
        node_index: 0,
    };
    let world: Vec<String> = sch_model::world_pins(&inst, &lib)
        .into_iter()
        .map(|p| p.number)
        .collect();
    assert_eq!(world, vec!["5", "6", "4", "8"]);
}
