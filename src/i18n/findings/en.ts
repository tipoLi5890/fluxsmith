// SPDX-License-Identifier: Apache-2.0
// Finding copy (title / what the check measured / the usual fix) — English, the table of record.
// Designators, net names, distances and the rest arrive in the engine's own `message` and are shown
// verbatim under this copy.
import type { FindingCopyTable } from "./codes";

const en: FindingCopyTable = {
  DANGLING_ENDPOINT: ["Wire end reaches nothing", "A wire endpoint lands on no pin, no other wire end, no label and no junction; the write gate is deliberately stricter here than eeschema, which reports a loose end as a warning.", "End the wire on a pin or another wire end, add a label, or place a junction where wires cross."],
  DANGLING_BUS: ["Bus end reaches nothing", "A bus endpoint touches no bus, no bus entry and no bus label, so nothing it carries arrives anywhere.", "End the bus on a bus entry or a bus label, or delete the leftover segment."],
  DANGLING_BUS_ENTRY: ["Bus entry misses bus or wire", "A bus entry must touch a bus at one end and a wire at the other; this one does not.", "Move the entry so both ends land on the bus and on the wire it feeds."],
  DUPLICATE_UUID: ["Two objects share one identity", "The same uuid appears more than once in one sheet file, so the two objects cannot be told apart.", "Delete and re-create the copied object so each one carries its own uuid."],
  DUPLICATE_DESIGNATOR: ["Reference used twice on a sheet", "One reference and unit (R1, or unit A of U2) is carried by more than one symbol on the same sheet.", "Renumber one of them so every part on the sheet has its own reference."],
  DUPLICATE_DESIGNATOR_PROJECT: ["Reference used twice in the project", "One reference and unit appears on more than one sheet, which KiCad reports as duplicate_reference.", "Annotate across the whole project so no reference repeats."],
  UNRESOLVED_LIB_ID: ["Symbol missing from the file cache", "The symbol's lib_id is not in the file's own lib_symbols cache, so KiCad has no body to draw and no pins to connect.", "Place the part again from the library, or repair the cached symbol in KiCad."],
  INVALID_INSTANCES_PATH: ["Instance path outside this project", "A symbol's instance path does not start with the root sheet uuid of this project.", "Annotate the sheet again in KiCad so its instance paths point at this project's root."],
  POWER_PORT_STACKED: ["Power ports stacked on one point", "Two or more power symbols share the same connection point, which silently merges the rails they name.", "Move one port away, or delete the extra one if both name the same rail."],
  SHEET_FILE_MISSING: ["Child sheet file not found", "A sheet symbol points at a .kicad_sch file that is not on disk, so the design is missing everything on it.", "Restore the file, or point the sheet at the file it should carry."],
  NO_CONNECT_CONFLICT: ["No-connect on a connected point", "A no-connect flag sits where a wire or a label also lands, which eeschema calls no_connect_connected.", "Remove the flag, or remove the wire or label that reaches that pin."],

  OUT_OF_FRAME: ["Object outside the sheet frame", "A symbol or label sits outside the paper size the sheet declares, so it is missing from the plot.", "Move it inside the frame, or set a larger paper size."],
  GROUP_OVERLAP: ["Two part bodies overlap", "Two symbol bodies intersect, measured on graphics plus pin stubs shrunk by 10 mil so touching pin tips do not count.", "Move one part clear of the other."],
  SYMBOL_OVERLAP: ["Power symbol overlaps a part", "A power symbol's body intersects another symbol's body, on the same boxes shrunk by 10 mil.", "Move the power port off the part it sits on."],
  LABEL_OVERLAP: ["Two labels overlap", "The text boxes of two labels intersect, so at least one of them cannot be read in the plot.", "Move one label along its wire, or put it on the other side of its anchor."],
  LABEL_OVER_BODY: ["Label written over a part", "A label's text box runs over another symbol's body; KiCad's own ERC has no geometric text check, so nothing else in the pipeline sees this.", "Move the label off the body, keeping its anchor on the wire."],
  LABEL_OVER_WIRE: ["Label written along its wire", "The label text is drawn along the wire leaving its own anchor, so it covers the connection it names.", "Put the label on the other side of the anchor, or move it further from the wire."],
  TEXT_OVERLAP: ["Field text over another object", "A symbol field (reference, value or footprint) runs over another symbol's body or over a label.", "Move the field text clear, usually above the part."],
  FIELD_OVER_OWN_BODY: ["Field text over its own part", "An autoplaced field sits inside the outline of the symbol it belongs to.", "Move the value or reference text off the body."],
  FIELD_OVER_FIELD: ["Field texts of two parts overlap", "The field texts of two symbols overlap, so neither reads cleanly in the plot.", "Move one field, or place the two parts further apart."],
  PAGE_UNDERUSED: ["Drawing parked in one corner", "Everything drawn on the sheet fills less than a tenth of the drawing border and its center sits well off the middle of the page.", "Spread the blocks over the sheet, or move them toward the middle; a smaller paper size is the other answer."],
  LABEL_PAIR_SHOULD_BE_WIRE: ["One net name written twice", "Two labels of the same name sit within 500 mil of each other with no symbol body between them, where a wire would join the two points directly.", "Draw a wire between the two points and delete one label, or keep the pair if the wire would cross the block."],

  OFF_GRID: ["Pin or endpoint off the grid", "A pin, wire end or bus entry is not an exact multiple of the 50 mil connection grid, the zero-tolerance modulo eeschema's TestOffGridEndpoints uses.", "Move the part or the wire so the point lands on a 50 mil grid point, or fix the library symbol."],
  LONG_WIRE: ["Long or diagonal wire", "The wire runs further than 1500 mil, or diagonally, so a reader has to trace it across the sheet.", "Replace it with a net label at each end, or redraw it as horizontal and vertical segments."],
  POWER_PORT_ORIENTATION: ["Power port points the wrong way", "The body sits on the wrong side of the port's pin: ground ports point down, supply rails point up.", "Rotate the port by 180 degrees, or place it again so the engine orients it from the pin."],
  ROW_MISALIGNED: ["Parts in a row not aligned", "Two small parts sit in one row but their bottom edges differ, reported in mil.", "Move one of them so the row shares a bottom edge."],

  ERC_POWER_IN_UNDRIVEN: ["Power input with no source", "The net reaches a power input pin but carries no power output pin and no PWR_FLAG, the condition eeschema reports as power_pin_not_driven.", "Add a PWR_FLAG where the rail enters the sheet, or connect the rail to the output that drives it."],
  ERC_POWER_OUT_CONFLICT: ["Two power sources on one net", "The net carries two power output pins, or a power output together with a PWR_FLAG or a logic output.", "Delete the extra PWR_FLAG, or separate the two sources onto different nets."],
  ERC_OUTPUT_CONFLICT: ["Two outputs drive one net", "More than one output pin drives the same net, which eeschema's pin conflict matrix rejects.", "Separate the outputs, or put a series element or a buffer between them."],
  ERC_INPUT_FLOATING: ["Input pin left unconnected", "An input pin is on no net and carries no no-connect marker.", "Wire the pin to its driver, or mark it with a no-connect flag if it is deliberately unused."],
  ERC_NC_ON_CONNECTED: ["No-connect on a used net", "A net marked no-connect still has members on it, which eeschema calls no_connect_connected.", "Remove the no-connect flag, or disconnect the pin it covers."],
  ERC_SINGLE_PIN_NET: ["Named net with one pin", "A net that carries a name reaches only one pin, so the name connects nothing to anything.", "Connect the second end, or remove the label if the name is not needed."],
  ERC_PIN_TO_PIN: ["Pin types conflict on a net", "A pin type pair on this net is an error or a warning in eeschema's default pin conflict matrix, copied from KiCad 10 erc_settings.cpp.", "Separate the conflicting pins onto different nets, or put a buffer or a series element between them."],
  ERC_UNSPECIFIED_PIN: ["Pin has no electrical type", "The net connects a pin whose library type is unspecified, the matrix row eeschema cannot check against anything.", "Give the pin an electrical type in its library symbol."],
  ERC_MULTIPLE_NET_NAMES: ["Net driven by several names", "Two or more different names drive one net, so only the winner of the driver ladder reaches the netlist (eeschema multiple_net_names).", "Keep one name for the net and rename or delete the others."],
  LABEL_DANGLING: ["Label attached to nothing", "The label touches no wire and no pin, so it names nothing in the netlist.", "Move the label onto the wire it should name, or delete it."],
  POWER_PORT_DANGLING: ["Power port attached to nothing", "The power symbol touches no wire and no component pin, so the rail it names goes nowhere.", "Move the port onto the rail it feeds, or delete it."],
  POLARITY_REVERSED: ["Polarized part looks reversed", "The plus pin of a polarized capacitor, or the anode of a diode, is on a ground net while the other pin is on a positive rail.", "Rotate the part by 180 degrees if it was placed the wrong way round."],
  RAIL_ALIAS: ["Rail names read as one supply", "Names such as +3V3, +3.3V and 3V3 read as the same supply but are separate nets in KiCad.", "Rename them so one rail carries one name."],
  SHEET_PIN_UNMATCHED: ["Sheet pin has no label", "A sheet symbol carries a pin the child sheet has no hierarchical label for, which eeschema reports as hier_label_mismatch.", "Add the hierarchical label in the child sheet, or delete the sheet pin."],
  HIER_LABEL_UNMATCHED: ["Hierarchical label has no sheet pin", "A child sheet carries a hierarchical label the parent's sheet symbol has no pin for.", "Add the matching sheet pin in the parent, or delete the label."],
  INSTANCE_REFS_REQUIRED: ["Sheet instance has no references", "A sheet file placed more than once holds symbols with no reference recorded for one of the instance paths, so KiCad shows R? there.", "Annotate the project in KiCad so every instance of the sheet carries its own references."],
  SHEET_PIN_UNWIRED: ["Sheet pin wired to nothing", "A hierarchical sheet pin has no wire, label, junction or pin on its point; KiCad's own ERC reports the same pin as pin_not_connected.", "Wire the sheet pin to the net it carries, or delete the pin."],

  PINMAP_UNCONNECTED: ["Pin not connected", "The pin's net has no driver and no second pin, the condition eeschema reports as pin_not_connected; only free and no-connect pins are exempt.", "Wire the pin to the net it belongs to, or place a no-connect flag on it."],

  FOOTPRINT_MISSING: ["Part has no footprint", "The symbol carries no footprint field, so the part cannot be laid out or ordered.", "Set the footprint on the part."],
  UNITS_INCOMPLETE: ["Not every unit is placed", "A multi-unit part has fewer units on the sheets than its library symbol declares.", "Place the remaining units, or confirm that the part is deliberately used in part."],
  RAIL_AS_LABEL: ["Rail drawn as a local label", "A rail name is drawn as a local label and no power symbol for that net is on the same sheet.", "Place a power port for the rail instead of naming it with a local label."],
  RAIL_SCOPE_SPLIT: ["One label name, separate nets", "A local label of this name exists on more than one sheet, and local labels do not merge across sheets.", "Use a global label or a power port if the sheets are meant to share the net."],
  LABEL_SCOPE_SPLIT: ["Same label name on several sheets", "A local label of this name exists on more than one sheet; local labels do not merge across sheets, so these are separate nets.", "Use a global or hierarchical label if the sheets share the signal; otherwise rename one side so the names differ."],
  DECAP_FAR: ["Decoupling capacitor far from pin", "A capacitor on a supply pin's net sits more than 500 mil from every one of those pins.", "Draw the capacitor next to the pin it decouples."],
  PART_UNVERIFIED: ["Converted part not verified", "The part uses a converted library symbol that nobody has checked against the datasheet; a conversion is a claim, not a fact.", "Compare the symbol's pins with the datasheet before ordering the part."],
  SHEET_NO_PINS: ["Sheet symbol has no pins", "A sheet symbol carries no sheet pins while the sheet it points at has a circuit on it, so no signal crosses the boundary.", "Add the sheet pins the block needs and the matching hierarchical labels inside the child sheet."],
  SHEET_CHILD_EMPTY: ["Child sheet has nothing drawn", "The file a sheet symbol points at holds no symbols, no labels and no child sheets: the scaffold was created and never drawn on.", "Draw the block on the child sheet, or delete the sheet symbol."],

  INTENT_MISMATCH: ["Net differs from known-good", "A net named in the known-good snapshot no longer has the same members.", "Restore the connection, or record a new known-good snapshot once the change is confirmed."],

  UNANNOTATED: ["Part has no reference", "A symbol still carries a placeholder reference such as R?, so it has no identity in the netlist or the BOM.", "Annotate the schematic so every part gets a number."],
  SYMBOL_CACHE_MISMATCH: ["Cached symbol differs from library", "The symbol cached in the file differs from the library's, compared per unit and body style on pin name, electrical type and position.", "Update the symbol from the library in KiCad, or keep the cached one deliberately."],
  SYMBOL_NOT_IN_TABLE: ["Symbol library not registered", "The cached symbol's library is not in a symbol library table this project can see.", "Register the library in KiCad, or place the part again from a registered library."],
  TITLE_BLOCK_EMPTY: ["Sheet has no title", "The sheet's title block carries no title, so the printed sheet and the plot are unnamed.", "Fill in the title block: title, revision and company."],
  PIN_PAD_MISMATCH: ["Symbol pins differ from footprint pads", "The converted part records a mismatch between its symbol's pins and its footprint's pads.", "Check the pin numbering against the datasheet before ordering the part."],

  SUBSTITUTED_PART: ["Part was substituted", "The line carries a substitution recorded on the symbol, so the part ordered is not the one first chosen.", "Confirm the substitute against the datasheet, or restore the original part."],

  KICAD_POWER_PIN_NOT_DRIVEN: ["Power input not driven", "KiCad's own ERC found a power input pin on a net with no power output and no PWR_FLAG.", "Add a PWR_FLAG where the rail enters the sheet, or connect the rail to the output that drives it."],
  KICAD_PIN_NOT_DRIVEN: ["Net has no driver", "KiCad's own ERC found input pins on a net that no output and no power source drives.", "Connect the net to its driver, or add a PWR_FLAG if it is driven from outside the sheet."],
  KICAD_PIN_NOT_CONNECTED: ["Pin not connected", "KiCad's own ERC found a pin with nothing else on its net.", "Wire the pin to the net it belongs to, or place a no-connect flag on it."],
  KICAD_PIN_TO_PIN: ["Pin types conflict on a net", "KiCad's own ERC found a pin type pair its conflict matrix rejects.", "Separate the pins onto different nets, or put a buffer or a series element between them."],
  KICAD_LABEL_DANGLING: ["Label attached to nothing", "KiCad's own ERC found a label that reaches no wire and no pin.", "Move the label onto the wire it should name, or delete it."],
  KICAD_GLOBAL_LABEL_DANGLING: ["Global label attached to nothing", "KiCad's own ERC found a global label that reaches no wire and no pin.", "Move the label onto the wire it should name, or delete it."],
  KICAD_WIRE_DANGLING: ["Wire end reaches nothing", "KiCad's own ERC found a wire or bus end that connects to nothing.", "End the wire on a pin or another wire end, or delete the leftover segment."],
  KICAD_UNCONNECTED_WIRE_ENDPOINT: ["Wire endpoint left unconnected", "KiCad's own ERC found a wire endpoint that touches no pin, label or junction.", "End the wire on a pin or a label, or add a junction where wires cross."],
  KICAD_NO_CONNECT_CONNECTED: ["No-connect on a used pin", "KiCad's own ERC found a no-connect flag on a pin that is wired to something.", "Remove the flag, or disconnect the pin it covers."],
  KICAD_NO_CONNECT_DANGLING: ["No-connect on no pin", "KiCad's own ERC found a no-connect flag that sits on no pin at all.", "Move the flag onto the unused pin, or delete it."],
  KICAD_DUPLICATE_REFERENCE: ["Reference used twice", "KiCad's own ERC found one reference carried by more than one part.", "Annotate the project so no reference repeats."],
  KICAD_UNANNOTATED: ["Part has no reference", "KiCad's own ERC found a part still carrying a placeholder reference.", "Annotate the schematic so every part gets a number."],
  KICAD_MULTIPLE_NET_NAMES: ["Net driven by several names", "KiCad's own ERC found one net driven by two or more different names.", "Keep one name for the net and rename or delete the others."],
  KICAD_SIMILAR_LABELS: ["Labels differ only slightly", "KiCad's own ERC found labels that differ only in case or spacing, so they name different nets.", "Rename them so one net has one name."],
  KICAD_SINGLE_GLOBAL_LABEL: ["Global label used once", "KiCad's own ERC found a global label that appears in only one place, so it joins nothing.", "Add the matching label elsewhere, or use a local label."],
  KICAD_HIER_LABEL_MISMATCH: ["Sheet pin and label mismatch", "KiCad's own ERC found a sheet pin and a hierarchical label that do not correspond.", "Rename one of them, or add the missing pin or label."],
  KICAD_ENDPOINT_OFF_GRID: ["Endpoint off the grid", "KiCad's own ERC found an endpoint that is not on the connection grid.", "Move the wire or the part so the endpoint lands on a grid point."],
  KICAD_LIBRARY_SYMBOL_ISSUE: ["Cached symbol differs from library", "KiCad's own ERC found the symbol cached in the file differing from the library's.", "Update the symbol from the library in KiCad, or keep the cached one deliberately."],
  KICAD_UNRESOLVED_VARIABLE: ["Text variable not resolved", "KiCad's own ERC found a text variable with no value in this project.", "Define the variable in the project settings, or write the text out in full."],
};

export default en;
