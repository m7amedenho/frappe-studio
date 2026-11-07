# Troubleshooting

Practical troubleshooting for Frappe Studio. Frappe Studio is based on Code-OSS (MIT-licensed,
from the community — with thanks to its Microsoft contributors), so Code-OSS's own
troubleshooting applies to the workbench itself; this page covers Frappe Studio's surfaces.

Iron rule throughout: connection and TLS problems are shown as diagnostics, never silenced —
a certificate is **never silently disabled** for validation.

## Connection failures

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "Unable to resolve host" name-resolution style error | DNS failure, wrong hostname, or no network path | Check the URL the wizard normalized (or paste the exact URL). `localhost` vs `127.0.0.1` matters when IPv6-only resolves; inside WSL, use the hostname bench actually serves (`localhost:8000`). |
| "Connection refused" on a local origin | bench isn't running, or wrong port | Start the bench (`bench start`) — conveniently from the Bench Manager — and recheck the port (`8000` default). |
| Certificate validation failure (self-signed, hostname mismatch, expired, unknown authority) | the site's TLS is not properly signed, or you're hitting an interception proxy | Read the diagnostic — it names the failure kind. If it's genuinely a self-signed cert you control, the wizard offers explicit one-connection trust (stored as the connection's `trusted` flag); fix the certificate otherwise. Trust as a workaround is a user decision, shown in the wizard, and revocable. |
| Corporate proxy / "tunnel" errors | app proxy setting is absent or wrong | Frappe Studio honors the upstream proxy configuration; set `http.proxy` (and related settings) to match your network. Then reconnect. |
| 401 credentials rejected after login | wrong credentials, or the site invalidated an existing session | Re-enter the credentials; if the site forbids concurrent sessions, log out elsewhere first. Frappe Studio always calls `POST /api/method/logout` when you disconnect, so a stale session usually shows up as "session expired", not 401. |
| "Session expired" | cookie session ended on the server (uptime restart, logout elsewhere, or long idle) | Reconnect — Frappe Studio's cookie jar is in-memory only, so it reauthenticates cleanly. Nothing to reset client side. |
| CSRF token rejected on save | the site regenerates CSRF tokens (session rotation or server restart) | Frappe Studio refreshes on demand when it sees a CSRF failure; if it doesn't recover, disconnect and reconnect. |
| Login succeeds but identity verification fails (no user returned) | a proxy or middlebox stripped the session cookie | Look for interception (same troubleshooting as proxy above); cookie must survive the round trip to `/api/method/frappe.auth.get_logged_user`. |

## Capability / version oddities

- Probes are honest: if an endpoint isn't there, the feature that needs it says so (or is
  disabled) rather than erroring cryptically mid-action. When in doubt whether something
  truly is missing or the site is a nonstandard fork, use the API Explorer to call the
  endpoint directly and compare.
- If the version shows **Unknown**, that's a deliberate state, not a bug — the connection
  works and version-gated features stay unlocked.

## Bench detection issues

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Bench view empty | discovery is not automatic; the Studio never guesses bench roots | Add a bench root under `frappe-studio.bench.contexts` (setting: a list of bench root directories, each optionally marked `wsl`). |
| Right bench shown but no sites / apps listed | the platform file service can't browse that root | Check path/type (a bench root is the directory containing `sites/` and `apps/`). On Windows a WSL path must be the `wsl`-marked form, e.g. `\\wsl$\Ubuntu-22.04\home\user\frappe-bench` with the context marked `wsl`. |
| WSL bench commands silently do nothing | `wsl.exe` is unavailable or the default distribution has no bench installed | Open a plain WSL terminal and confirm `bench` works there first. Frappe Studio runs bench via `wsl.exe` only for contexts marked `wsl`, and always with visible output in the integrated terminal. |
| `drop-site` looks missing, or asks first | it — like `migrate`, `new-site`, backup restore — is destructive | That's by design; destructive bench command classes always ask. |
| Developer mode toggles never verify | config file isn't readable, or the terminal runs in the wrong cwd | Enabling runs `bench set-config developer_mode 1` + `bench clear-cache` in the terminal and re-reads `common_site_config.json`. Success is only claimed when the re-read confirms the value; if verification fails, look at the terminal pane output for the actual error. Remote sites: Developer Mode is **server-side** configuration — detection may honestly report Unknown, and Frappe Studio never flips it remotely. |

## Common build errors

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `pnpm install` fails building a native module on Windows (node-gyp stage) | native modules require the Visual Studio 2022 Build Tools with the **C++ workload** | Install via the VS Installer, then re-run `pnpm install`. |
| Compilation succeeds but `pnpm install` pins a different node | wrong Node.js major | Frappe Studio pins Node 24.22.1 (`.nvmrc`); run `node -v` and use nvm to select it. Other majors break shims/native module resolution. |
| TypeScript errors in upstream files after an upstream sync | partial or conflicting merge | See `docs/upstream/CONFLICT_POLICY.md` and `docs/upstream/UPDATE_GUIDE.md`. Do not hand-patch; re-run the intended sync flow. |
| Frappe Studio views missing from the activity bar after a merge | the single frappeStudio contribution import in `src/vs/workbench/workbench.common.main.ts` was dropped | Re-apply the import line per `docs/upstream/MODIFIED_UPSTREAM_FILES.md`. This is the most merge-sensitive 1-line change in the repo. |
| Branding shows "Code - OSS" instead of "Frappe Studio" | `product.json` branding edits were overwritten | Re-apply `product.json` per `docs/upstream/MODIFIED_UPSTREAM_FILES.md` (nameShort "Frappe Studio", `applicationName` `frappe-studio`, `dataFolderName` `.frappe-studio`, `urlProtocol` `frappe-studio`, plus `win32*` identifiers). |
| `pnpm run eslint` failures in frappeStudio code | contribution drifted from repo hygiene rules | Fix in place; the frappeStudio area is Frappe Studio-authored code, and follow-up improvements are welcome in a normal PR. |

## Verification against a disposable development Frappe site

Unit tests never touch the network, which means real end-to-end verification needs a **real
Frappe site**, and this procedure requires you to have one (typically: your own disposable
`frappe_docker`-style setup, or a local bench you can tear down). There's no mock server in
the repo. Use a **throwaway** site; do not run these flows against a site you care about.

1. Stand up a disposable site (bench `new-site` on a local bench, or a containerized site) and
   note the URL (e.g. `http://localhost:8000` — an origin that will default to `http` in the
   connection wizard for local address ranges per `docs/LOCAL_MODE.md`).
2. Run Frappe Studio from source (`pnpm run compile`, then `scripts\code.cmd` on Windows /
   `./scripts/code.sh` on Linux) and connect through the **Connect to Site** wizard.
3. Walk the base loop: connect → capability probe runs (observe capabilities in the connection
   status) → browse DocTypes → edit a DocType → save → **confirm the reload-after-write
   verification passes** in the DocType Studio editor.
4. Try the other editors: Reports Studio (open a `frappe-report:` file, run the report via
   `frappe.desk.query_report.run`), Print Format Designer (live preview against `/printview`),
   API Explorer (one GET, then one mutating call to exercise the confirm step).
5. Exercise a destructive path deliberately once (Customize Form reset) and confirm the
   confirmation step appears.
6. Finally: disconnect (`POST /api/method/logout` runs), reconnect, confirm the site from
   **Recent Sites**, and delete the disposable site.

If your report is about save/round-trip behavior, including what the reload-after-write step
showed (the diff or error printed in the editor) is the single most useful detail you can add.
