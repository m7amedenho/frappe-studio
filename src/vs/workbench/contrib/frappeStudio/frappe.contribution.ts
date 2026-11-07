/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize, localize2 } from '../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { ILocalizedString } from '../../../platform/action/common/action.js';
import { IQuickInputService, IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IRequestService } from '../../../platform/request/common/request.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { isWindows } from '../../../base/common/platform.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../common/views.js';
import { IViewsService } from '../../services/views/common/viewsService.js';
import { ViewPaneContainer } from '../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import { ITerminalService } from '../terminal/browser/terminal.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { FrappeConnectionState } from './common/frappeTypes.js';
import { normalizeSiteUrl } from './common/frappeUrl.js';
import { FrappeClient, FrappeAuthenticationError, FrappeSessionExpiredError, SiteUnreachableError } from './connection/frappeClient.js';
import { ISiteConnectionService } from './connection/connectionService.js';
import { FrappeStudioCommandId } from './views/frappeCommandIds.js';
import { FrappeAppsPane, FrappeDocTypesPane, FrappeOverviewPane } from './views/frappeStudioViewPanes.js';
import { DoctypeEditorController, DoctypeEditorOpenInfo, describeError } from './editors/doctypeEditorController.js';

const VIEW_CONTAINER_ID = 'workbench.view.frappeStudio';
const OVERVIEW_VIEW_ID = 'frappeStudio.overview';
const APPS_VIEW_ID = 'frappeStudio.apps';
const DOCTYPES_VIEW_ID = 'frappeStudio.doctypes';

const category = localize2('frappeStudio.category', 'Frappe Studio');

// ---- Workbench integration: activity-bar container + sidebar views --------------------------

const frappeViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEW_CONTAINER_ID,
	title: localize2('frappeStudio.viewContainer', 'Frappe Studio'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
	hideIfEmpty: false,
	icon: Codicon.cloud,
	order: 9
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: OVERVIEW_VIEW_ID,
		containerIcon: Codicon.cloud,
		name: localize2('frappeStudio.overviewView', 'Overview'),
		ctorDescriptor: new SyncDescriptor(FrappeOverviewPane),
		openCommandActionDescriptor: {
			id: FrappeStudioCommandId.OpenOverview,
			order: 1
		},
		order: 1
	},
	{
		id: APPS_VIEW_ID,
		containerIcon: Codicon.package,
		name: localize2('frappeStudio.appsView', 'Apps'),
		ctorDescriptor: new SyncDescriptor(FrappeAppsPane),
		openCommandActionDescriptor: {
			id: FrappeStudioCommandId.FocusApps,
			order: 2
		},
		order: 2
	},
	{
		id: DOCTYPES_VIEW_ID,
		containerIcon: Codicon.layout,
		name: localize2('frappeStudio.doctypesView', 'DocTypes'),
		ctorDescriptor: new SyncDescriptor(FrappeDocTypesPane),
		openCommandActionDescriptor: {
			id: FrappeStudioCommandId.FocusDocTypes,
			order: 3
		},
		order: 3
	}
] as IViewDescriptor[], frappeViewContainer);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
	OVERVIEW_VIEW_ID,
	{
		content: localize(
			'frappeStudio.welcomeContent',
			"Frappe Studio\n\nYour Frappe Development Environment.\n\n[Connect to a Frappe Site](command:{0})\n[Manage Connections](command:{1})\n[Documentation](command:{2})",
			FrappeStudioCommandId.Connect,
			FrappeStudioCommandId.ManageConnections,
			FrappeStudioCommandId.OpenDocumentation
		)
	}
);

