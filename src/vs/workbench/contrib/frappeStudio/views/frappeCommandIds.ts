/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Every command Frappe Studio contributes. Centralized so views, menus and keybindings
 * reference stable identifiers.
 */

export const enum FrappeStudioCommandId {
	Connect = 'frappeStudio.connect',
	ManageConnections = 'frappeStudio.manageConnections',
	DisconnectActive = 'frappeStudio.disconnectActive',
	OpenOverview = 'frappeStudio.openOverview',
	OpenDoctypeEditor = 'frappeStudio.openDocTypeEditor',
	NewDoctype = 'frappeStudio.newDocType',
	OpenWorkflowEditor = 'frappeStudio.openWorkflowEditor',
	NewWorkflow = 'frappeStudio.newWorkflow',
	OpenApiExplorer = 'frappeStudio.openApiExplorer',
	OpenDatabaseExplorer = 'frappeStudio.openDatabaseExplorer',
	OpenPrintFormat = 'frappeStudio.openPrintFormat',
	OpenReportRunner = 'frappeStudio.openReportRunner',
	OpenCustomizeForm = 'frappeStudio.openCustomizeForm',
	RunBenchCommand = 'frappeStudio.runBenchCommand',
	ReloadDocTypesView = 'frappeStudio.reloadDocTypesView',
	FocusApps = 'frappeStudio.focusApps',
	FocusDocTypes = 'frappeStudio.focusDocTypes',
	ShowAbout = 'frappeStudio.about',
	RefreshConnections = 'frappeStudio.refreshConnections',
	OpenDocumentation = 'frappeStudio.openDocumentation',
	OpenDesk = 'frappeStudio.openDesk'
}
