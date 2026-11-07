/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frappe capability detection.
 *
 * Frappe Framework releases differ in which HTTP methods and metadata properties they
 * expose. Frappe Studio never assumes an API exists: it probes the documented candidates
 * at connect time and records a capability map for the rest of the product to consult.
 */

import { NormalizedSiteUrl } from './frappeUrl.js';

/** Documented methods Frappe Studio relies on, plus fallback candidates per capability. */
export interface ICapabilityProbe {
	readonly capability: FrappeCapability;
	readonly method: 'GET' | 'POST';
	readonly endpoint: string;
	/** Optional body for POST probes; GET probes always send no body. */
	readonly body?: string;
	/** Content-Type used with the probe body. */
	readonly contentType?: string;
	readonly expectsJson: boolean;
}

export type FrappeCapability =
	| 'get_logged_user'
	| 'csrf_token'
	| 'get_versions'
	| 'doctype_list'
	| 'doctype_table_search'
	| 'run_query_report'
	| 'print_view'
	| 'deskside_fs'
	| 'search_metadata';

const baseMethod = '/api/method/';

export const CAPABILITY_PROBES: readonly ICapabilityProbe[] = [
	{ capability: 'get_logged_user', method: 'GET', endpoint: `${baseMethod}frappe.auth.get_logged_user`, expectsJson: true },
	{ capability: 'csrf_token', method: 'GET', endpoint: `${baseMethod}frappe.auth.get_csrf_token`, expectsJson: true },
	{ capability: 'get_versions', method: 'GET', endpoint: `${baseMethod}frappe.get_versions`, expectsJson: true },
	{ capability: 'doctype_list', method: 'GET', endpoint: '/api/resource/DocType?limit_page_length=1', expectsJson: true },
	{ capability: 'doctype_table_search', method: 'POST', endpoint: `${baseMethod}frappe.desk.search.search_link`,
		body: 'txt=&doctype=DocType&query_field=name', contentType: 'application/x-www-form-urlencoded', expectsJson: true },
	{ capability: 'run_query_report', method: 'GET', endpoint: `${baseMethod}frappe.desk.query_report.run?report_name=undefined`, expectsJson: true },
	{ capability: 'print_view', method: 'GET', endpoint: '/printview', expectsJson: false },
	{ capability: 'deskside_fs', method: 'GET', endpoint: `${baseMethod}frappe.desk.desk_page.getdeskpage?name=undefined`, expectsJson: true },
	{ capability: 'search_metadata', method: 'POST', endpoint: `${baseMethod}frappe.desk.search.search_widget`,
		body: 'txt=&limit=5', contentType: 'application/x-www-form-urlencoded', expectsJson: true }
];

export interface IFrappeCapabilities {
	readonly has: (capability: FrappeCapability) => boolean;
	readonly raw: ReadonlyMap<FrappeCapability, boolean>;
}

/** Builds the capability map from probe HTTP status outcomes. */
export function buildCapabilities(statuses: ReadonlyMap<FrappeCapability, number | undefined>): IFrappeCapabilities {
	const raw = new Map<FrappeCapability, boolean>();
	for (const probe of CAPABILITY_PROBES) {
		const status = statuses.get(probe.capability);
		raw.set(probe.capability, status !== undefined && status >= 200 && status < 300);
	}
	// `frappe.desk.query_report.run` rejects empty `report_name` with 4xx even when the
	// method itself exists; treat any structured Frappe-style error as present.
	raw.set('run_query_report', statuses.get('run_query_report') !== undefined && (statuses.get('run_query_report')! < 500 && statuses.get('run_query_report')! !== 404));
	return {
		has: capability => raw.get(capability) === true,
		raw
	};
}

export interface IFrappeVersionInfo {
	readonly frappe: string | undefined;
	readonly apps: readonly { readonly name: string; readonly version: string | undefined }[];
	readonly developerMode: 'enabled' | 'disabled' | 'unknown';
}

const versionFromResponse = (value: unknown): string | undefined => {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number') {
		return String(value);
	}
	if (value && typeof value === 'object') {
		const asRecord = value as { readonly message?: unknown; readonly version?: unknown; readonly framework_version?: unknown; readonly frappe?: unknown };
		if (typeof asRecord.message === 'string') {
			return asRecord.message;
		}
		if (typeof asRecord.version === 'string') {
			return asRecord.version;
		}
	}
	return undefined;
};

/** Parses `frappe.get_versions` style responses, which differ between Frappe versions. */
export function parseVersionProbe(payload: unknown): IFrappeVersionInfo {
	const root = unwrapPayload(payload);
	if (!root || typeof root !== 'object') {
		return { frappe: undefined, apps: [], developerMode: 'unknown' };
	}
	const record = root as Record<string, unknown>;
	const apps: { name: string; version: string }[] = [];
	let frappeVersion: string | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (value && typeof value === 'object') {
			const info = value as Record<string, unknown>;
			const v = versionFromResponse(info.version) ?? versionFromResponse(info.framework_version) ?? versionFromResponse(info.branch_version);
			if (v) {
				if (key.toLowerCase() === 'frappe') {
					frappeVersion = v;
				} else {
					apps.push({ name: key, version: v });
				}
			}
		}
	}
	if (!frappeVersion) {
		frappeVersion = versionFromResponse(record.frappe) ?? versionFromResponse(record.framework_version);
	}
	return { frappe: frappeVersion, apps, developerMode: 'unknown' };
}

function unwrapPayload(value: unknown): unknown {
	if (value && typeof value === 'object' && 'message' in (value as Record<string, unknown>)) {
		return (value as Record<string, unknown>)['message'];
	}
	return value;
}

/**
 * Which Frappe metadata properties exist on the connected site; used to hide sections of
 * the metadata editor for older sites rather than writing unsupported keys back.
 */
export interface IMetadataPropertySupport {
	readonly property: string;
	/** Minimum Frappe version that supports it, as major; undefined means always supported. */
	readonly since: number | undefined;
}

export const METADATA_PROPERTY_SUPPORT: readonly IMetadataPropertySupport[] = [
	{ property: 'track_views', since: 12 },
	{ property: 'istree', since: 11 },
	{ property: 'isvirtual', since: 13 },
	{ property: 'naming_rule', since: 13 },
	{ property: 'engine', since: 13 },
	{ property: 'search_fields', since: undefined },
	{ property: 'timeline_new', since: undefined },
	{ property: 'custom', since: undefined }
];

export function metadataPropertySupported(property: string, frappeVersion: string | undefined): boolean {
	const support = METADATA_PROPERTY_SUPPORT.find(s => s.property === property);
	if (!support || support.since === undefined) {
		return true;
	}
	if (!frappeVersion) {
		// Cannot verify: leave the property visible but untouched, never write it blindly.
		return true;
	}
	const major = parseMajorVersion(frappeVersion);
	if (major === undefined) {
		return true;
	}
	return major >= support.since;
}

export function parseMajorVersion(version: string | undefined): number | undefined {
	if (!version) {
		return undefined;
	}
	const match = /(?:^|v)(\d+)/.exec(version.trim());
	return match ? Number(match[1]) : undefined;
}

export function connectionPath(site: NormalizedSiteUrl, endpoint: string): string {
	if (endpoint.startsWith('/api/') || endpoint.startsWith('/printview')) {
		return `${site.origin}${endpoint}`;
	}
	return `${site.origin}${baseMethod}${endpoint}`;
}