// ---- Settings --------------------------------------------------------------------------------

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'frappe-studio',
	order: 120,
	title: localize('frappeStudio.settingsTitle', 'Frappe Studio'),
	type: 'object',
	properties: {
		'frappe-studio.connection.timeoutSeconds': {
			type: 'number',
			default: 30,
			minimum: 3,
			maximum: 300,
			description: localize('frappeStudio.timeoutSetting', 'Number of seconds to wait before considering a Frappe request failed.')
		},
		'frappe-studio.bench.contexts': {
			markdownDescription: localize('frappeStudio.benchContexts', 'Local Bench root directories known to this IDE. Bench commands run in the integrated terminal with those working directories.'),
			type: 'array',
			items: { type: 'string' },
			default: []
		},
		'frappe-studio.bench.useWslOnWindows': {
			type: 'boolean',
			default: false,
			description: localize('frappeStudio.benchWsl', 'Run Bench commands through WSL when the bench lives inside WSL (Windows only).')
		},
		'frappe-studio.database.readOnly': {
			type: 'boolean',
			default: true,
			description: localize('frappeStudio.dbReadOnly', 'Keep the Database Explorer strictly read-only. Write and destructive operations always require explicit confirmation and are disabled by default.')
		}
	}
});

// ---- Status bar item --------------------------------------------------------------------------

const statusEntryName = localize('frappeStudio.statusEntry', 'Frappe Studio Connection');

class FrappeStudioStatusBarItem extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'frappeStudio.statusBar';

	private readonly accessor = this.statusbarService.addEntry({
		name: statusEntryName,
		text: localize('frappeStudio.statusDisconnected', 'Frappe: not connected'),
		ariaLabel: localize('frappeStudio.statusDisconnected', 'Frappe: not connected'),
		tooltip: localize('frappeStudio.statusTooltip', 'Active Frappe site'),
		command: { id: FrappeStudioCommandId.ManageConnections, title: localize('frappeStudio.statusManage', 'Manage Connections') }
	}, 'status.frappeStudio.connection', StatusbarAlignment.RIGHT, 1000);

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ISiteConnectionService connectionService: ISiteConnectionService
	) {
		super();
		this._register(connectionService.onDidChangeActiveConnection(() => this.paint(connectionService)));
		this._register(connectionService.onDidChangeSessionState(() => this.paint(connectionService)));
		this.paint(connectionService);
	}

	private paint(connectionService: ISiteConnectionService): void {
		const session = connectionService.getSessions().find(s => s.connection.id === connectionService.activeSessionId) ?? connectionService.getSessions()[0];
		const text = session && session.state === FrappeConnectionState.Connected
			? `Frappe: ${session.connection.label}`
			: localize('frappeStudio.statusDisconnected', 'Frappe: not connected');
		this.accessor.update({
			name: statusEntryName,
			text,
			ariaLabel: text,
			tooltip: localize('frappeStudio.statusTooltip', 'Active Frappe site'),
			command: { id: FrappeStudioCommandId.ManageConnections, title: localize('frappeStudio.statusManage', 'Manage Connections') }
		});
	}
}

registerWorkbenchContribution2(FrappeStudioStatusBarItem.ID, FrappeStudioStatusBarItem, WorkbenchPhase.BlockRestore);

// ---- Connection wizard --------------------------------------------------------------------------

class ConnectCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.Connect,
			title: localize2('frappeStudio.connectCommand', 'Connect to a Frappe Site'),
			category,
			f1: true,
			keybinding: {
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyF),
				weight: 200
			}
		});
	}

	private ask(input: ReturnType<IQuickInputService['createInputBox']>, prompt: string, options: { readonly password?: boolean; readonly value?: string; readonly validate?: (value: string) => Promise<string | undefined> }): Promise<string | undefined> {
		return new Promise(resolve => {
			let closed = false;
			input.title = localize('frappeStudio.wizard', 'Connect to a Frappe Site');
			input.password = options.password === true;
			input.ignoreFocusOut = true;
			input.prompt = prompt;
			input.value = options.value ?? '';
			if (options.validate) {
				input.onDidChangeValue(async value => {
					input.validationMessage = await options.validate!(value);
				});
			}
			const accepted = async () => {
				closed = true;
				const value = input.value;
				resolve(value);
			};
			input.onDidAccept(() => {
				accepted();
				input.hide();
			});
			input.onDidHide(() => {
				if (!closed) {
					resolve(undefined);
				}
			});
			input.show();
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const connectionService = accessor.get(ISiteConnectionService);
		const notifications = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);
		const requestService = accessor.get(IRequestService);

		const preparation = quickInput.createInputBox();
		const siteUrl = await this.ask(preparation, localize('frappeStudio.enterUrl', 'Site URL, for example https://erp.example.com or http://localhost:8000'), {
			validate: async value => {
				try {
					normalizeSiteUrl(value);
					return undefined;
				} catch (error) {
					return describeError(error);
				}
			}
		});
		if (!siteUrl) {
			preparation.dispose();
			return;
		}
		let normalized;
		try {
			normalized = normalizeSiteUrl(siteUrl);
		} catch (error) {
			notifications.error(describeError(error));
			preparation.dispose();
			return;
		}

		// Reachability: an unauthenticated identity probe that must fail with an auth error
		// rather than a network error. This keeps TLS validation active end to end.
		const probe = new FrappeClient(normalized, requestService, logService);
		try {
			await probe.getLoggedUser(CancellationToken.None);
		} catch (error) {
			if (error instanceof SiteUnreachableError) {
				notifications.error(localize('frappeStudio.unreachable', 'Could not reach the site: {0}', error.message));
				preparation.dispose();
				return;
			}
		}
		preparation.dispose();

		const usernameBox = quickInput.createInputBox();
		const username = await this.ask(usernameBox, localize('frappeStudio.enterUser', 'Username'), { value: 'Administrator' });
		usernameBox.dispose();
		if (username === undefined) {
			return;
		}
		const passwordBox = quickInput.createInputBox();
		const password = await this.ask(passwordBox, localize('frappeStudio.enterPassword', 'Password (kept only in the operating-system keychain)'), { password: true });
		passwordBox.dispose();
		if (password === undefined) {
			return;
		}

		try {
			const session = await connectionService.connect(siteUrl, username, password, { rememberPassword: true });
			notifications.info(localize('frappeStudio.connected', 'Connected to {0} as {1}', session.connection.origin, username));
			await accessor.get(IViewsService).openView(OVERVIEW_VIEW_ID, true);
		} catch (error) {
			notifications.error(error instanceof FrappeAuthenticationError
				? localize('frappeStudio.authRejected', 'The site rejected these credentials: {0}', error.message)
				: error instanceof SiteUnreachableError
					? localize('frappeStudio.unreachable', 'Could not reach the site: {0}', error.message)
					: error instanceof FrappeSessionExpiredError
						? localize('frappeStudio.sessionExpired', 'The site rejected the session; verify the URL and try again.')
						: describeError(error));
		}
	}
}

registerAction2(ConnectCommand);

class ManageConnectionsCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.ManageConnections,
			title: localize2('frappeStudio.manageConnections', 'Manage Connections'),
			category,
			f1: true,
			keybinding: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyS), weight: 200 }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const connectionService = accessor.get(ISiteConnectionService);
		const sessions = connectionService.getSessions();
		const storedLabel = localize('frappeStudio.storedConnection', 'stored connection, no live session');
		interface ConnectionPick extends IQuickPickItem { run(): Promise<void> }
		const picks: ConnectionPick[] = [];
		for (const session of sessions) {
			picks.push({
				label: session.connection.label,
				description: session.state,
				detail: session.connection.username,
				run: async () => connectionService.setActiveSession(session.connection.id)
			});
		}
		for (const connection of connectionService.getConnections()) {
			if (!sessions.some(s => s.connection.id === connection.id)) {
				picks.push({
					label: connection.label,
					description: storedLabel,
					detail: connection.username,
					run: async () => { await connectionService.reconnect(connection.id); }
				});
			}
		}
		picks.push({
			label: localize('frappeStudio.addConnection', 'Add a connection...'),
			run: async () => accessor.get(ICommandService).executeCommand(FrappeStudioCommandId.Connect)
		});
		picks.push({
			label: localize('frappeStudio.forgetConnection', 'Forget the active connection...'),
			run: async () => {
				const activeId = connectionService.activeSessionId;
				if (activeId) {
					await connectionService.forget(activeId);
				}
			}
		});
		picks.push({
			label: localize('frappeStudio.disconnectActive', 'Disconnect the active session...'),
			run: async () => {
				const activeId = connectionService.activeSessionId;
				if (activeId) {
					await connectionService.disconnect(activeId, true);
				}
			}
		});
		const picker = quickInput.createQuickPick<ConnectionPick>();
		picker.title = localize('frappeStudio.connections', 'Frappe Studio Connections');
		picker.matchOnDetail = true;
		picker.ignoreFocusOut = true;
		picker.placeholder = localize('frappeStudio.connectionsPrompt', 'Choose an action');
		picker.items = picks;
		picker.onDidAccept(() => {
			const selection = picker.activeItems[0];
			if (selection) {
				void selection.run();
			}
			picker.hide();
		});
		picker.show();
	}
}

