# Frappe Compatibility

Frappe Studio talks to Frappe Framework sites over their documented HTTP API. Frappe has
shipped for a decade and every release changes something. This document explains Frappe
Studio's compatibility approach: what is probed, what degrades, what is gated by version, and
what we will not pretend to support.

## The principle: probe, never assume

Frappe Studio never assumes an HTTP method or metadata property exists. At connect time the
fix list in `common/frappeCapabilities.ts` (`CAPABILITY_PROBES`) runs against the site and
records a map of which documented endpoints actually respond. Features consult that map; a
missing capability disables or downgrades its feature instead of producing bogus errors. When
the answer can't be determined, the product says **Unknown**.

| Capability probe | Endpoint | Used by |
| --- | --- | --- |
| `get_logged_user` | `frappe.auth.get_logged_user` | login verification |
| `csrf_token` | `frappe.auth.get_csrf_token` | mutating requests |
| `get_versions` | `frappe.get_versions` | version display and gating |
| `doctype_list` | `/api/resource/DocType?limit_page_length=1` | DocType explorer |
| `doctype_table_search` | `frappe.desk.search.search_link` | link pickers, search |
| `run_query_report` | `frappe.desk.query_report.run` | Report Runner |
| `print_view` | `/printview` | Print Format preview |
| `deskside_fs` | `frappe.desk.desk_page.getdeskpage` | desk metadata |
| `search_metadata` | `frappe.desk.search.search_widget` | global search |

`run_query_report` is deliberately soft: a structured Frappe-style 4xx for a fake
`report_name` is treated as "the method exists", not as absence — older Frappe versions also
returned 4xx from probes that were valid.

## Version detection

`frappe.get_versions` is asked at connect time. The response shape differs across Frappe
releases; `parseVersionProbe` handles the known variants with fallbacks and returns
`undefined` when the site gives nothing usable, in which case the UI shows an honest
**Unknown**. Version-unknown sites unlock features conservatively rather than hiding them,
because the capability map is the real gate; the version is metadata, not a permission.

## Version-gated metadata properties

Some DocType properties only exist since a specific Frappe major. That data is in
`METADATA_PROPERTY_SUPPORT` in `common/frappeCapabilities.ts`:

| Property | Since |
| --- | --- |
| `istree` | v11 |
| `track_views` | v12 |
| `isvirtual`, `naming_rule`, `engine` | v13 |
| `search_fields`, `timeline_new`, `custom` | always |

Notable behavior when age is in question: if no version was detected, properties are left
**visible but never written blindly**; if the version is known and too old, the property's
section is hidden in the editors rather than sent back to a server that can't parse it. This
prevents old sites from being silently handed properties they reject.

## Authentication compatibility

The Studio uses the flow that has been stable across Frappe for years:

- `POST /api/method/login` with form `usr`/`pwd`
- `GET /api/method/frappe.auth.get_logged_user` for identity
- `GET /api/method/frappe.auth.get_csrf_token` for CSRF, sent as `X-Frappe-CSRF-Token`
- `POST /api/method/logout`

OAuth, SSO, API-key based and two-factor login flows are **not** handled by Frappe Studio
1.0.0. They are future work, not hidden behind a half-working shim; sites behind SSO should be
accessed after establishing a session in a browser or via a Frappe API key — but note that
Frappe Studio never generates or manages API keys itself (see `docs/SECURITY.md`).

## REST API surface

Frappe Studio targets both styles of Frappe's HTTP surface:

- `frappe.client.*` and `frappe.desk.*` service methods under `/api/method/`
- plain REST under `/api/resource/...` (list documents, read documents, write documents)
- `/api/v2/...` (the second-generation REST API) is supported by the API Explorer path parser
- `/printview` for print format previews

## Developer mode

Developer mode is server-side config: remote detection is best-effort and often Unknown, local
benches are verified by reading `common_site_config.json`, and enabling it (local only) runs
`bench set-config developer_mode 1` + `bench clear-cache` with explicit confirmation, with
success claimed only after verification. The Studio never flips it remotely.

## Submitting an older-site bug

If you're connected to a Frappe site that Frappe Studio 1.0.0 doesn't handle, include in the
report (note these are things the UI/debug console can show you about the connection, they are
manual steps the user takes, not automatic data collection):

1. The URL normal form Frappe Studio displays for the site (scheme, host, port).
2. Which capability probes came back as absent/Unknown.
3. The Frappe framework major/minor, if displayed — "Unknown" is a valid and useful answer.
4. Which feature failed and at which step (connect / explore / edit / save / verify).

## Known incompatibilities and limitations (1.0.0)

- **SSO/OAuth/2FA login** is not supported; only_userid/password sessions, as above.
- **No raw SQL over HTTP** exists in Frappe at all, so the Database Explorer remains read-only
  on every backend; the backend is detected only as far as Frappe reports it
  (`get_versions` / system information), otherwise **Unknown** — MariaDB, PostgreSQL, SQLite
  support depends on what the server itself states, nothing is probed client-side.
- **Multiple companies / plugins in ERPNext** are treated generically — Studio is app-agnostic.
- **Frappe Server Script support** — Studio doesn't edit Server Script doctypes specially;
  they can be inspected as documents but have no dedicated editor (not implemented in 1.0.0).
