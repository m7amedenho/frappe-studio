/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { FrappeApp } from '../common/frappeTypes.js';
import { DeveloperModeStatus } from '../common/frappeTypes.js';
import { FrappeConnectionState } from '../common/frappeTypes.js';
import { listDocTypes, listModules } from '../connection/doctypeService.js';
import { ISiteConnectionService, IActiveConnectionSession } from '../connection/connectionService.js';
import { FrappeStudioCommandId } from './frappeCommandIds.js';

/**
 * Sidebar panes for the Frappe Studio view container. They show live site data resolved
 * through the connection service; with no connection they show the welcome actions.
 * DOM stays lean and native: a filter box, a status line and a list; every row runs a
 * registered workbench command, so all interactions are available from the Command Palette too.
 */

const rowClickStyle = 'display:flex;gap:6px;align-items:center;padding:2px 4px;border-radius:3px;cursor:pointer;';

interface IRow {
	id: string;
	label: string;
	detail: string;
	icon: string;
	args: unknown[];
	commandId: string;
}

export abstract class AbstractFrappePane extends ViewPane {

	protected listElement!: HTMLUListElement;
	protected statusElement!: HTMLSpanElement;
	protected searchElement!: HTMLInputElement;
	private rows: readonly IRow[] = [];
	private filter = '';

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService protected override readonly instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		const wrapper = document.createElement('div');
		wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%';
		this.searchElement = document.createElement('input');
		this.searchElement.type = 'text';
		this.searchElement.placeholder = localize('frappeStudio.filterPlaceholder', 'Filter...');
		this.searchElement.style.cssText = 'margin:6px 10px 2px;padding:3px 6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);width:calc(100% - 20px)';
		this.searchElement.addEventListener('input', () => this.applyFilter());
		const statusRow = document.createElement('div');
		statusRow.style.cssText = 'display:flex;align-items:center;padding:2px 10px;color:var(--vscode-descriptionForeground);font-size:12px';
		this.statusElement = document.createElement('span');
		const refresh = document.createElement('button');
		refresh.append(localize('frappeStudio.refresh', 'Refresh'));
		refresh.style.cssText = 'margin-left:auto;cursor:pointer;background:transparent;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);border-radius:3px';
		refresh.addEventListener('click', () => this.refresh());
		statusRow.append(this.statusElement, refresh);
		this.listElement = document.createElement('ul');
		this.listElement.style.cssText = 'list-style:none;margin:4px 6px;padding:0;overflow:auto;flex:1';
		wrapper.append(this.searchElement, statusRow, this.listElement);
		parent.appendChild(wrapper);
		this.renderStatus(localize('frappeStudio.loading', 'Loading\u2026'));
		void this.refresh();
	}

	protected renderStatus(message: string): void {
		this.statusElement.textContent = message;
		this.rows = [];
		this.applyFilter();
	}

	protected setRows(rows: readonly IRow[], status: string): void {
		this.rows = rows;
		this.statusElement.textContent = status;
		this.applyFilter();
	}

	private applyFilter(): void {
		const list = this.listElement;
		list.innerHTML = '';
		const needle = this.filter.toLowerCase();
		const filtered = this.rows.filter(row => !needle || `${row.label} ${row.detail}`.toLowerCase().includes(needle));
		for (const row of filtered) {
			const item = document.createElement('li');
			item.style.cssText = rowClickStyle;
			item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-list-hoverBackground)'; });
			item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
			const icon = document.createElement('span');
			icon.className = `codicon codicon-${row.icon}`;
			const label = document.createElement('span');
			label.style.flex = '1';
			label.textContent = row.label;
			const detail = document.createElement('span');
			detail.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground)';
			detail.textContent = row.detail;
			item.append(icon, label, detail);
			item.addEventListener('click', () => {
				void this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand(row.commandId, ...row.args));
			});
			list.appendChild(item);
		}
		if (!filtered.length && this.rows.length) {
			const empty = document.createElement('li');
			empty.style.cssText = 'padding:6px;color:var(--vscode-descriptionForeground)';
			empty.textContent = localize('frappeStudio.noMatches', 'No entries match the filter.');
			list.appendChild(empty);
		}
	}

	/** Reloads live data; implementations are safe to call any time. */
	abstract refresh(): void;
}

export class FrappeOverviewPane extends AbstractFrappePane {

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISiteConnectionService private readonly connectionService: ISiteConnectionService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.connectionService.onDidChangeSessionState(() => this.refresh()));
		this._register(this.connectionService.onDidChangeActiveConnection(() => this.refresh()));
	}

	override refresh(): void {
		const sessions = this.connectionService.getSessions();
		if (!sessions.length) {
			this.setRows([
				{ id: 'connect', label: localize('frappeStudio.connect', 'Connect to a Frappe Site'), detail: '', icon: 'plug', args: [], commandId: FrappeStudioCommandId.Connect },
				{ id: 'manual', label: localize('frappeStudio.documentation', 'Documentation'), detail: '', icon: 'book', args: [], commandId: FrappeStudioCommandId.OpenDocumentation },
				{ id: 'settings', label: localize('frappeStudio.settings', 'Settings'), detail: '', icon: 'settings-gear', args: ['frappe-studio'], commandId: '_workbench.action.openSettings' }
			], localize('frappeStudio.noConnection', 'Not connected'));
			return;
		}
		const session = this.getActive(sessions);
		this.setRows(summaryRows(session), describeSessionStatus(session));
	}

	private getActive(sessions: readonly IActiveConnectionSession[]): IActiveConnectionSession {
		return sessions.find(s => s.connection.id === this.connectionService.activeSessionId) ?? sessions[0];
	}
}

