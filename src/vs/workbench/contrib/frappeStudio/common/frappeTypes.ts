/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frappe Framework domain types used across Frappe Studio.
 *
 * These types mirror the metadata structure used by Frappe Framework
 * (DocType, Custom Field, Workflow, Report, Print Format) so that Frappe Studio
 * can round-trip real server metadata without inventing a proprietary format.
 */

export const enum FrappeConnectionState {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	UpAuthenticating = 'authenticating',
	Connected = 'connected',
	Failed = 'failed'
}

export type DeveloperModeStatus = 'enabled' | 'disabled' | 'unknown';

export interface FrappeSiteIdentity {
	readonly siteName: string;
	readonly currentUser: string | undefined;
	readonly frappeVersion: string | undefined;
	readonly developerMode: DeveloperModeStatus;
	readonly installedApps: readonly FrappeApp[];
}

export interface FrappeApp {
	readonly name: string;
	readonly version: string | undefined;
	readonly modules: readonly string[];
}

export interface FrappeModule {
	readonly name: string;
	readonly app: string;
}

export interface FrappeDocSummary {
	readonly name: string;
	readonly title?: string;
	readonly module?: string;
	readonly standard: boolean;
}

export interface FrappeField {
	name: string;
	fieldtype: string;
	label?: string;
	options?: string;
	description?: string;
}

export interface FrappeWorkflowTransition {
	readonly state: string;
	readonly action: string;
	readonly next_state: string;
	readonly allowed: string[];
	readonly condition: string;
	readonly allow_self_approval: number | boolean;
}

export interface FrappeWorkflowState {
	readonly state: string;
	readonly doc_status: number;
	readonly allow_edit: number | boolean;
}

export interface FrappeWorkflow {
	readonly name: string;
	readonly document_type: string;
	readonly is_active: 0 | 1 | boolean;
	readonly states: FrappeWorkflowState[];
	readonly transitions: FrappeWorkflowTransition[];
}

export interface FrappeReportSummary {
	readonly name: string;
	readonly ref_doctype: string | undefined;
	readonly report_type: 'Query Report' | 'Script Report' | 'Report Builder' | string;
}

export interface FrappePrintFormatSummary {
	readonly name: string;
	readonly doc_type: string | undefined;
}

/** A Frappe HTTP method result. `exc` payloads use a plain shape rather than Frappe's richer objects. */
export interface FrappeMethodResult<T> {
	readonly message: T;
}

export interface FrappeListReply<T> {
	readonly data: readonly T[];
}

/** JSON value type that keeps Frappe metadata (which may contain unknown properties) flexible. */
export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json };
export type JsonRecord = { [key: string]: Json };
