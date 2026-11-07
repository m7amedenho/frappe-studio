# Remote Mode

Remote mode is Frappe Studio connecting to a **hosted Frappe site** over HTTPS — something
like `https://erp.example.com` (self-hosted VPS, Frappe Cloud, a customer's staging box) that
you did not start yourself and cannot run `bench` on directly.

## What remote mode means

The connection wizard normalizes the URL (defaults to `https` for anything that isn't a local
origin), logs you in with `POST /api/method/login` using your `usr`/`pwd`, verifies identity
via `frappe.auth.get_logged_user`, and then probes capabilities against the site's documented
endpoints. From there, everything in the product works against the live site's HTTP API:

- **DocType Studio** reads and writes real DocType metadata through `frappe.client.*`
  (`insert` to create, `update` to save, with a reload request after each write to verify).
- **Customize Form** works on `Custom Field` and `Property Setter` documents via
  `frappe.client.insert/update/delete`, with the original standard DocType shown read-only.
- **Workflow Designer** saves actual `Workflow` documents through `frappe.client.*`.
- **Reports Studio** opens report sources through the `frappe-report:` file-system provider
  (backed by `frappe.client.update` on the Report document) and runs them via
  `frappe.desk.query_report.run` — the documented, whitelisted method. Nothing arbitrary is
  executed server-side.
- **Print Format Designer** edits the real `Print Format` document fields (page size, margins,
  header/footer HTML, `custom_html`, `css`, `print_uom`) and fetches live preview HTML from
  the server's `/printview` route using your session.
- **API Explorer** sends GET/POST/PUT/DELETE through the authenticated session; mutating
  requests have a confirmation step.
- **Database Explorer** is read-only (list views via `frappe.client.get_list`; the query
  editor only accepts read-shaped queries client-side).
- **Site Explorer / Apps / DocTypes tree views** walk the site's metadata and app list.

## What remote mode cannot do

Frappe Studio is explicit about the boundary rather than faking local superpowers:

- **No bench commands**. A managed host doesn't give you a bench process. The Bench Manager's
  discovery and commands assume a bench directory you can point at locally; for a remote host
  you run bench operations yourself where the host allows it (e.g. Frappe Cloud's own dashboard
  or shell), and Frappe Studio doesn't pretend otherwise.
- **Developer mode** is often unverifiable remotely: it's server-side configuration, and
  detection may report **Unknown**. Remote sites are never switched into developer mode by the
  Studio — enabling it is only offered for local benches (see `docs/LOCAL_MODE.md`).
- **No raw SQL** — Frappe does not expose SQL over HTTP at all, in any mode.
- **Server-side files** (app source, hooks.py beyond what a Report doctype opens, etc.) are
  not editable remotely; Reports Studio edits Report *documents*, not their `.py` files on disk.

## Operational notes

- **Sessions** live in memory only; closing Frappe Studio ends the client session. The server
  session keeps running until Frappe expires it, which is why special care is taken to always
  call `POST /api/method/logout` when you disconnect.
- **CSRF**: fetched at connect, refreshed on demand; sent as `X-Frappe-CSRF-Token` on
  mutating requests.
- **Self-signed certificates**: remote listeners with TLS problems get an explicit
  diagnostic; trusting such a certificate for one connection is optional and remembered as
  the connection's `trusted` flag.
- **Versions**: read via `frappe.get_versions` with fallbacks; unanswerable → shown as
  "Unknown". Feature gating then lets you try features instead of silently hiding them, and
  capability probes disable genuinely missing endpoints.
- **Rate limits / request queueing**: the client serializes per-site requests so a slow site
  or a fragile production box isn't hammered by parallel probes during login.

## Guidance for production sites

Working against a production ERPNext instance is supported but requires care: every save goes
through validation that blocks obviously destructive writes (duplicate fieldnames, missing
fieldtypes, Table fields without options), and reload-after-write verification is what the
Studio relies on to confirm success. If verification fails after a write, the Studio reports
the failure rather than claiming the save landed. Destructive operations always confirm
beforehand.