function describeSessionStatus(session: SessionsAtType | undefined): string {
	if (!session) {
		return localize('frappeStudio.noConnection', 'Not connected');
	}
	const stateLabel = session.state === FrappeConnectionState.Connected
		? localize('frappeStudio.connected', 'Connected')
		: session.state === FrappeConnectionState.Failed
			? localize('frappeStudio.failed', 'Failed')
			: session.state;
	const devMode = session.identity ? developerModeLabel(session.identity.developerMode) : '';
	return `${session.connection.label} \u2014 ${stateLabel} ${devMode ? `\u00b7 ${devMode}` : ''}`;
}

type SessionsAtType = ReturnType<ISiteConnectionService['getSessions']>[number] | undefined;

function developerModeLabel(status: DeveloperModeStatus): string {
	switch (status) {
		case 'enabled': return localize('frappeStudio.devModeEnabled', 'Developer Mode: Enabled');
		case 'disabled': return localize('frappeStudio.devModeDisabled', 'Developer Mode: Disabled');
		default: return localize('frappeStudio.devModeUnknown', 'Developer Mode: Unknown');
	}
}

function summaryRows(session: SessionsAtType): readonly IRow[] {
	if (!session?.identity) {
		return [];
	}
	const identity = session.identity;
	const rows: IRow[] = [
		{ id: 'openDesk', label: localize('frappeStudio.openDesk', 'Open Desk in Browser'), detail: '', icon: 'link-external', args: [], commandId: FrappeStudioCommandId.OpenDesk },
		{ id: 'apps', label: localize('frappeStudio.showApps', 'Apps ({0})', identity.installedApps.length), detail: '', icon: 'package', args: [], commandId: FrappeStudioCommandId.FocusApps },
		{ id: 'about', label: `Frappe: ${identity.frappeVersion ?? localize('frappeStudio.unknown', 'Unknown')}`, detail: '', icon: 'info', args: [], commandId: FrappeStudioCommandId.ShowAbout }
	];
	return rows;
}

export class FrappeAppsPane extends AbstractFrappePane {

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISiteConnectionService private readonly connectionService: ISiteConnectionService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.connectionService.onDidChangeSessionState(() => this.refresh()));
	}

	override refresh(): void {
		const session = this.connectionService.getSessions().find(s => s.connection.id === this.connectionService.activeSessionId) ?? this.connectionService.getSessions()[0];
		if (!session?.identity) {
			this.renderStatus(localize('frappeStudio.connectFirst', 'Connect to a site to see its apps.'));
			return;
		}
		const identity = session?.identity;
		const modulesPromise = loadModules(this.connectionService, session.connection.id);
		void modulesPromise.then(sem => {
			this.setRows([...identity.installedApps.map(app => appRow(session.connection.id, app)), ...sem], identity.siteName);
		});
	}
}

function appRow(connectionId: string, app: FrappeApp): IRow {
	return {
		id: app.name,
		label: app.name,
		detail: app.version ?? localize('frappeStudio.unknownVersion', 'unknown'),
		icon: 'package',
		args: [connectionId, app.name],
		commandId: FrappeStudioCommandId.FocusDocTypes
	};
}

async function loadModules(connectionService: ISiteConnectionService, connectionId: string): Promise<readonly IRow[]> {
	const session = connectionService.getSession(connectionId);
	if (!session) {
		return [];
	}
	try {
		const modules = await listModules(session.client, CancellationToken.None);
		return modules.map(m => ({
			id: m.name,
			label: m.name,
			detail: m.app ?? '',
			icon: 'symbol-namespace',
			args: [],
			commandId: FrappeStudioCommandId.FocusDocTypes
		}));
	} catch {
		return [];
	}
}

export class FrappeDocTypesPane extends AbstractFrappePane {

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISiteConnectionService private readonly connectionService: ISiteConnectionService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	override refresh(): void {
		const session = this.connectionService.getSessions().find(s => s.connection.id === this.connectionService.activeSessionId) ?? this.connectionService.getSessions()[0];
		if (!session) {
			this.renderStatus(localize('frappeStudio.connectFirst', 'Connect to a site to browse its DocTypes.'));
			return;
		}
		this.setRows([], localize('frappeStudio.loadingDocTypes', 'Loading DocTypes\u2026'));
		void listDocTypes(session.client, CancellationToken.None).then(docs => {
			this.setRows(docs.filter(doc => doc.name).map(doc => ({
				id: doc.name,
				label: doc.name,
				detail: doc.standard ? localize('frappeStudio.standard', 'standard') : localize('frappeStudio.custom', 'custom'),
				icon: doc.standard ? 'file-types' : 'file-submodule',
				args: [session.connection.id, doc.name],
				commandId: FrappeStudioCommandId.OpenDoctypeEditor
			})), String(docs.length));
		}, () => {
			this.renderStatus(localize('frappeStudio.loadFailed', 'Could not load DocTypes from the site.'));
		});
	}
}
