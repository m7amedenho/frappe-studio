/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IWebviewWorkbenchService, IWebViewShowOptions } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { WebviewInitInfo } from '../../webview/browser/webview.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';

/**
 * Base class for Frappe Studio webview-based editors (DocType Studio, Workflow Designer,
 * API Explorer, ...). Webviews are untrusted surfaces; every editor here therefore
 * - serves itself with a strict content security policy (no remote resources, no eval),
 * - keeps session state and Frappe credentials strictly on the host side,
 * - moves state only through typed `postMessage` payloads (see each controller).
 */
export abstract class FrappeWebviewController<Incoming extends { type: string }, Outgoing extends { type: string }> extends Disposable {

	/** Unique per-editor view type registered with the workbench webview service. */
	protected abstract readonly editorViewType: string;

	/** The currently open tab, if the editor is open. */
	protected input: WebviewInput | undefined;

	constructor(
		@IWebviewWorkbenchService protected readonly webviewWorkbenchService: IWebviewWorkbenchService
	) {
		super();
	}

	/**
	 * Opens (or focuses) the editor. When a new webview is created the subclass provides
	 * its initial document through `createDocument`, after which `webviewDidReady` handles
	 * the initial handshake once the document reports readiness.
	 */
	protected openEditor(title: string, createDocument: () => string): void {
		if (this.input) {
			this.webviewWorkbenchService.revealWebview(this.input, ACTIVE_GROUP, false);
			return;
		}
		const initInfo: WebviewInitInfo = {
			title,
			providedViewType: this.editorViewType,
			options: { enableFindWidget: true },
			contentOptions: { localResourceRoots: [], allowScripts: true },
			extension: undefined
		};
		const showOptions: IWebViewShowOptions = { group: ACTIVE_GROUP, preserveFocus: false };
		const input = this.webviewWorkbenchService.openWebview(initInfo, this.editorViewType, title, undefined, showOptions);
		this.input = input;
		this._register(input.onWillDispose(() => {
			if (this.input === input) {
				this.input = undefined;
				this.editorClosed();
			}
		}));
		this._register(input.webview.onMessage(e => {
			const message = e.message as Incoming | undefined;
			if (message && typeof message === 'object' && typeof message.type === 'string') {
				this.handleMessage(message);
			}
		}));
		input.webview.setHtml(createDocument());
	}

	/** Handles one typed incoming message from the webview (including the `ready` handshake). */
	protected abstract handleMessage(message: Incoming): void;

	/** Called when the editor tab closes so subclasses can reset their transient state. */
	protected editorClosed(): void {
		// no default action
	}

	protected post(message: Outgoing): void {
		void this.input?.webview.postMessage(message);
	}
}

/** Hardened CSP shared by every Frappe Studio webview: no remote content, no eval, nonce-gated scripts. */
export function secureCsp(nonce: string): string {
	return `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`;
}

export interface FrappeDocumentOptions {
	readonly nonce: string;
	readonly body: string;
	readonly styles: string;
	readonly scripts: string;
}

export function buildFrappeDocument(options: FrappeDocumentOptions): string {
	return [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="UTF-8">',
		`<meta http-equiv="Content-Security-Policy" content="${secureCsp(options.nonce)}">`,
		'<title>Frappe Studio</title>',
		`<style>${options.styles}</style>`,
		'</head>',
		`<body>${options.body}`,
		`<script nonce="${options.nonce}">${options.scripts}</script>`,
		'</body>',
		'</html>'
	].join('\n');
}

export function newFrappeNonce(): string {
	return generateUuid();
}
