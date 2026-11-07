# Frappe Studio Architecture

Frappe Studio is a Frappe Framework IDE built as a fork of Code-OSS (the MIT-licensed open
source project that Visual Studio Code is built from). Code-OSS is developed by the community
and owes a great deal to its Microsoft contributors; Frappe Studio acknowledges that heritage
and remains MIT-licensed. All Frappe Studio-specific product code is new code that lives almost
entirely inside one contribution package, so the upstream codebase stays as close to stock as
possible.

Product version: Frappe Studio 1.0.0 on a Code-OSS base of 1.146.0 (base commit
`1745a4a6102e93173430b4b2debc1247a91cd036`). See `docs/upstream/` for how the fork tracks
upstream.

## Design principle: contribute, don't fork

Frappe Studio is integrated natively into the workbench exactly the way the built-in git, SCM
and debug features are: as a workbench contribution package at
`src/vs/workbench/contrib/frappeStudio/`. There is no extension host indirection, no separate
client/server process, and no framework of its own. Frappe Studio uses the platform's editors,
views, terminals, secret storage and file services directly.

The complete list of upstream files that had to be touched is three files long and is tracked
in `docs/upstream/MODIFIED_UPSTREAM_FILES.md`:

| File | Change |
| --- | --- |
| `src/vs/workbench/workbench.common.main.ts` | a single import registering the contribution |
| `product.json` | product branding identifiers |
| `package.json` | product name, version and Frappe Studio npm scripts |

Everything else is additive: new directories, new workflows, new scripts.

## Contribution package layout

```
src/vs/workbench/contrib/frappeStudio/
├── common/        pure domain logic, no service dependencies, fully unit-testable
│   ├── frappeTypes.ts        Frappe document/metadata TypeScript types
│   ├── frappeUrl.ts          site URL normalization and validation
│   ├── frappeMetadata.ts     DocType metadata engine (reconcile/validate/sync)
│   └── frappeCapabilities.ts capability probing and version parsing
├── connection/    session and transport layer
│   ├── cookieJar.ts          in-memory session cookie container
│   ├── frappeClient.ts       authenticated HTTP client
│   └── connectionService.ts  multi-site session manager
├── editors/       webview-based editors
│   ├── frappeWebviewEditor.ts        shared webview editor base
│   └── (DocType Studio, Workflow Designer, API Explorer,
│        Print Format Designer, Report Runner, Database Explorer)
├── views/         native sidebar panes
│   └── (Overview/Site Explorer, Apps, DocTypes, Bench)
├── test/          unit tests (mocha TDD, no network)
└── frappe.contribution.ts   registration point for everything below
```

`frappe.contribution.ts` is the only file that wires the package into the platform. It
registers:

- the **Frappe Studio activity-bar view container** and the views inside it
- the **webview editor input serializers** for the custom editors
- all **commands** (including `frappeStudio.about`, the Frappe Studio About dialog)
- **settings** (the `frappe-studio.*` setting namespace)
- the **status-bar connection indicator**
- **keybindings**

## What the product surfaces are

Frappe Studio's features are delivered through exactly three kinds of surface:

1. **Native sidebar view panes** (`views/`) — Overview/Site Explorer, Apps, DocTypes, Workflows,
   Reports, Print Formats, API Explorer, Database, Bench. These are ordinary workbench views in
   the Frappe Studio activity-bar container, styled like the rest of the workbench.
2. **Webview editors** (`editors/`) — DocType Studio, Workflow Designer, Print Format Designer,
   API Explorer, Report Runner and Database Explorer open as editor tabs in the native editor
   area. All webviews are CSP-restricted (nonce-based scripts, no remote resources).
3. **The integrated terminal** — bench operations run real `bench` commands in the native
   integrated terminal, in the context's working directory (via `wsl.exe` when the bench lives
   inside WSL). Frappe Studio never shells out invisibly: every bench command is visible to the
   user in a terminal pane.

Two exceptions deliberately use the platform differently:

- **Reports Studio** opens SQL/Python report sources as *real* text editors via a file-system
  provider registered for the `frappe-report:` URI scheme, backed by `frappe.client.update` on
  the Report document. This gives reports the standard editing experience: undo, diff,
  formatting, problems view.
- **Bench Manager** reads local bench directories through the platform file service, so
  discovery is just directory listing, not a shell integration.

## Connection layer

The connection layer is the transport everything else rides on.

- **Auth endpoints used** (real Frappe endpoints only): `POST /api/method/login` (form
  `usr`/`pwd`), `GET /api/method/frappe.auth.get_logged_user` (identity check), `GET
  /api/method/frappe.auth.get_csrf_token` (CSRF token, sent as `X-Frappe-CSRF-Token` on every
  mutating request), `POST /api/method/logout`.
- **Capability probing**: at connect time `common/frappeCapabilities.ts` runs its
  `CAPABILITY_PROBES` list (`get_logged_user`, `csrf_token`, `get_versions`, `doctype_list`
  via `/api/resource/DocType`, `search_link`, `query_report.run`, `/printview`, `getdeskpage`,
  `search_widget`) and records a capability map. Features degrade gracefully to an honest
  *Unknown* state rather than guessing.
- **Version detection**: `GET /api/method/frappe.get_versions`, with fallbacks, producing an
  explicit "unknown" state when the site does not answer.
- **Multi-site sessions**: `connectionService.ts` keeps named connections; the status bar
  shows the active one. Site metadata is persisted in application storage under the key
  `frappe-studio.connections.v1`; credentials live in the platform secret storage
  (`ISecretStorageService`, OS keychain-backed) under the service name `frappe-studio`.

See `docs/CONNECTIONS.md` for the user-facing contract and `docs/SECURITY.md` for the security
model.

## Persistence summary

| Data | Where | Key / service |
| --- | --- | --- |
| Site list (URLs, labels, trusted flags) | application storage | `frappe-studio.connections.v1` |
| Passwords / credentials | OS secret storage (`ISecretStorageService`) | service `frappe-studio` |
| Session cookies | memory only (`cookieJar.ts`) | never written to disk, storage or logs |
| API Explorer history | application storage, per session | auth headers are never stored |

## Guidelines for new code

- Put anything that must be testable in `common/`. That directory stays pure: no service
  injection, no network calls, no workbench imports.
- Network access only goes through `frappeClient.ts`; never construct site requests elsewhere.
- Use only documented, whitelisted Frappe HTTP endpoints. Frappe Studio never attempts
  arbitrary server-side code execution through Frappe endpoints.
- Register new UI in `frappe.contribution.ts` (or a contribution file it imports), not by
  importing package modules directly from upstream files.
- Add unit tests in `test/` following the repository's mocha TDD (`suite`/`test`) conventions.
  Unit tests never touch the network.

## Known limitations (honest status)

- **No extension shim for VS Code marketplace extensions** beyond what Code-OSS already ships;
  Frappe Studio inherits Code-OSS's open-source-only extension model.
- **Bench auto-discovery is not automatic** — bench contexts are configured explicitly by the
  user.
- **Raw SQL over HTTP does not exist** in Frappe; the Database Explorer is read-only by design
  and destructive SQL is disabled (see `docs/LOCAL_MODE.md` for the bench path).
- **Developer Mode detection** relies on server-side configuration and may report *Unknown*.
- **macOS** is untested and unsupported for the 1.0.0 release; Windows x64 and Linux x64 are
  the supported targets.
