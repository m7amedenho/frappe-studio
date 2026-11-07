/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { Json, JsonRecord } from '../common/frappeTypes.js';
import { diffMetadata, MetadataValidationError, validateDocType } from '../common/frappeMetadata.js';
import { ISiteConnectionService } from '../connection/connectionService.js';
import { IFrappeClient } from '../connection/frappeClient.js';
import { createDocType, deleteDocType, getDoctypeDocument, updateDoctype } from '../connection/doctypeService.js';
import { buildDoctypeEditorDocument } from './doctypeEditorUi.js';
import { FrappeWebviewController } from './frappeWebviewEditor.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';

export interface DoctypeEditorOpenInfo {
	/** Connection id, used for session lookups. */
	readonly connectionId: string;
	/** Connected site origin; display + session context. */
	readonly siteOrigin: string;
	/** `undefined` opens a creation flow; a name opens the editor. */
	readonly doctypeName?: string;
}

// ---- Host -> Webview messages -------------------------------------------------------------
interface InitDoktypePayload {
	readonly type: 'init';
	readonly rawJson: JsonRecord;
	readonly doctypeName: string | undefined;
	readonly site: string;
	readonly readOnly: boolean;
}
interface SaveResultPayload { readonly type: 'saveResult'; readonly ok: boolean; readonly message: string | undefined }
interface NoticePayload { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }

export type DoctypeEditorOutgoing = InitDoktypePayload | SaveResultPayload | NoticePayload;

// ---- Webview -> Host messages -------------------------------------------------------------
export type DoctypeEditorIncoming = { type: 'ready' } | { type: 'save'; rawJson: JsonRecord } | { type: 'reload' } | { type: 'delete' };

export class DoctypeEditorController extends FrappeWebviewController<DoctypeEditorIncoming, DoctypeEditorOutgoing> {

	protected readonly editorViewType = 'frappeStudio.doctypeEditor';

	private openInfo: DoctypeEditorOpenInfo | undefined;
	private baselineJson: JsonRecord | undefined;
	private siteClient: IFrappeClient | undefined;
	private readonly tokenSource = new CancellationTokenSource();

	static create(instantiationService: IInstantiationService): DoctypeEditorController {
		return instantiationService.createInstance(DoctypeEditorController);
	}

	constructor(
		@IWebviewWorkbenchService webviewWorkbenchService: IWebviewWorkbenchService,
		@ISiteConnectionService private readonly connectionService: ISiteConnectionService,
		@ILogService private readonly logService: ILogService
	) {
		super(webviewWorkbenchService);
	}

	/** Opens (or focuses) the visual DocType Studio for a site. */
	async show(openInfo: DoctypeEditorOpenInfo): Promise<void> {
		this.openInfo = openInfo;
		this.siteClient = this.lookupClient(openInfo.connectionId);
		this.baselineJson = undefined;
		const title = openInfo.doctypeName
			? localize({ key: 'frappeStudio.doctypeEditorTitle', comment: ['{0} is the DocType name'] }, 'DocType Studio: {0}', openInfo.doctypeName)
			: localize('frappeStudio.newDoctypeEditorTitle', 'DocType Studio: New DocType');
		this.openEditor(title, () => buildDoctypeEditorDocument());
	}

	clientFor(connectionId: string): IFrappeClient | undefined {
		return this.connectionService.getSession(connectionId)?.client;
	}

	private lookupClient(connectionId: string): IFrappeClient {
		const session = this.connectionService.getSession(connectionId);
		if (!session) {
			throw new Error(localize('frappeStudio.noSession', 'No connected session for this site.'));
		}
		return session.client;
	}

	protected handleMessage(message: DoctypeEditorIncoming): void {
		switch (message.type) {
			case 'ready':
				void this.pushInit();
				return;
			case 'reload':
				void this.pushInit();
				return;
			case 'save':
				void this.save(message.rawJson);
				return;
			case 'delete':
				void this.deleteCurrent();
				return;
		}
	}

