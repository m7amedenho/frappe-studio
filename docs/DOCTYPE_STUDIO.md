# DocType Studio

DocType Studio is the flagship editor: a visual, three-pane editor for Frappe DocType
definitions, backed by the real DocType JSON, with a separate mode for working on customizations
rather than the standard definition.

## Opening a DocType

Browse or search DocTypes in the sidebar **DocTypes** view (fed by `/api/resource/DocType`
listing and `frappe.desk.search.search_link`), then open one — DocType Studio is a webview
editor tab in the native editor area. The Studio loads the full DocType definition via
`frappe.client.get` so that nothing is lost from what the server sent.

## The three regions

### 1. Field Palette

Left pane: the standard Frappe field types — Data, Select, Link, Table, Table MultiSelect,
Check, Currency, Date, Datetime, Time, Text, Small Text, Text Editor, Code, Attach, Set,
Button, Section Break, Column Break, Page Break, Heading and friends — grouped the way the
Frappe doctype editor presents them. Clicking or dragging a field type inserts a new field
into the canvas.

### 2. Form Canvas

Center pane: the visual form layout, showing the DocType's **sections → columns → tabs** and
the fields inside them. Fields can be reordered by drag; undo/redo work on the canvas. The
canvas is a faithful projection of the DocType's `fields` array plus its layout properties —
no state is invented that the JSON wouldn't round-trip.

### 3. Properties Inspector

Right pane: the properties of the currently selected field. The critical rule: **the inspector
shows only properties that are valid for the selected fieldtype**. A Data field isn't offered
"Options" as a table link property, a Link field is, a Select shows its options list, a Table
requires an Options doctype. This keeps the inspector honest and the JSON clean.

## JSON view

DocType Studio has a JSON view that is **synchronized with the visual view** through
`common/frappeMetadata.ts`. It is the same document seen two ways, not a second editing
session. Every save goes through that layer.

### `reconcileDocType` — nothing is silently dropped

The metadata engine reconciles a visual edit back into the DocType JSON while **preserving
unknown properties**. Frappe versions differ; a field or doctype property Frappe Studio
doesn't model in its visual editors is never deleted from the JSON — it stays exactly as the
server sent it. That's the whole point: the Studio is a UI over the full JSON, not a rewrite
filter.

### `validateDocType` — saves that can't round-trip are blocked

Before a save the validator runs and **blocks the save with a problem list** when it finds:

- duplicate fieldnames,
- missing fieldtypes,
- fieldtypes unknown to Frappe Studio,
- missing `options` for Table-family fields (`Table`, `Table MultiSelect`, and Link, which
  requires a target DocType).

Failures surface as problems, and the tab stays dirty until fixed. This is why saves don't
need the frustration of "Frappe rejected my submit" — the Studio blocks earlier, with the
specific problem names.

## Metadata outside the canvas — Raw JSON sections

DocType metadata has advanced areas — **permissions** (per-role permission matrix),
**naming series / `autoname`**, **search fields**, **sort field/order**, **title field**,
**image field**, **event handlers / custom scripts** — that have rich UIs inside Frappe's
own Desk. Frappe Studio 1.0.0 represents these as **raw JSON sections** in the JSON view:
they're visible, editable exactly as the server sent them, and re-preserved on save. Nothing
the server sent is ever dropped. Dedicated UI for these areas is future work.

## Saving

Save flows through the standard Frappe client API:

- an existing DocType is saved with `POST` to the `frappe.client.update` whitelist method;
- a new DocType is created with `frappe.client.insert`.

After every write comes a **reload request**: the Studio re-reads the doc from the server and
the editor's in-memory state is restored from what the server now reports. Only if the
resaved-reload round-trip matches the intended state is success claimed — this is what makes
local-only crashes on writes impossible, and it's why saves can discover things like "the
server reordered/truncated properties" and show you rather than guessing.

Creates never falsely succeed, and the Studio honestly reports when the round-trip did not
match what it meant to write.

## Customize Form vs. standard metadata

Editing the schema of an existing, installed doctype (like ones shipped by ERPNext) is usually
a **mistake** — the supported path is a *customization*, done with `Custom Field` and
`Property Setter` records layered over the original definition. Frappe Studio has a separate
**Customize Form** flow:

- You open a doctype *as a customization* instead of editing it directly.
- The **original standard DocType is shown read-only** for reference, so you can see exactly
  what you're customizing away from.
- Customizations are concrete documents: **`Custom Field`** records (add a field) and
  **`Property Setter`** records (mark a property on a doctype or field) created/updated/
  deleted via `frappe.client.insert` / `update` / `delete`.
- **Reset customization** deletes **only the customization documents** (`Custom Field` +
  `Property Setter` for that doctype), never the underlying standard definition, with a
  confirmation first.

The distinction matters and is surfaced everywhere:

| Layer | What it is | Where edited | Where stored |
| --- | --- | --- | --- |
| Standard metadata | The DocType document as shipped | DocType Studio (schema edits) | DocType record on the server |
| Custom fields | `Custom Field` documents layered on top | Customize Form | separate `Custom Field` docs |
| Property setters | `Property Setter` documents overriding properties | Customize Form | separate `Property Setter` docs |

For the save mechanics, everything above shares the same clean round trip: update/insert →
reload → verify.

See also `docs/SECURITY.md` for why credentials and the cookie jar never leave the workbench
and `docs/WORKFLOW_DESIGNER.md` for editing Workflow documents (not DocTypes).
