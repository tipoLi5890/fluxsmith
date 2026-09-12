# Conformance fixtures

Self-authored KiCad 10 files used by round-trip and oracle tests. No third-party fixtures are vendored here; point
`FLUXSMITH_EXTRA_FIXTURES=/path/a:/path/b` at your own KiCad files to include them in the round-trip suite.

Connectivity cases (`crates/sch-net/tests/oracle.rs`), each one a minimal reproduction rather than a clean design:

- `bus_hier/` — a bus crossing a hierarchical sheet pin: `hbusvec` (vector bus `D[0..7]`), `hbusgrp` (group bus `USB{DP DM}`),
  and `hbusren`, the negative control where the parent bus label differs from the sheet pin name and eeschema keeps the nets apart.
- `local_power/` — `twicelocal`, a child instantiated twice with a `(power local)` symbol (one net per instance) plus a
  `(power global)` one (one net project-wide); `localprio`, where the local power name outranks a local label on the same net
  and two same-named local power symbols on one sheet connect without a wire.
- `multi_unit/` — `multiunit`, a non-power symbol with hidden `power_in` pins (KiCad's legacy invisible power pins) and two
  units placed.
- `naming/` — auto-generated net names (`SCH_PIN::GetDefaultNetName`, `CONNECTION_SUBGRAPH::ResolveDrivers`):
  `named`, an IC whose pin names name the nets, with the `-Pad` / lexicographic candidate order and KiCad's `has_multiple`;
  `common0`, a two-unit op-amp whose common (`_0_1`) power pins are exposed by both units and are kept apart by the unit token;
  `nc2pin`, a no-connect marker on a two-pin net plus a `no_connect` pin that propagates connection to nothing;
  `midpin`, a pin on a wire interior (no junction), the single-pin `unconnected-` case;
  `escname`, `/` in a local label, a global label, a power symbol value, an invisible power pin name and braces in a pin name.
  Alternate pin functions (`(alternate ...)`) are not modelled by `sch-read`, so there is no `altpin` fixture: KiCad names such a
  net after the *shown* (alternate) name, fluxsmith after the library name.
