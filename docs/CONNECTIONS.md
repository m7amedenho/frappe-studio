# Connecting to Sites

Frappe Studio talks to Frappe sites over HTTP using their documented, whitelisted endpoints.
This page explains how connections work: the wizard, URL normalization, authentication,
capability probing, version detection, developer-mode handling, TLS trust, and where connection
data is stored.

## The connection wizard

The first time you open Frappe Studio you see the Frappe Studio activity-bar view with a
**Connect to Site** call to action. The wizard is a webview view that collects a site URL and
credentials, normalizes the URL, probes the site, and records the connection.

The sidebar's main sections (all inside the Frappe Studio container) are: **Overview**,
**Sites**, **Apps**, **DocTypes**, **Workflows**, **Reports**, **Print Formats**,
**API Explorer**, **Database**, **Bench**. Editors themselves (DocType Studio, Workflow
Designer, Print Format Designer, API Explorer, Report Runner, Database Explorer) open as
tabs in the native editor area.

The overview also offers **Recent Sites**, **Manage Connections**, **Documentation**, and
**Settings**.

## URL normalization rules

URLs are normalized by `common/frappeUrl.ts` *before any network activity*, so what you type
is forgiving and what is stored is clean:

- **Scheme defaults**: `http` for local origins — `localhost`, `127.*`, `10.*`, `::1`,
  `0.0.0.0`, `.local` hosts, plain single-label host names (e.g. `mybench:8000`) — and
  `https` for everything else. Only applies when you didn't type a scheme; entering
  `https://erp.example.com` keeps `https`.
- **Ports**: significant ports are kept (`:8000`, `:8443`); default ports (80/443) are
  normalized away.
- **Trailing slashes** are stripped; userinfo (`user@host`), query strings, fragments and
  paths are rejected with a clear message, since Frappe site origins are flat origins.
- Hostnames are lowercased; whitespace and obviously malformed input are rejected.

## Authentication flow

Frappe Studio uses the session-cookie flow against Frappe's service `login` method, plus CSRF
tokens for writes. The endpoints it relies on (all documented Frappe endpoints):

| Purpose | Endpoint |
| --- | --- |
| Login | `POST /api/method/login` (form-encoded `usr` / `pwd`) |
| Identity check | `GET /api/method/frappe.auth.get_logged_user` |
| CSRF token | `GET /api/method/frappe.auth.get_csrf_token` |
| Version | `GET /api/method/frappe.get_versions` |
| Logout | `POST /api/method/logout` |

After login, the client verifies the session by calling `frappe.auth.get_logged_user` and
shows the returned user; a session that logs in but cannot prove identity is treated as failed.
CSRF tokens are fetched at connect and refreshed on demand when a mutating call is rejected,
and are sent as the `X-Frappe-CSRF-Token` header on every mutating request. Logout always
calls `/api/method/logout` on the server too — connections don't just drop the client side.

Frappe Studio does **not** generate or use API keys; see `docs/SECURITY.md`.

## Capability probing

Right after login, `common/frappeCapabilities.ts` runs its fixed probe list and records a map
of what this particular site can do. Frappe versions differ in which endpoints they expose,
and the Studio refuses to assume an API exists anywhere:

| Probe | Endpoint |
| --- | --- |
| `get_logged_user` | `frappe.auth.get_logged_user` |
| `csrf_token` | `frappe.auth.get_csrf_token` |
| `get_versions` | `frappe.get_versions` |
| `doctype_list` | `/api/resource/DocType?limit_page_length=1` |
| `doctype_table_search` | `frappe.desk.search.search_link` |
| `run_query_report` | `frappe.desk.query_report.run` |
| `print_view` | `/printview` |
| `deskside_fs` | `frappe.desk.desk_page.getdeskpage` |
| `search_metadata` | `frappe.desk.search.search_widget` |

Probes that return non-2xx (or nothing usable) mark the capability **absent**, and features
that need it are either disabled in the UI or degrade to read-only. `run_query_report` is a
soft probe — a structured Frappe-style 4xx error is treated as "method exists but our
arguments are fake", not as absence. When a capability can't be determined, the product shows
**Unknown** honestly rather than guessing.

## Versions

The Studio asks `frappe.get_versions` for the framework and app versions, with fallback
parsing for the different shapes that response takes across Frappe releases. If nothing comes
back, the version is displayed as **Unknown** — features gated on version are then unlocked
conservatively rather than guessed. See `docs/FRAPPE_COMPATIBILITY.md` for how versions gate
metadata properties.

## Developer Mode detection

Developer mode is a **server-side** configuration value, not a UI flag. Frappe Studio detects
it best-effort:

- **Remote sites**: server information is often not exposed about developer mode over HTTP, so
  remote detection may honestly report **Unknown**. No remote endpoint is used to try to flip
  the setting.
- **Local benches**: the Studio inspects `common_site_config.json` in the bench directory
  through the platform file service to read the actual value.
- **Enabling it** (local benches): the Studio runs `bench set-config developer_mode 1` and
  `bench clear-cache` in the integrated terminal, **with explicit confirmation**, and claims
  success only after the config file was re-read and shows the value. It never enables
  developer mode on a remote site.

## TLS and self-signed certificates

Certificate validation is never silently disabled. A failing certificate produces a clear
diagnostic, and the wizard may offer to **trust that one self-signed certificate for this one
connection** — your decision, stored as the connection's `trusted` flag, and revocable by
connecting again without it. A global proxy setting is honored (upstream `http.proxy`
configuration).

## Where data is stored

| Data | Location | Key / service |
| --- | --- | --- |
| Site list (URL, label, trusted flag) | application storage | `frappe-studio.connections.v1` is the storage key |
| Password | OS keychain via `ISecretStorageService` | secret-service name `frappe-studio` |
| Session cookies | memory only (`connection/cookieJar.ts`) | never logged, never persisted |
| Recent sites list | application storage (same versioned namespace) | without secrets |

This makes connections portable across workspaces (site data is application storage, not
workspace) while keeping secrets in the OS keychain where the platform already puts them.

## Multi-site sessions

`connection/connectionService.ts` manages named connections and lets you switch between them
from the Sites view or the status-bar indicator. Switching changes the active session used by
every editor and view; each connection keeps its own cookie jar, capability map and version
info in memory. Logging out of one site does not touch the others.
