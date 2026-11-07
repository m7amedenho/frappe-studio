/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { FrappeDocSummary, FrappeMethodResult, Json, JsonRecord } from '../common/frappeTypes.js';
import { IFrappeClient } from './frappeClient.js';

/**
 * Data access for core Frappe documents (DocTypes, Reports, Workflows, Print Formats,
 * customizations). Only whitelisted `frappe.client.*` methods are used, because those are
 * the stable public contracts of Frappe Framework; older sites are served by falling back
 * to a smaller field set when a column does not exist yet.
 */

const MinimalDocTypeFields = JSON.stringify(['name', 'module', 'custom', 'istable', 'issingle', 'is_submittable']);
const RichDocTypeFields = JSON.stringify(['name', 'module', 'app', 'custom', 'istable', 'issingle', 'is_submittable', 'istree', 'isvirtual', 'track_changes', 'naming_rule', 'autoname', 'sort_field', 'sort_order', 'modified']);

function asString(value: Json | undefined): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asSummary(record: JsonRecord): FrappeDocSummary {
	return {
		name: String(record['name'] ?? ''),
		module: asString(record['module']),
		standard: Boolean(!record['custom']),
	};
}

export async function listDocTypes(client: IFrappeClient, token: CancellationToken, onlyCustom?: boolean): Promise<readonly FrappeDocSummary[]> {
	let records: JsonRecord[];
	try {
		const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
			doctype: 'DocType',
			fields: RichDocTypeFields,
			limit_page_length: '0',
			order_by: 'name asc'
		}, undefined, token);
		records = reply.message;
	} catch {
		const minimalReply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
			doctype: 'DocType',
			fields: MinimalDocTypeFields,
			limit_page_length: '0',
			order_by: 'name asc'
		}, undefined, token);
		records = minimalReply.message;
	}
	return records
		.filter(record => typeof record['name'] === 'string')
		.filter(record => onlyCustom === undefined || Boolean(record['custom']) === onlyCustom)
		.map(asSummary);
}

export async function getDoctypeDocument(client: IFrappeClient, name: string, token: CancellationToken): Promise<JsonRecord> {
	const reply = await client.callMethod<JsonRecord>('frappe.client.get', 'GET', { doctype: 'DocType', name }, undefined, token);
	const doc = reply.message;
	if (doc && typeof doc === 'object' && typeof doc['name'] === 'string') {
		return doc;
	}
	throw new Error(`DocType ${name} could not be loaded.`);
}

export function createDocType(client: IFrappeClient, doc: JsonRecord, token: CancellationToken): Promise<FrappeMethodResult<JsonRecord>> {
	return client.callMethod<JsonRecord>('frappe.client.insert', 'POST', undefined, { doc }, token);
}

export function updateDoctype(client: IFrappeClient, doc: JsonRecord, token: CancellationToken): Promise<FrappeMethodResult<JsonRecord>> {
	return client.callMethod<JsonRecord>('frappe.client.update', 'POST', undefined, { doc }, token);
}

export function deleteDocType(client: IFrappeClient, name: string, token: CancellationToken): Promise<FrappeMethodResult<unknown>> {
	return client.callMethod<unknown>('frappe.client.delete', 'POST', { doctype: 'DocType', name }, undefined, token);
}

export async function listModules(client: IFrappeClient, token: CancellationToken): Promise<readonly { readonly name: string; readonly app?: string }[]> {
	try {
		const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
			doctype: 'Module Def', fields: JSON.stringify(['name', 'app_name']), limit_page_length: '0', order_by: 'name asc'
		}, undefined, token);
		return reply.message.map(record => ({ name: String(record['name'] ?? ''), app: asString(record['app_name']) }));
	} catch {
		const minimalReply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
			doctype: 'Module Def', fields: JSON.stringify(['name']), limit_page_length: '0', order_by: 'name asc'
		}, undefined, token);
		return minimalReply.message.map(record => ({ name: String(record['name'] ?? '') }));
	}
}

export interface IReportRef {
	readonly name: string;
	readonly refDoctype: string | undefined;
	readonly reportType: string;
}