	private async pushInit(): Promise<void> {
		const info = this.openInfo;
		const client = this.siteClient;
		if (!info || !client) {
			return;
		}
		try {
			let rawJson: JsonRecord;
			if (info.doctypeName) {
				rawJson = await getDoctypeDocument(client, info.doctypeName, this.tokenSource.token);
			} else {
				rawJson = newDoctypeSkeleton();
			}
			this.baselineJson = sanitizeJsonRecord(rawJson);
			const session = this.connectionService.getSession(info.connectionId);
			this.post({
				type: 'init',
				rawJson,
				doctypeName: info.doctypeName,
				site: info.siteOrigin,
				readOnly: !session
			});
		} catch (error) {
			this.logService.warn('[Frappe Studio] DocType init failed', error instanceof Error ? error.name : String(error));
			this.post({ type: 'notice', level: 'error', message: describeError(error) });
		}
	}

	private async save(candidate: JsonRecord): Promise<void> {
		const info = this.openInfo;
		const client = this.siteClient;
		if (!info || !client) {
			return;
		}
		try {
			validateDocType(candidate);
			if (this.baselineJson && info.doctypeName && diffMetadata(this.baselineJson, candidate).length === 0) {
				this.post({ type: 'notice', level: 'info', message: localize('frappeStudio.noChanges', 'There were no changes to save.') });
				return;
			}
			if (info.doctypeName) {
				await updateDoctype(client, candidate, this.tokenSource.token);
			} else {
				const created = await createDocType(client, { ...candidate, new: 1 }, this.tokenSource.token);
				const newRecord = created.message?.['name'];
				if (typeof newRecord === 'string') {
					this.openInfo = { ...info, doctypeName: newRecord };
				}
			}
			// Reload and verify so the editor state is what the server accepted; external
			// modifications since open become visible through this refresh.
			this.baselineJson = undefined;
			await this.pushInit();
			this.post({ type: 'saveResult', ok: true, message: localize('frappeStudio.saved', 'Saved.') });
		} catch (error) {
			const message = describeError(error);
			this.logService.debug('[Frappe Studio] doc save failed', error instanceof Error ? error.name : String(error));
			this.post(error instanceof MetadataValidationError
				? { type: 'saveResult', ok: false, message }
				: { type: 'saveResult', ok: false, message });
		}
	}

	private async deleteCurrent(): Promise<void> {
		const info = this.openInfo;
		const client = this.siteClient;
		if (!info?.doctypeName || !client) {
			return;
		}
		try {
			await deleteDocType(client, info.doctypeName, this.tokenSource.token);
			this.post({ type: 'saveResult', ok: true, message: localize('frappeStudio.deleted', 'Deleted.') });
			this.input?.dispose();
		} catch (error) {
			this.post({ type: 'saveResult', ok: false, message: describeError(error) });
		}
	}

	protected override editorClosed(): void {
		this.tokenSource.cancel();
		super.editorClosed();
	}
}

/** Ensures only plain JSON survives across the editor boundary. */
export function sanitizeJsonRecord(raw: Json | undefined): JsonRecord | undefined {
	return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as JsonRecord) : undefined;
}

export function newDoctypeSkeleton(): JsonRecord {
	return {
		name: '',
		module: '',
		custom: 0,
		istable: 0,
		issingle: 0,
		istree: 0,
		isvirtual: 0,
		is_submittable: 0,
		autoname: 'field:__newname__',
		naming_rule: 'Expression (old style)',
		engine: 'InnoDB',
		permissions: [
			{ role: 'System Manager', read: 1, write: 1, create: 1, delete: 1, email: 1, print: 1, export: 1, import: 1 }
		],
		fields: [],
		field_order: [],
		track_changes: 0,
		sort_field: 'modified',
		sort_order: 'DESC',
		title_field: '',
		image_field: '',
		search_fields: ''
	};
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
