# Local Mode

Local mode is Frappe Studio talking to a Frappe site you run yourself — `bench start` on
`localhost:8000`, a container, or a bench inside Windows Subsystem for Linux (WSL). Local mode
is where the Bench Manager and developer-mode tooling live.

## Connecting to a local site

Type the address the bench printed, e.g. `localhost:8000`. Because it's a local origin the
URL normalizer (`common/frappeUrl.ts`) defaults it to `http` automatically:
`localhost`, `127.*`, `10.*`, `0.0.0.0`, `::1`, `*.local` hosts, and plain single-label host
names (like `mybench:8000` on a LAN) all keep `http` unless you explicitly type `https://`.
Trailing slashes are stripped; significant ports (`:8000`) are kept.

Everything from `docs/CONNECTIONS.md` applies identically: form `usr`/`pwd` login through
`POST /api/method/login`, identity check with `frappe.auth.get_logged_user`, CSRF via
`frappe.auth.get_csrf_token`, and the capability probe run against the freshly connected
session.

## Enabling developer mode

Frappe's developer mode is **server-side configuration** (`developer_mode` in
`common_site_config.json`), not a UI flag; the Studio does not maintain a client-side toggle.

Detection:

- The Studio reads `common_site_config.json` from the bench directory via the platform file
  service when a bench context is configured, so for local benches the value shown is real.
- For remote sites, detection is best-effort and may honestly report **Unknown**.

Enabling (local benches only, never remote):

1. The Studio asks for explicit confirmation.
2. It runs `bench set-config developer_mode 1` in the integrated terminal, in the bench
   context's working directory (via `wsl.exe` for WSL contexts).
3. It runs `bench clear-cache` next.
4. It re-reads `common_site_config.json` and only reports success once the value is actually
   there — otherwise it reports what it saw. Enabling developer mode is never claimed as done
   without verification.

## The Bench Manager

The Bench Manager view is where bench operations happen, and they happen **in the integrated
terminal**, in plain sight:

- **Discovery is explicit.** Configure bench contexts with the `frappe-studio.bench.contexts`
  setting — a list of bench root directories, with an optional `wsl` marker for benches that
  live inside Windows Subsystem for Linux. Auto-discovery by scanning folders is *not*
  automatic; the user adds contexts deliberately. Site and app lists are then read from the
  local filesystem through the platform file service.
- **Commands run in the native integrated terminal**, with the context's cwd, or via
  `wsl.exe` when the context is marked WSL. On Windows, WSL benches therefore need WSL
  installed and a distribution that can run bench; the terminal you see is exactly what you'd
  type into anyway.
- **Supported commands** include: `bench start`, `bench stop`, `bench migrate`,
  `bench clear-cache`, `bench backup`, `bench new-app`, `bench get-app`, `bench build`,
  `bench list-apps` — plus destructive variants (`drop-site`, `new-site`, backup restore)
  which always ask before running.
- **Windows note**: the bench inside WSL is reached via `wsl.exe`, not natively; commands are
  still visible in the terminal pane so nothing is opaque.

## What works better locally

- **Developer mode verification** (as above) is real, not best-effort, when a bench context
  is configured.
- **Editing server-side report sources**: locally you can also open report `.py`/`.sql` files
  straight from disk in the bench if you want a plain text workflow; Reports Studio's
  `frappe-report:` provider semantics remains the same in either mode.
- **Destructive database work**: the Database Explorer stays read-only everywhere and explains
  why (Frappe does not expose raw SQL over HTTP). Bench-era operations that actually need SQL —
  `bench mariadb`, custom migrations — belong in the integrated terminal, gated by explicit
  user intent.

## Practical tips

- Start the bench *before* pointing Frappe Studio at it; the connection wizard shows a clean
  diagnostic when the site is down ("connection refused" style errors surface with the URL
  that failed).
- For WSL: use the hostname the bench bind address actually serves (`localhost:8000` covers
  `bench start` with default port; `127.0.0.1:8000` when `localhost` resolves oddly).
- After enabling developer mode, some metadata surfaces unlock only after `bench clear-cache`,
  which is why the Studio does both back to back.