registerAction2(ManageConnectionsCommand);

class DisconnectActiveCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.DisconnectActive,
			title: localize2('frappeStudio.disconnect', 'Disconnect from the Active Site'),
			category,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const connectionService = accessor.get(ISiteConnectionService);
		const active = connectionService.activeSessionId;
		if (active) {
			await connectionService.disconnect(active, true);
		}
	}
}

registerAction2(DisconnectActiveCommand);

// ---- Focus commands ------------------------------------------------------------------------------

abstract class FocusViewCommand extends Action2 {
	constructor(
		id: string,
		title: ILocalizedString,
		private readonly viewId: string
	) {
		super({ id, title, category, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(this.viewId, true);
	}
}

registerAction2(class extends FocusViewCommand {
	constructor() {
		super(FrappeStudioCommandId.OpenOverview, localize2('frappeStudio.openOverview', 'Show Overview'), OVERVIEW_VIEW_ID);
	}
});
registerAction2(class extends FocusViewCommand {
	constructor() {
		super(FrappeStudioCommandId.FocusApps, localize2('frappeStudio.focusApps', 'Show Apps'), APPS_VIEW_ID);
	}
});
registerAction2(class extends FocusViewCommand {
	constructor() {
		super(FrappeStudioCommandId.FocusDocTypes, localize2('frappeStudio.focusDocTypes', 'Show DocTypes'), DOCTYPES_VIEW_ID);
	}
});

// ---- DocType Studio -------------------------------------------------------------------------------

interface DoctypeArgs {
	readonly connectionId: string;
	readonly doctypeName?: string;
}

function isDoctypeArgs(value: unknown): value is DoctypeArgs {
	return typeof value === 'object' && value !== null && typeof (value as DoctypeArgs).connectionId === 'string';
}

class OpenDoctypeEditorCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.OpenDoctypeEditor,
			title: localize2('frappeStudio.openDocTypeEditor', 'Open DocType Studio'),
			category,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const connectionService = accessor.get(ISiteConnectionService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		let connectionId: string;
		let doctypeName: string;
		const maybe = args[0];
		if (isDoctypeArgs(maybe)) {
			connectionId = maybe.connectionId;
			doctypeName = maybe.doctypeName ?? '';
		} else {
			// Command Palette path: pick compaction connection and DocType interactively
			const session = connectionService.getSessions().find(s => s.connection.id === connectionService.activeSessionId) ?? connectionService.getSessions()[0];
			if (!session) {
				notifications.info(localize('frappeStudio.connectFirst', 'Connect to a site first.'));
				return;
			}
			connectionId = session.connection.id;
			const name = await quickInput.input({
				title: localize('frappeStudio.pickDoctype', 'DocType name'),
				prompt: localize('frappeStudio.pickDoctypePrompt', 'Name of the DocType to open')
			});
			if (!name) {
				return;
			}
			doctypeName = name;
		}
		const controller = instantiationService.createInstance(DoctypeEditorController);
		const openInfo: DoctypeEditorOpenInfo = {
			connectionId,
			siteOrigin: connectionService.getSession(connectionId)?.connection.origin ?? '',
			doctypeName: doctypeName || undefined
		};
		await controller.show(openInfo);
	}
}

registerAction2(OpenDoctypeEditorCommand);

class NewDoctypeCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.NewDoctype,
			title: localize2('frappeStudio.newDocType', 'Create DocType in DocType Studio'),
			category,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const connectionService = accessor.get(ISiteConnectionService);
		const notifications = accessor.get(INotificationService);
		const session = connectionService.getSessions().find(s => s.connection.id === connectionService.activeSessionId) ?? connectionService.getSessions()[0];
		if (!session) {
			notifications.info(localize('frappeStudio.connectFirst', 'Connect to a site first.'));
			return;
		}
		const controller = instantiationService.createInstance(DoctypeEditorController);
		await controller.show({ connectionId: session.connection.id, siteOrigin: session.connection.origin });
	}
}

