# Workflow Designer

The Workflow Designer is a visual editor for Frappe's **Workflow** doctype and nothing else.
There is no alternate workflow engine, no hidden runtime, no simulated state machine — the
designer edits real `Workflow` documents stored on the connected Frappe site, and saves them
through `frappe.client.*` like any other document.

## The canvas

The designer is a webview editor tab with a canvas showing:

- **State nodes** — each workflow state rendered as a node (name, document-status mapping,
  whether editing is allowed in that state).
- **Transition arrows** — directed edges between states, each carrying the action (e.g.
  *Approve*, *Reject*), the target state, the roles allowed to perform it, an optional
  condition expression, and the self-approval flag.

Nodes and arrows are both directly manipulable: states can be added and connected, and
transitions can be re-targeted. The canvas is a faithful projection of the Workflow document's
JSON — the same document, visualized.

## The JSON: the Frappe Workflow doctype, exactly

The designer's JSON is the Workflow document shape from Frappe core, field for field:

```jsonc
{
  "document_type": "Leave Application",
  "states": [
    { "state": "Pending", "doc_status": 0, "allow_edit": "All" },
    { "state": "Approved", "doc_status": 1, "allow_edit": "HR User" }
  ],
  "transitions": [
    {
      "state": "Pending",
      "action": "Approve",
      "next_state": "Approved",
      "allowed": ["HR User"],
      "condition": null,
      "allow_self_approval": false
    }
  ]
}
```

Naming, types and semantics are Frappe's own: `doc_status` maps to Frappe's document status
flow (draft → submitted → cancelled), `allowed` is the role array, `condition` is the
expression Frappe itself evaluates, and `allow_self_approval` is Frappe's field. The designer
does not rename fields, add invented fields, or hide Frappe's — anything the server sends is
preserved (per the metadata engine's preserve-unknown-properties rule, see
`docs/DOCTYPE_STUDIO.md`).

## Validation

Before a save the designer validates the workflow and blocks it with named problems:

- **Initial state presence** — exactly one top-of-flow state must exist; workflows without an
  unambiguous starting state do not round-trip when Frappe loads them.
- **Unreachable states** — states not pointed to by any transition are flagged (not fatal, but
  reported before you save).
- **Transitions with a missing `next_state`** — dangling arrows are a hard block, since Frappe
  would render a broken state machine.
- **Roles missing** — transitions with empty `allowed` can never be executed by anyone and are
  flagged at save time.

Problems appear before write, matching the quality model of DocType Studio's
`validateDocType` (duplicate fieldnames, missing fieldtypes, missing table options etc.) and
give you one coherent experience: the Studio blocks, names the problem, and leaves the
document dirty until you fix it.

## Saving

Saves go through `frappe.client.*` (using `insert` if it's a new Workflow document, `update`
otherwise), followed by a **reload-and-verify read** from the server after the write, so a
successful save is only claimed when the server re-reports the workflow back the way the
Studio wrote it. The save is confirmed inside the editor's regular Save flow, no hidden
submit-side tricks.

## What it is deliberately NOT

- **Not a BPM engine.** There is no "Studio workflow runtime" concept, no parallel custom
  state machine bundled; Frappe's server is the only workflow engine the site has.
- **Not a document-level automation target.** Workflow documents reference roles and doctypes
  already present on the site; the designer will not create roles or doctypes for you.
- **Not a mapper for non-Workflow things**: business processes not represented by a `Workflow`
  doctype record are out of scope; if Frappe grows a new workflow mechanism, the designer
  will grow for it explicitly, not pretend to cover it retroactively.
