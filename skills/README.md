# `skills/` — built-in agent skills

Skills in the Agent Skills format (`SKILL.md` with YAML front matter, plus optional `references/`),
written against fluxsmith's own tool catalogue. **They are written in English**, like every other
instruction the model sees; only replies to the user and UI copy follow the user's language.

Loading is layered: an L0 digest (200 words or fewer) stays resident, and an L1 section is pulled in
on demand by name. Finding zero skills is a loud failure, not a silent one.

| Skill | Covers |
|---|---|
| `schematic-authoring` | Drawing conventions, placement, when to use which op |
| `net-naming` | Naming, scope, rails, and the fixer routes for scope problems |
| `schematic-review` | Reading back findings and triaging them |
| `parts-sourcing` | Searching for a part and converting vendor CAD into a KiCad library |
| `datasheet-facts` | Extracting facts from a datasheet with a pinned page and quotation |

Users can extend this with their own **skill packs** (`SKILL.md` + `workflow.yaml` + `references/`).
A pack is untrusted input: its trust state is stored in app data, never inside a project and never
in git, its manifest sha256 covers every file, and an untrusted pack is neither loaded nor indexed.
Workflows carrying a write tool must declare Build mode and their limits, must put an approval step
before any structural step, may only take a verdict from an engine result field, and need a second
consent separate from trusting the skill itself.