registerAction2(NewDoctypeCommand);

// ---- Bench manager ---------------------------------------------------------------------------------

class RunBenchCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.RunBenchCommand,
			title: localize2('frappeStudio.runBenchCommand', 'Run a Bench Command'),
			category,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const quickInput = accessor.get(IQuickInputService);
		const terminalService = accessor.get(ITerminalService);
		const notifications = accessor.get(INotificationService);
		const contexts = configurationService.getValue<string[]>('frappe-studio.bench.contexts') ?? [];
		if (!Array.isArray(contexts) || !contexts.length) {
			notifications.info(localize('frappeStudio.noBenchContexts', 'Add bench directories to the frappe-studio.bench.contexts setting first.'));
			return;
		}
		const commandHost = quickInput.createQuickPick<{ readonly label: string; readonly path: string }>();
		commandHost.title = localize('frappeStudio.pickBench', 'Bench environment');
		commandHost.ignoreFocusOut = true;
		commandHost.items = contexts.map(path => ({ label: path, path }));
		const selection = await new Promise<{ readonly label: string; readonly path: string } | undefined>(resolve => {
			commandHost.onDidAccept(() => { resolve(commandHost.activeItems[0]); commandHost.hide(); });
			commandHost.onDidHide(() => resolve(undefined));
			commandHost.show();
		});
		if (!selection) {
			return;
		}
		const commands = [
			['start', 'bench start'],
			['stop', 'pkill -f "bench serve"'],
			['clear-cache', 'bench clear-cache'],
			['clear-website-cache', 'bench clear-website-cache'],
			['backup', 'bench backup --with-files'],
			['migrate', 'bench migrate'],
			['list-apps', 'bench list-apps'],
			['build', 'bench build'],
			['get-app', 'bench get-app'],
			['new-app', 'bench new-app'],
			['new-site', 'bench new-site'],
			['drop-site', 'bench drop-site']
		];
		const commandPicker = quickInput.createQuickPick<{ readonly label: string; readonly commandText: string }>();
		commandPicker.title = localize('frappeStudio.pickBenchCommand', 'Bench command');
		commandPicker.ignoreFocusOut = true;
		commandPicker.items = commands.map(([label, commandText]) => ({ label, commandText }));
		const commandPick = await new Promise<{ readonly label: string; readonly commandText: string } | undefined>(resolve => {
			commandPicker.onDidAccept(() => { resolve(commandPicker.activeItems[0]); commandPicker.hide(); });
			commandPicker.onDidHide(() => resolve(undefined));
			commandPicker.show();
		});
		if (!commandPick) {
			return;
		}
		if (['migrate', 'drop-site', 'new-site', 'backup'].includes(commandPick.label)) {
			const confirmationPicker = quickInput.createQuickPick<{ readonly label: string; readonly run: boolean }>();
			confirmationPicker.title = localize('frappeStudio.destructiveTitle', 'This bench command changes data. Run "{0}"?', commandPick.commandText);
			confirmationPicker.ignoreFocusOut = true;
			confirmationPicker.items = [
				{ label: localize('frappeStudio.destructiveConfirm', 'Yes, run it'), run: true },
				{ label: localize('frappeStudio.destructiveCancel', 'No, cancel'), run: false }
			];
			const confirmed = await new Promise<{ readonly run: boolean } | undefined>(resolve => {
				confirmationPicker.onDidAccept(() => { resolve(confirmationPicker.activeItems[0]); confirmationPicker.hide(); });
				confirmationPicker.onDidHide(() => resolve(undefined));
				confirmationPicker.show();
			});
			if (!confirmed || !confirmed.run) {
				return;
			}
		}
		const useWsl = configurationService.getValue<boolean>('frappe-studio.bench.useWslOnWindows') === true && isWindows;
		const finalCommand = useWsl
			? `wsl.exe --cd "${selection.path}" -- ${commandPick.commandText}`
			: commandPick.commandText;
		const terminal = await terminalService.createAndFocusTerminal({ config: { name: `Bench (${selection.label})`, cwd: URI.file(selection.path) } });
		await terminal.sendText(finalCommand, true);
	}
}

