// SPDX-License-Identifier: Apache-2.0
//! eeschema's default pin-to-pin conflict matrix.
//!
//! Transcribed verbatim from `ERC_SETTINGS::m_defaultPinMap` in KiCad's
//! `eeschema/erc/erc_settings.cpp`, branch `10.0` (the KiCad major this engine targets):
//! <https://gitlab.com/kicad/code/kicad/-/raw/10.0/eeschema/erc/erc_settings.cpp>
//!
//! A non-`OK` cell is what eeschema reports as `pin_to_pin` when two pins of those electrical
//! types end up on one net (`ERCE_PIN_TO_PIN_ERROR` / `ERCE_PIN_TO_PIN_WARNING`; their default
//! severities, error and warning, are set in the same file's `ERC_SETTINGS` constructor).
//!
//! Rows and columns follow KiCad's `ELECTRICAL_PINTYPE` order, reproduced by [`PIN_TYPES`].
//! Two of KiCad's short names differ from the `.kicad_sym` keywords the engine parses:
//! `NIC` is the `free` pin type and `NC` is `no_connect`.

use sch_model::PinType;
use sch_write::gates::Severity;

const OK: u8 = 0;
const WAR: u8 = 1;
const ERR: u8 = 2;

/// Pin electrical types in KiCad's `ELECTRICAL_PINTYPE` order (the matrix index order).
pub const PIN_TYPES: [PinType; 12] = [
    PinType::Input,
    PinType::Output,
    PinType::Bidirectional,
    PinType::TriState,
    PinType::Passive,
    PinType::Free,
    PinType::Unspecified,
    PinType::PowerIn,
    PinType::PowerOut,
    PinType::OpenCollector,
    PinType::OpenEmitter,
    PinType::NoConnect,
];

#[rustfmt::skip]
static PIN_MAP: [[u8; 12]; 12] = [
    /*         I,   O,    Bi,   3S,   Pas,  NIC,  UnS,  PwrI, PwrO, OC,   OE,   NC */
    /* I  */ [ OK,  OK,   OK,   OK,   OK,   OK,   WAR,  OK,   OK,   OK,   OK,   ERR ],
    /* O  */ [ OK,  ERR,  OK,   WAR,  OK,   OK,   WAR,  OK,   ERR,  ERR,  ERR,  ERR ],
    /* Bi */ [ OK,  OK,   OK,   OK,   OK,   OK,   WAR,  OK,   WAR,  OK,   WAR,  ERR ],
    /* 3S */ [ OK,  WAR,  OK,   OK,   OK,   OK,   WAR,  WAR,  ERR,  WAR,  WAR,  ERR ],
    /*Pas */ [ OK,  OK,   OK,   OK,   OK,   OK,   WAR,  OK,   OK,   OK,   OK,   ERR ],
    /*NIC */ [ OK,  OK,   OK,   OK,   OK,   OK,   OK,   OK,   OK,   OK,   OK,   ERR ],
    /*UnS */ [ WAR, WAR,  WAR,  WAR,  WAR,  OK,   WAR,  WAR,  WAR,  WAR,  WAR,  ERR ],
    /*PwrI*/ [ OK,  OK,   OK,   WAR,  OK,   OK,   WAR,  OK,   OK,   OK,   OK,   ERR ],
    /*PwrO*/ [ OK,  ERR,  WAR,  ERR,  OK,   OK,   WAR,  OK,   ERR,  ERR,  ERR,  ERR ],
    /* OC */ [ OK,  ERR,  OK,   WAR,  OK,   OK,   WAR,  OK,   ERR,  OK,   OK,   ERR ],
    /* OE */ [ OK,  ERR,  WAR,  WAR,  OK,   OK,   WAR,  OK,   ERR,  OK,   OK,   ERR ],
    /* NC */ [ ERR, ERR,  ERR,  ERR,  ERR,  ERR,  ERR,  ERR,  ERR,  ERR,  ERR,  ERR ],
];

/// Index of a pin type in [`PIN_TYPES`] / the matrix.
pub fn pin_index(t: PinType) -> usize {
    match t {
        PinType::Input => 0,
        PinType::Output => 1,
        PinType::Bidirectional => 2,
        PinType::TriState => 3,
        PinType::Passive => 4,
        PinType::Free => 5,
        PinType::Unspecified => 6,
        PinType::PowerIn => 7,
        PinType::PowerOut => 8,
        PinType::OpenCollector => 9,
        PinType::OpenEmitter => 10,
        PinType::NoConnect => 11,
    }
}

/// eeschema's verdict for two pins of these types sharing a net: `None` when the pair is
/// allowed, otherwise the severity of the `pin_to_pin` violation it raises.
pub fn pin_conflict(a: PinType, b: PinType) -> Option<Severity> {
    match PIN_MAP[pin_index(a)][pin_index(b)] {
        WAR => Some(Severity::Warning),
        ERR => Some(Severity::Error),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_is_symmetric_and_indexes_round_trip() {
        for (i, a) in PIN_TYPES.iter().enumerate() {
            assert_eq!(pin_index(*a), i);
            for b in PIN_TYPES.iter() {
                assert_eq!(
                    pin_conflict(*a, *b),
                    pin_conflict(*b, *a),
                    "{a:?} / {b:?} disagree"
                );
            }
        }
    }

    #[test]
    fn spot_checks_match_eeschema() {
        use PinType::*;
        assert_eq!(pin_conflict(Output, Output), Some(Severity::Error));
        assert_eq!(pin_conflict(Output, Input), None);
        assert_eq!(pin_conflict(PowerOut, PowerOut), Some(Severity::Error));
        assert_eq!(pin_conflict(PowerOut, PowerIn), None);
        assert_eq!(pin_conflict(PowerIn, PowerIn), None);
        assert_eq!(pin_conflict(Output, TriState), Some(Severity::Warning));
        assert_eq!(pin_conflict(Output, OpenCollector), Some(Severity::Error));
        assert_eq!(pin_conflict(Unspecified, Passive), Some(Severity::Warning));
        assert_eq!(pin_conflict(Unspecified, Free), None);
        assert_eq!(pin_conflict(NoConnect, Passive), Some(Severity::Error));
        assert_eq!(pin_conflict(Passive, Passive), None);
    }
}
