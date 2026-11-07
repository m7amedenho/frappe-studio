# Frappe Studio extension

Frappe Studio adds a Frappe site explorer to Visual Studio Code. This package is an early development build and has not been verified against a live Frappe site.

## Install and try

From this folder, run `pnpm install`, `pnpm run compile`, and `pnpm run package`. In VS Code, open **Extensions: Install from VSIX...** and choose `frappe-studio-0.1.0.vsix`. Alternatively, run `code --install-extension frappe-studio-0.1.0.vsix`.

Open the Frappe Studio icon in the activity bar, run **Frappe Studio: Connect to Site**, and enter a Frappe URL, username, and password. The password and session cookies stay in memory only. Reconnect after restarting VS Code. The last site URL and username are stored so the connection can be identified; the password is not stored.

## Available commands

- **Connect to Site** and **Disconnect** manage an authenticated session.
- The explorer reads installed apps, modules, DocTypes, workflows, reports, and print formats from the site.
- Open a document to edit its real JSON metadata. Use **Save to Frappe** in the status bar to validate the revision and submit the change. Saving asks for confirmation.
- **Create DocType** opens a new JSON document. **Create Workflow, Report, or Print Format** opens a starter JSON document; complete the required Frappe properties before saving.
- **API Request** sends GET, POST, PUT, or DELETE to a path under the connected site's Frappe API. Write requests require confirmation and a JSON object body.
- **Open Desk** opens the connected site in your browser.
- **Run Bench Command** uses a local integrated terminal. Set `frappeStudio.benchDirectory` first.

Use a disposable development site for testing writes. Server permissions and Developer Mode determine which operations work. No browser UI, visual DocType builder, database query editor, report runner, customization designer, workflow canvas, or automatic site restore is included yet.

## Development

Run `pnpm run compile` and `pnpm run test`. Press F5 in a VS Code window opened on this folder with an Extension Host launch configuration, or run `code --extensionDevelopmentPath <absolute-path-to-this-folder>` after compiling.
