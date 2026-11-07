/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FrappeClient, FrappeDocument, DocumentKind } from './frappe';
import { normalizeSiteUrl } from './url';

type Group = 'Apps' | 'Modules' | 'DocTypes' | 'Workflows' | 'Reports' | 'Print Formats';
const groups: readonly Group[] = ['Apps', 'Modules', 'DocTypes', 'Workflows', 'Reports', 'Print Formats'];
const doctypeFor = (group: Group): string => ({ Apps: 'Installed Applications', Modules: 'Module Def', DocTypes: 'DocType', Workflows: 'Workflow', Reports: 'Report', 'Print Formats': 'Print Format' })[group];
const kindFor = (group: Group): DocumentKind | undefined => ({ DocTypes: 'DocType', Workflows: 'Workflow', Reports: 'Report', 'Print Formats': 'Print Format' } as Partial<Record<Group, DocumentKind>>)[group];

interface Site { origin: string; username: string }
type Entry = { type: 'site'; site: Site } | { type: 'group'; group: Group } | { type: 'document'; group: Group; name: string; detail?: string };

class SiteTree implements vscode.TreeDataProvider<Entry> {
	private readonly emitter = new vscode.EventEmitter<Entry | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	constructor(private readonly active: () => FrappeClient | undefined) { }
	refresh(): void { this.emitter.fire(undefined); }
	getTreeItem(entry: Entry): vscode.TreeItem {
		if (entry.type === 'site') {
			const item = new vscode.TreeItem(entry.site.origin, vscode.TreeItemCollapsibleState.Expanded);
			item.description = entry.site.username;
			item.iconPath = new vscode.ThemeIcon('server');
			return item;
		}
		if (entry.type === 'group') {
			const item = new vscode.TreeItem(entry.group, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('folder');
			return item;
		}
		const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
		item.description = entry.detail;
		item.iconPath = new vscode.ThemeIcon(entry.group === 'DocTypes' ? 'symbol-class' : 'file');
		if (kindFor(entry.group)) { item.command = { command: 'frappeStudio.open', title: 'Open Document', arguments: [entry] }; }
		return item;
	}
	async getChildren(entry?: Entry): Promise<Entry[]> {
		const client = this.active();
		if (!client) { return []; }
		if (!entry) { return [{ type: 'site', site: { origin: client.origin, username: client.username } }]; }
		if (entry.type === 'site') { return groups.map(group => ({ type: 'group', group })); }
		if (entry.type === 'document') { return []; }
		try {
			if (entry.group === 'Apps') {
				try {
					const versions = await client.call<Record<string, { version?: string; branch_version?: string }>>('frappe.get_versions');
					return Object.entries(versions ?? {}).map(([name, info]) => ({ type: 'document', group: entry.group, name, detail: info?.version ?? info?.branch_version }));
				} catch {
					const apps = await client.call<string[]>('frappe.get_installed_apps');
					return apps.map(name => ({ type: 'document', group: entry.group, name }));
				}
			}
			const fields = entry.group === 'DocTypes' ? ['name', 'module', 'custom'] : ['name'];
			const records = await client.list(doctypeFor(entry.group), fields).catch(async error => {
				if (entry.group === 'DocTypes') { return client.list('DocType'); }
				throw error;
			});
			return records.map(record => ({ type: 'document', group: entry.group, name: String(record.name), detail: typeof record.module === 'string' ? record.module : undefined }));
		} catch (error) {
			void vscode.window.showErrorMessage(`Frappe Studio: ${message(error)}`);
			return [];
		}
	}
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

class DocumentEditor {
	private originalModified: string | undefined;
	private originalName: string | undefined;
	constructor(private readonly client: FrappeClient, private readonly kind: DocumentKind, private create: boolean) { }
	async open(name?: string, module?: string): Promise<void> {
		const document = this.create
			? this.blankDocument(name ?? '', module)
			: await this.client.get(this.kind, name ?? '');
		this.originalModified = typeof document.modified === 'string' ? document.modified : undefined;
		this.originalName = typeof document.name === 'string' ? document.name : undefined;
		const text = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(document, null, 2) });
		await vscode.window.showTextDocument(text, { preview: false });
		const commandId = `frappeStudio.save.${Date.now()}.${Math.random()}`;
		const save = vscode.commands.registerCommand(commandId, async () => {
			const current = vscode.window.activeTextEditor?.document;
			if (current !== text) { return; }
			try { await this.save(current); } catch (error) { void vscode.window.showErrorMessage(`Frappe Studio: ${message(error)}`); }
		});
		const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		item.text = '$(cloud-upload) Save to Frappe';
		item.tooltip = `Save ${this.kind} to ${this.client.origin}`;
		item.command = commandId;
		item.show();
		const close = vscode.workspace.onDidCloseTextDocument(closed => {
			if (closed === text) { item.dispose(); save.dispose(); close.dispose(); }
		});
	}
	private async save(text: vscode.TextDocument): Promise<void> {
		let document: FrappeDocument;
		try { document = JSON.parse(text.getText()) as FrappeDocument; }
		catch { throw new Error('Document contains invalid JSON.'); }
		if (document.doctype !== this.kind || typeof document.name !== 'string' || !document.name.trim()) {
			throw new Error('Document type and name are required.');
		}
		if (!this.create && (document.name !== this.originalName || (this.originalModified && document.modified !== this.originalModified))) {
			throw new Error('Document identity or revision changed. Reload before saving.');
		}
		if (!this.create && this.originalName) {
			const latest = await this.client.get(this.kind, this.originalName);
			if (this.originalModified && latest.modified !== this.originalModified) { throw new Error('Server document changed. Reload and merge your changes.'); }
		}
		const answer = await vscode.window.showWarningMessage(`Save ${this.kind} “${document.name}” to ${this.client.origin}?`, { modal: true }, 'Save');
		if (answer !== 'Save') { return; }
		const saved = await this.client.save(document, this.create);
		this.create = false;
		this.originalModified = typeof saved.modified === 'string' ? saved.modified : undefined;
		this.originalName = String(saved.name ?? document.name);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(text.uri, new vscode.Range(text.positionAt(0), text.positionAt(text.getText().length)), JSON.stringify(saved, null, 2));
		await vscode.workspace.applyEdit(edit);
		void vscode.window.showInformationMessage(`${this.kind} saved to Frappe.`);
	}
	private blankDocument(name: string, module?: string): FrappeDocument {
		switch (this.kind) {
			case 'DocType': return { doctype: this.kind, name, module: module ?? '', custom: 1, fields: [], permissions: [] };
			case 'Workflow': return { doctype: this.kind, workflow_name: name, name, document_type: '', is_active: 0, states: [], transitions: [] };
			case 'Report': return { doctype: this.kind, name, ref_doctype: '', report_type: 'Query Report', is_standard: 'No', query: '' };
			case 'Print Format': return { doctype: this.kind, name, doc_type: '', standard: 'No', custom_format: 1, html: '' };
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	let client: FrappeClient | undefined;
	const tree = new SiteTree(() => client);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('frappeStudio.sites', tree));
	const register = (name: string, handler: (...args: unknown[]) => Promise<void> | void): void => {
		context.subscriptions.push(vscode.commands.registerCommand(`frappeStudio.${name}`, async (...args: unknown[]) => {
			try { await handler(...args); }
			catch (error) { void vscode.window.showErrorMessage(`Frappe Studio: ${message(error)}`); }
		}));
	};
	const requireClient = (): FrappeClient => { if (!client) { throw new Error('Connect to a Frappe site first.'); } return client; };
	register('connect', async () => {
		const site = await vscode.window.showInputBox({ title: 'Frappe Site URL', prompt: 'https://erp.example.com or http://localhost:8000', validateInput: value => { try { normalizeSiteUrl(value); return undefined; } catch (error) { return message(error); } } });
		if (!site) { return; }
		const username = await vscode.window.showInputBox({ title: 'Frappe Username', value: 'Administrator' });
		if (!username) { return; }
		const origin = normalizeSiteUrl(site).origin;
		const password = await vscode.window.showInputBox({ title: `Password for ${username} at ${origin}`, password: true });
		if (password === undefined) { return; }
		const candidate = new FrappeClient(origin, username);
		const actual = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Connecting to Frappe...' }, () => candidate.login(password));
		client = candidate;
		await context.globalState.update('frappeStudio.lastSite', { origin, username } satisfies Site);
		tree.refresh();
		void vscode.window.showInformationMessage(`Connected to ${origin} as ${actual}.`);
	});
	register('disconnect', async () => { if (client) { await client.logout(); client = undefined; tree.refresh(); } });
	register('refresh', () => tree.refresh());
	register('open', async raw => {
		const entry = raw as Entry;
		if (!entry || entry.type !== 'document') { return; }
		const kind = kindFor(entry.group);
		if (!kind) { return; }
		await new DocumentEditor(requireClient(), kind, false).open(entry.name);
	});
	register('createDocType', async () => {
		const name = await vscode.window.showInputBox({ title: 'New DocType Name' });
		if (!name) { return; }
		const module = await vscode.window.showInputBox({ title: 'Module', prompt: 'Existing Module Def name' });
		if (!module) { return; }
		await new DocumentEditor(requireClient(), 'DocType', true).open(name, module);
	});
	register('createDocument', async () => {
		const kind = await vscode.window.showQuickPick(['Workflow', 'Report', 'Print Format'], { title: 'Document Type' });
		if (!kind) { return; }
		const name = await vscode.window.showInputBox({ title: `New ${kind} Name` });
		if (!name) { return; }
		await new DocumentEditor(requireClient(), kind as DocumentKind, true).open(name);
	});
	register('openDesk', async () => { await vscode.env.openExternal(vscode.Uri.parse(requireClient().origin)); });
	register('apiRequest', async () => {
		const active = requireClient();
		const method = await vscode.window.showQuickPick(['GET', 'POST', 'PUT', 'DELETE'] as const, { title: 'HTTP Method' });
		if (!method) { return; }
		const path = await vscode.window.showInputBox({ title: 'Frappe API Path', value: '/api/method/frappe.auth.get_logged_user' });
		if (!path) { return; }
		let body: FrappeDocument | undefined;
		if (method !== 'GET') {
			const raw = await vscode.window.showInputBox({ title: 'JSON Body', value: '{}', prompt: 'Enter a JSON object.' });
			if (raw === undefined) { return; }
			body = JSON.parse(raw) as FrappeDocument;
			if (!body || Array.isArray(body) || typeof body !== 'object') { throw new Error('Body must be a JSON object.'); }
			const confirm = await vscode.window.showWarningMessage(`Send ${method} ${path} to ${active.origin}? This may change site data.`, { modal: true }, 'Send');
			if (confirm !== 'Send') { return; }
		}
		const started = Date.now();
		const result = await active.apiRequest(path, method as 'GET' | 'POST' | 'PUT' | 'DELETE', body);
		const text = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(result, null, 2) });
		await vscode.window.showTextDocument(text);
		void vscode.window.setStatusBarMessage(`Frappe Studio: ${method} ${path} completed in ${Date.now() - started} ms`, 8000);
	});
	register('bench', async () => {
		const directory = vscode.workspace.getConfiguration('frappeStudio').get<string>('benchDirectory');
		if (!directory) { throw new Error('Set frappeStudio.benchDirectory first.'); }
		const command = await vscode.window.showQuickPick(['version', 'list-apps', 'migrate', 'clear-cache', 'backup'], { title: 'Bench Command' });
		if (!command) { return; }
		const site = command === 'version' ? undefined : await vscode.window.showInputBox({ title: 'Site Name' });
		if (command !== 'version' && !site) { return; }
		if (site && !/^[\w.-]+$/.test(site)) { throw new Error('Invalid site name.'); }
		if (['migrate', 'clear-cache', 'backup'].includes(command)) {
			const confirm = await vscode.window.showWarningMessage(`Run bench ${command} on ${site}?`, { modal: true }, 'Run');
			if (confirm !== 'Run') { return; }
		}
		const terminal = vscode.window.createTerminal({ name: 'Frappe Bench', cwd: directory });
		terminal.show();
		terminal.sendText(site ? `bench --site ${site} ${command}` : 'bench version');
	});
	const previous = context.globalState.get<Site>('frappeStudio.lastSite');
	if (previous) { void vscode.window.setStatusBarMessage(`Frappe Studio: last site ${previous.origin}. Connect to restore session.`, 7000); }
}

export function deactivate(): void { }