registerAction2(RunBenchCommand);

// ---- Informational commands --------------------------------------------------------------------------.

class ShowAboutCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.ShowAbout,
			title: localize2('frappeStudio.about', 'About Frappe Studio'),
			category,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const productService = accessor.get(IProductService);
		const connectionService = accessor.get(ISiteConnectionService);
		const notifications = accessor.get(INotificationService);
		const session = connectionService.getSessions().find(s => s.connection.id === connectionService.activeSessionId) ?? connectionService.getSessions()[0];
		const versionText = productService.version ? String(productService.version) : localize('frappeStudio.unknown', 'unknown');
		const lines = [
			localize('frappeStudio.aboutLineVersion', '{0} (Frappe Studio) {1}', productService.nameLong, versionText),
			session
				? localize('frappeStudio.aboutLineSite', 'Connected site: {0} ({1})', session.connection.origin, session.connection.username)
				: localize('frappeStudio.aboutLineNoSite', 'No active connection'),
			session?.identity?.frappeVersion
				? localize('frappeStudio.aboutLineFrappe', 'Frappe version: {0}', session.identity.frappeVersion)
				: localize('frappeStudio.aboutLineFrappeUnknown', 'Frappe version: unknown'),
			session?.identity
				? localize('frappeStudio.aboutLineDevMode', 'Developer mode: {0}', session.identity.developerMode)
				: localize('frappeStudio.aboutLineDevModeUnknown', 'Developer mode: unknown')
		];
		const title = localize('frappeStudio.aboutTitle', 'About Frappe Studio');
		notifications.info(`${title}\n\n${lines.join('\n')}`);
	}
}

registerAction2(ShowAboutCommand);

class OpenDocumentationCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.OpenDocumentation,
			title: localize2('frappeStudio.openDocumentation', 'Documentation'),
			category,
			f1: true,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', OVERVIEW_VIEW_ID), group: 'navigation' }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const opener = accessor.get(IOpenerService);
		void opener.open(URI.parse('https://github.com/m7amedenho/frappe-studio#readme'));
	}
}

registerAction2(OpenDocumentationCommand);

class OpenDeskCommand extends Action2 {
	constructor() {
		super({
			id: FrappeStudioCommandId.OpenDesk,
			title: localize2('frappeStudio.openDesk', 'Open Desk in Browser'),
			category,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const connectionService = accessor.get(ISiteConnectionService);
		const opener = accessor.get(IOpenerService);
		const session = connectionService.getSessions().find(s => s.connection.id === connectionService.activeSessionId) ?? connectionService.getSessions()[0];
		if (!session) {
			return;
		}
		void opener.open(URI.parse(session.connection.origin));
	}
}

registerAction2(OpenDeskCommand);

export { VIEW_CONTAINER_ID, OVERVIEW_VIEW_ID, APPS_VIEW_ID, DOCTYPES_VIEW_ID };
