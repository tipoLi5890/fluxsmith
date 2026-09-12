// SPDX-License-Identifier: Apache-2.0
// Built-in workflows as constants (agent-runtime.md §9.2). They pass the same
// static rules as user YAML; the M4 YAML parse must deep-equal these.

import { DRAFTER_CONCURRENCY_DEFAULT } from "../limits";
import type { WorkflowDef } from "./schema";

export const GREENFIELD_DESIGN: WorkflowDef = {
  id: "greenfield-design",
  version: 1,
  mode: "build",
  limits: { max_applies: 80, max_sheets: 8, concurrency: DRAFTER_CONCURRENCY_DEFAULT },
  phases: [
    { kind: "phase", id: "plan", mode: "plan", requires_consent: true, steps: [
      { kind: "agent", id: "intake", role: "architect", tools: ["sch.summary", "lib.search", "skill.open", "ask_user", "plan.write"], output: "DesignPlan" },
      { kind: "agent", id: "parts", role: "librarian", tools: ["lib.search", "lib.resolve", "lib.symbol", "sch.pins"], output: "PartBinding[]" },
      { kind: "approval", id: "adopt", approves: "plan" },
    ] },
    { kind: "phase", id: "build", mode: "build", requires_consent: true, steps: [
      { kind: "approval", id: "scaffold_ok", approves: "structural" },
      { kind: "foreach", id: "scaffold", items: "plan.sheets[create=true]", concurrency: 1, steps: [
        { kind: "tool", id: "create_sheet", tool: "sheet.create", structural: true },
      ] },
      { kind: "foreach", id: "resolve_parts", items: "plan.blocks", concurrency: 1, steps: [
        { kind: "tool", id: "convert", tool: "parts.convert" },
      ] },
      { kind: "foreach", id: "blocks", items: "plan.blocks", concurrency: DRAFTER_CONCURRENCY_DEFAULT, steps: [
        { kind: "agent", id: "draft", role: "drafter", tools: ["sch.summary", "sch.pins", "sch.bbox", "lib.resolve", "lib.symbol", "ops.template", "ops.validate", "sch.dryrun_scratch", "skill.open"], output: "OpList" },
      ] },
      { kind: "foreach", id: "verify_apply", items: "plan.blocks", concurrency: 1, steps: [
        { kind: "tool", id: "validate", tool: "ops.validate" },
        { kind: "tool", id: "expand", tool: "ops.expand" },
        { kind: "checkpoint", id: "cp" },
        { kind: "loop", id: "fix_pre", max: 3, steps: [
          { kind: "tool", id: "dry", tool: "sch.plan" },
          { kind: "gate", id: "pre_gate", source: "integrity.errors", op: "==", value: 0 },
          { kind: "agent", id: "fix", role: "fixer", tools: ["sch.dryrun_scratch", "ops.validate", "skill.open"], output: "OpList" },
        ] },
        { kind: "tool", id: "apply", tool: "sch.apply" },
        // Alternative apply when the block's remaining findings are covered by recorded waivers.
        { kind: "tool", id: "apply_waived", tool: "sch.apply_waived" },
        { kind: "tool", id: "post", tool: "check.integrity" },
        { kind: "gate", id: "post_gate", source: "check.errors", op: "==", value: 0 },
      ] },
      { kind: "foreach", id: "wiring", items: "plan.steps[kind=wiring]", concurrency: 1, steps: [
        { kind: "agent", id: "wire_draft", role: "drafter", tools: ["sch.summary", "sch.pins", "sch.bbox", "ops.validate", "sch.dryrun_scratch", "skill.open"], output: "OpList" },
        { kind: "tool", id: "wire_plan", tool: "sch.plan" },
        { kind: "gate", id: "wire_gate", source: "integrity.errors", op: "==", value: 0 },
        { kind: "tool", id: "wire_apply", tool: "sch.apply" },
      ] },
      { kind: "tool", id: "gate_run", tool: "gate.run" },
      { kind: "gate", id: "final", source: "gate.ok", op: "==", value: true },
      { kind: "approval", id: "intent", approves: "intent" },
      { kind: "tool", id: "intent_snapshot", tool: "intent.snapshot" },
      { kind: "note", id: "note", text: "plan completed" },
    ] },
  ],
};

export const INCREMENTAL_EDIT: WorkflowDef = {
  id: "incremental-edit",
  version: 1,
  mode: "build",
  limits: { max_applies: 4, max_sheets: 2, concurrency: 1 },
  phases: [
    { kind: "phase", id: "build", mode: "build", requires_consent: true, steps: [
      { kind: "agent", id: "draft", role: "drafter", tools: ["sch.summary", "sch.pins", "sch.bbox", "lib.resolve", "lib.symbol", "ops.template", "ops.validate", "sch.dryrun_scratch", "skill.open"], output: "OpList" },
      { kind: "tool", id: "validate", tool: "ops.validate" },
      { kind: "tool", id: "expand", tool: "ops.expand" },
      { kind: "checkpoint", id: "cp" },
      { kind: "loop", id: "fix_pre", max: 3, steps: [
        { kind: "tool", id: "dry", tool: "sch.plan" },
        { kind: "gate", id: "pre_gate", source: "integrity.errors", op: "==", value: 0 },
        { kind: "agent", id: "fix", role: "fixer", tools: ["sch.dryrun_scratch", "ops.validate", "skill.open"], output: "OpList" },
      ] },
      { kind: "tool", id: "apply", tool: "sch.apply" },
      { kind: "tool", id: "post", tool: "gate.run" },
      { kind: "gate", id: "post_gate", source: "gate.ok", op: "==", value: true },
    ] },
  ],
};