export async function listReports(client: IFrappeClient, token: CancellationToken): Promise<readonly IReportRef[]> {
	const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
		doctype: 'Report', fields: JSON.stringify(['name', 'ref_doctype', 'report_type']), limit_page_length: '0', order_by: 'name asc'
	}, undefined, token);
	return reply.message.map(record => ({
		name: String(record['name'] ?? ''),
		refDoctype: asString(record['ref_doctype']),
		reportType: String(record['report_type'] ?? 'Query Report')
	}));
}

export interface IWorkflowRef {
	readonly name: string;
	readonly documentType: string | undefined;
}

export async function listWorkflows(client: IFrappeClient, token: CancellationToken): Promise<readonly IWorkflowRef[]> {
	const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
		doctype: 'Workflow', fields: JSON.stringify(['name', 'document_type']), limit_page_length: '0', order_by: 'name asc'
	}, undefined, token);
	return reply.message.map(record => ({
		name: String(record['name'] ?? ''),
		documentType: asString(record['document_type'])
	}));
}

export async function listPrintFormats(client: IFrappeClient, token: CancellationToken): Promise<readonly { readonly name: string; readonly docType: string | undefined }[]> {
	const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
		doctype: 'Print Format', fields: JSON.stringify(['name', 'doc_type']), limit_page_length: '0', order_by: 'name asc'
	}, undefined, token);
	return reply.message.map(record => ({
		name: String(record['name'] ?? ''),
		docType: asString(record['doc_type'])
	}));
}

export async function listCustomFields(client: IFrappeClient, doctype: string, token: CancellationToken): Promise<readonly JsonRecord[]> {
	const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
		doctype: 'Custom Field',
		fields: JSON.stringify(['name', 'fieldname', 'fieldtype', 'label', 'insert_after', 'dt', 'options', 'read_only', 'reqd', 'hidden', 'print_hide', 'in_list_view', 'in_standard_filter', 'in_global_search', 'default', 'depends_on', 'description']),
		filters: JSON.stringify({ dt: doctype }),
		limit_page_length: '0',
		order_by: 'name asc'
	}, undefined, token);
	return reply.message;
}

export async function listPropertySetters(client: IFrappeClient, doctype: string, token: CancellationToken): Promise<readonly JsonRecord[]> {
	const reply = await client.callMethod<JsonRecord[]>('frappe.client.get_list', 'POST', {
		doctype: 'Property Setter',
		fields: JSON.stringify(['name', 'doctype_or_field', 'property', 'property_type', 'value', 'doc_type', 'field_name']),
		filters: JSON.stringify({ doc_type: doctype }),
		limit_page_length: '0'
	}, undefined, token);
	return reply.message;
}

export async function getSystemSettings(client: IFrappeClient, token: CancellationToken): Promise<JsonRecord | undefined> {
	try {
		const reply = await client.callMethod<JsonRecord>('frappe.client.get', 'GET', { doctype: 'System Settings', name: 'System Settings' }, undefined, token);
		return reply.message;
	} catch {
		return undefined;
	}
}

/** Inserts, updates or deletes a generic Frappe document through the whitelisted client methods. */
export function insertDoc(client: IFrappeClient, doctype: string, doc: JsonRecord, token: CancellationToken): Promise<FrappeMethodResult<JsonRecord>> {
	const payload = { ...doc, doctype };
	return client.callMethod<JsonRecord>('frappe.client.insert', 'POST', undefined, { doc: payload }, token);
}

export function updateDoc(client: IFrappeClient, doctype: string, doc: JsonRecord, token: CancellationToken): Promise<FrappeMethodResult<JsonRecord>> {
	const payload = { ...doc, doctype };
	return client.callMethod<JsonRecord>('frappe.client.update', 'POST', undefined, { doc: payload }, token);
}

export function deleteDoc(client: IFrappeClient, doctype: string, name: string, token: CancellationToken): Promise<FrappeMethodResult<unknown>> {
	return client.callMethod<unknown>('frappe.client.delete', 'POST', { doctype, name }, undefined, token);
}