export const DESIGN_REVIEW: WorkflowDef = {
  id: "design-review",
  version: 1,
  mode: "review",
  phases: [
    { kind: "phase", id: "review", mode: "review", steps: [
      { kind: "tool", id: "project", tool: "project.check" },
      { kind: "tool", id: "gate", tool: "gate.run" },
      { kind: "tool", id: "style", tool: "check.style" },
      { kind: "tool", id: "intent", tool: "check.intent" },
      { kind: "tool", id: "diff", tool: "diff.nets", args: { before: "session_open" } },
      { kind: "agent", id: "review", role: "reviewer", tools: ["sch.summary", "sch.read", "sch.nets", "sch.component", "check.integrity", "check.erc", "check.nets", "check.power", "gate.run", "diff.nets", "skill.open"], output: "Finding[]" },
    ] },
  ],
};

export const FIX_FINDINGS: WorkflowDef = {
  id: "fix-findings",
  version: 1,
  mode: "build",
  limits: { max_applies: 8, max_sheets: 4, concurrency: 1 },
  phases: [
    { kind: "phase", id: "build", mode: "build", requires_consent: true, steps: [
      { kind: "foreach", id: "findings", items: "findings[selected=true]", concurrency: 1, steps: [
        { kind: "agent", id: "fix", role: "fixer", tools: ["sch.summary", "sch.pins", "sch.dryrun_scratch", "ops.validate", "skill.open"], output: "OpList" },
        { kind: "checkpoint", id: "cp" },
        { kind: "tool", id: "dry", tool: "sch.plan" },
        { kind: "gate", id: "gate", source: "integrity.errors", op: "==", value: 0 },
        { kind: "tool", id: "apply", tool: "sch.apply" },
      ] },
    ] },
  ],
};

export const ADOPT_EXISTING: WorkflowDef = {
  id: "adopt-existing",
  version: 1,
  mode: "plan",
  phases: [
    { kind: "phase", id: "plan", mode: "plan", steps: [
      { kind: "tool", id: "summary", tool: "sch.summary" },
      { kind: "tool", id: "check", tool: "gate.run" },
      { kind: "agent", id: "reverse", role: "architect", tools: ["sch.summary", "sch.read", "sch.nets", "sch.component", "lib.resolve", "plan.write"], output: "DesignPlan" },
      { kind: "approval", id: "adopt", approves: "plan" },
    ] },
  ],
};

export const SOURCE_BOM: WorkflowDef = {
  id: "source-bom",
  version: 2,
  mode: "build",
  limits: { max_applies: 40, max_sheets: 8, concurrency: 1 },
  phases: [
    { kind: "phase", id: "build", mode: "build", requires_consent: true, steps: [
      { kind: "tool", id: "summary", tool: "sch.summary" },
      { kind: "foreach", id: "parts", items: "components[fitted=true]", concurrency: 1, steps: [
        { kind: "agent", id: "resolve", role: "sourcer", tools: ["parts.search", "parts.show", "parts.datasheet", "lib.resolve", "sch.component", "skill.open"], output: "SourcingResult" },
        { kind: "tool", id: "decision", tool: "parts.decision", args: { items: "{{ resolve.output.items }}", rationale: "{{ resolve.narrative }}" } },
        { kind: "checkpoint", id: "cp" },
        { kind: "tool", id: "bind", tool: "sch.apply", args: { oplist: "{{ decision.oplist }}", target: "{{ item.sheet }}", expected_merges: [], note: "source-bom binding" } },
      ] },
      { kind: "tool", id: "lock", tool: "parts.bom", args: { lock: true } },
    ] },
  ],
};

export const DATASHEET_FIRST: WorkflowDef = {
  id: "datasheet-first",
  version: 1,
  mode: "plan",
  phases: [
    { kind: "phase", id: "plan", mode: "plan", steps: [
      { kind: "foreach", id: "critical", items: "plan.parts[critical=true]", concurrency: 2, steps: [
        { kind: "agent", id: "facts", role: "facts", tools: ["parts.datasheet", "docs.pdf_text", "facts.write", "skill.open"], output: "DatasheetFacts" },
      ] },
      { kind: "ask_user", id: "audit", question: "Audit extracted facts now or later?", options: ["now", "later"], default: "later" },
    ] },
  ],
};

export const BUILTIN_WORKFLOWS: readonly WorkflowDef[] = [GREENFIELD_DESIGN, INCREMENTAL_EDIT, DESIGN_REVIEW, FIX_FINDINGS, ADOPT_EXISTING, SOURCE_BOM, DATASHEET_FIRST];
