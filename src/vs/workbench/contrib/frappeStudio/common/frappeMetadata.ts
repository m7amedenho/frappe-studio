/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Frappe metadata engine: the single source of truth for how DocType metadata is
 * validated, round-tripped, and reconciled between the visual editor and JSON.
 *
 * Design principles:
 * - Frappe metadata is never invented here. The model preserves every field that arrives
 *   from the server, including properties the visual editor does not know about.
 * - The visual editor works on a normalized projection; the JSON view works on the raw
 *   document. Both stay synchronized through the same model.
 * - Writes go through validation so that an editing mistake can never silently corrupt
 *   metadata on the server.
 */

import { Json, JsonRecord } from './frappeTypes.js';

export class MetadataValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MetadataValidationError';
	}
}

export interface IFieldProperty {
	readonly key: string;
	readonly label: string;
	readonly cell: 'text' | 'checkbox' | 'options';
	readonly options?: readonly string[];
	readonly dependsOnFieldtype?: readonly string[];
}

/** Field types in Frappe Framework (DocType Editor uses the same list of standard types). */
export const FRAPPE_FIELDTYPES: readonly string[] = [
	'Attach', 'Attach Image', 'Button', 'Check', 'Code', 'Color', 'Currency', 'Data',
	'Date', 'Datetime', 'Duration', 'Dynamic Link', 'Float', 'Geolocation', 'HTML',
	'Int', 'JSON', 'Link', 'Long Text', 'Password', 'Percent', 'Phone', 'Rating',
	'Read Only', 'Section Break', 'Select', 'Small Text', 'Table', 'Table MultiSelect',
	'Text', 'Text Editor', 'Time', 'Signature'
];

/** Field types that resolve to subclasses of Data and need a `precision` value for rounding. */
export const FRAPPE_NON_TEXT_FIELDTYPES: readonly string[] = ['Float', 'Currency', 'Percent', 'Int'];

const HIDDEN_GROUPS: ReadonlySet<string> = new Set(['Section Break', 'Column Break', 'Tab Break']);

export interface IFieldEditorProperty {
	readonly landable: IFieldProperty;
}

/**
 * The full properties inspector, grouped as the DocType Editor does it. Every property maps
 * directly to a Frappe field-definition property (`frappe.core.doctype.docfield`).
 */
export const FIELD_PROPERTIES: readonly IFieldEditorProperty[] = [
	{ landable: { key: 'label', label: 'Label', cell: 'text' } },
	{ landable: { key: 'fieldname', label: 'Fieldname', cell: 'text' } },
	{ landable: { key: 'fieldtype', label: 'Fieldtype', cell: 'options', options: FRAPPE_FIELDTYPES } },
	{ landable: { key: 'options', label: 'Options', cell: 'text' } },
	{ landable: { key: 'description', label: 'Description', cell: 'text' } },
	{ landable: { key: 'default', label: 'Default', cell: 'text' } },
	{ landable: { key: 'mandatory_depends_on', label: 'Mandatory Depends On', cell: 'text', dependsOnFieldtype: [] } },
	{ landable: { key: 'read_only_depends_on', label: 'Read Only Depends On', cell: 'text', dependsOnFieldtype: [] } },
	{ landable: { key: 'depends_on', label: 'Depends On', cell: 'text' } },
	{ landable: { key: 'fetch_from', label: 'Fetch From', cell: 'text' } },
	{ landable: { key: 'print_hide', label: 'In Print', cell: 'checkbox' } },
	{ landable: { key: 'print_width', label: 'Print Width', cell: 'text' } },
	{ landable: { key: 'read_only', label: 'Read Only', cell: 'checkbox' } },
	{ landable: { key: 'unique', label: 'Unique', cell: 'checkbox', dependsOnFieldtype: ['Data', 'Link'] } },
	{ landable: { key: 'hidden', label: 'Hidden', cell: 'checkbox' } },
	{ landable: { key: 'allow_on_submit', label: 'Allow on Submit', cell: 'checkbox' } },
	{ landable: { key: 'reqd', label: 'Mandatory', cell: 'checkbox' } },
	{ landable: { key: 'in_list_view', label: 'In List View', cell: 'checkbox' } },
	{ landable: { key: 'in_standard_filter', label: 'In Standard Filter', cell: 'checkbox' } },
	{ landable: { key: 'in_global_search', label: 'In Global Search', cell: 'checkbox' } },
	{ landable: { key: 'bold', label: 'Bold', cell: 'checkbox' } },
	{ landable: { key: 'length', label: 'Length', cell: 'text' } },
	{ landable: { key: 'contains_html', label: 'Contains HTML', cell: 'checkbox' } },
	{ landable: { key: 'translatable', label: 'Translatable', cell: 'checkbox' } },
	{ landable: { key: 'width', label: 'Width', cell: 'text', dependsOnFieldtype: ['Section Break'] } },
	{ landable: { key: 'non_negative', label: 'Non Negative', cell: 'checkbox', dependsOnFieldtype: FRAPPE_NON_TEXT_FIELDTYPES } },
	{ landable: { key: 'search_index', label: 'Search Index', cell: 'checkbox' } },
	{ landable: { key: 'remember_last_selected_value', label: 'Remember Last Selected Value', cell: 'checkbox', dependsOnFieldtype: ['Link'] } },
	{ landable: { key: 'allow_in_quick_entry', label: 'Allow in Quick Entry', cell: 'checkbox' } },
	{ landable: { key: 'ignore_user_permissions', label: 'Ignore User Permissions', cell: 'checkbox' } },
	{ landable: { key: 'mandatory_depends_on_2', label: '', cell: 'text' } }, // placeholder unused
];

/** DocType-level properties that need to round-trip untouched. */
export const DOCTYPE_META_PROPERTIES: readonly string[] = [
	'name', 'module', 'app', 'istable', 'issingle', 'istree', 'isvirtual', 'custom',
	'is_submittable', 'ismapper', 'istable_child', 'autoname', 'naming_rule', 'engine',
	'title_field', 'image_field', 'sort_field', 'sort_order', 'track_changes',
	'track_seen', 'track_views', 'default_view', 'in_create', 'editable_grid',
	'description', 'documentation_url', 'idx', 'search_fields', 'subject_field',
	'doctype_parent', 'permissions', 'field_order', 'owner', 'creation',
	'modified', 'modified_by'
];

const UNTANGLE_KEY_MAP = new Map<string, string>([['mandatory_depends_on_2', 'mandatory_depends_on']]);

const breakTypes = new Set(['Section Break', 'Column Break', 'Tab Break']);
const tableTypes = new Set(['Table', 'Table MultiSelect']);
const textSubTypes = new Set(['Data', 'Time', 'Datetime', 'Duration', 'Currency', 'Color']);

/** Properties that make sense for 'Data'-family fields. */
export function visiblePropertiesForFieldtype(fieldtype: string): readonly string[] {
	if (breakTypes.has(fieldtype)) {
		return ['label', 'collapsible', 'depends_on', 'hidden', 'width'];
	}
	if (HIDDEN_GROUPS.has(fieldtype)) {
		return [];
	}
	const base = ['label', 'fieldname', 'fieldtype', 'options', 'description', 'default', 'depends_on',
		'mandatory_depends_on', 'read_only_depends_on', 'reqd', 'read_only', 'hidden', 'allow_on_submit',
		'in_list_view', 'in_standard_filter', 'in_global_search', 'in_preview', 'bold',
		'allow_in_quick_entry', 'search_index', 'ignore_user_permissions', 'translation'];
	if (tableTypes.has(fieldtype)) {
		return ['label', 'fieldname', 'fieldtype', 'options', 'description', 'reqd', 'hidden',
			'allow_on_submit', 'in_list_view', 'in_standard_filter', 'in_global_search'];
	}
	if (fieldtype === 'Select') {
		base.splice(base.indexOf('options'), 0);
	}
	if (textSubTypes.has(fieldtype)) {
		base.push('unique', 'length', 'fetch_if_empty');
	}
	if (FRAPPE_NON_TEXT_FIELDTYPES.includes(fieldtype)) {
		base.push('precision', 'non_negative');
	}
	return base;
}

/**
 * Reconciles the raw Frappe DocType JSON with changes coming from the visual editor.
 * Unknown properties on each field are preserved exactly as the server sent them.
 */
export function reconcileDocType(raw: JsonRecord, visualFields: readonly JsonRecord[]): JsonRecord {
	const result: JsonRecord = {};
	for (const key of Object.keys(raw)) {
		if (key !== 'fields' && Array.isArray(raw[key]) === false) {
			result[key] = raw[key];
		} else if (key !== 'fields') {
			result[key] = raw[key];
		}
	}
	if (Array.isArray(raw['field_order'])) {
		result['field_order'] = [...raw['field_order']];
	}
	const rawFields = Array.isArray(raw['fields']) ? (raw['fields'] as JsonRecord[]) : [];
	result['fields'] = reconcileFields(rawFields, visualFields);
	result['field_order'] = (result['fields'] as JsonRecord[]).map(f => String(f['fieldname'] ?? ''));
	return result;
}

/**
 * Merges each raw field with a visual edit of the same field. Any unknown keys that
 * the visual editor did not hand back stay exactly as they were.
 */
function reconcileFields(rawFields: readonly JsonRecord[], visualFields: readonly JsonRecord[]): JsonRecord[] {
	const rawByName = new Map<string, JsonRecord>(rawFields.filter(f => typeof f['fieldname'] === 'string').map(f => [String(f['fieldname']), f]));
	const keptUnknown = rawFields.filter(f => !(typeof f['fieldname'] === 'string' && visualFields.some(v => v['fieldname'] === f['fieldname'])));
	const merged = visualFields.map(visual => {
		const raw = rawByName.get(String(visual['fieldname']));
		const base: JsonRecord = raw ? { ...raw } : {};
		deepMergeShallow(base, visual, new Set(['name']));
		return base;
	});
	return merged.concat(keptUnknown);
}

/** Copies non-undefined properties from source onto target without dropping target-only keys. */
function deepMergeShallow(target: JsonRecord, source: JsonRecord, skip: ReadonlySet<string>): void {
	for (const key of Object.keys(source)) {
		if (skip.has(key)) {
			continue;
		}
		const value = source[key];
		if (value !== undefined && value !== null) {
			target[key] = value;
		}
	}
}

/** Normalizes a fieldname the way Frappe does when a field is created. */
export function fieldnameFromLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9_\s]/g, '')
		.trim()
		.replace(/\s+/g, '_')
		.replace(/_{2,}/g, '_')
		.replace(/^_+|_+$/g, '') || 'field';
}

/**
 * Validates a whole DocType challenge. Throws `MetadataValidationError` with a message the
 * UI can show directly. Used before any save request reaches the server.
 */
export function validateDocType(doctype: JsonRecord): void {
	const fields = Array.isArray(doctype['fields']) ? doctype['fields'] as JsonRecord[] : [];
	const seen = new Set<string>();
	for (const field of fields) {
		const fieldname = String(field['fieldname'] ?? '');
		const fieldtype = String(field['fieldtype'] ?? '');
		if (!fieldname) {
			throw new MetadataValidationError('A field is missing its fieldname.');
		}
		if (seen.has(fieldname)) {
			throw new MetadataValidationError(`Fieldname "${fieldname}" appears more than once.`);
		}
		seen.add(fieldname);
		if (!fieldtype) {
			throw new MetadataValidationError(`Field "${fieldname}" needs a fieldtype.`);
		}
		if (!FRAPPE_FIELDTYPES.includes(fieldtype)) {
			throw new MetadataValidationError(`Field "${fieldname}" has unknown fieldtype "${fieldtype}".`);
		}
		if ((fieldtype === 'Select') && !field['has_landscape'] && typeof field['options'] === 'string' && field['options'] === '') {
			throw new MetadataValidationError(`Field "${fieldname}" is a Select and needs its options.`);
		}
		if (tableTypes.has(fieldtype) && (!field['options'] || String(field['options']).length === 0)) {
			throw new MetadataValidationError(`Field "${fieldname}" (${fieldtype}) needs a child DocType as its options.`);
		}
	}
	const doctypeName = String(doctype['name'] ?? '');
	if (!doctypeName) {
		throw new MetadataValidationError('DocType name missing.');
	}
	// eslint-disable-next-line no-new
	UNTANGLE_KEY_MAP.clear();
	return;
}

export interface MetadataDiffEntry {
	readonly path: string;
	readonly before: Json | undefined;
	readonly after: Json | undefined;
}

/**
 * A structural diff between two JSON-shaped Frappe documents. Used by the JSON editor
 * to show exactly what changed before a save, so nothing is overwritten blindly.
 */
export function diffMetadata(before: JsonRecord, after: JsonRecord): readonly MetadataDiffEntry[] {
	const entries: MetadataDiffEntry[] = [];
	for (const key of unionKeys(before, after)) {
		pushDiff(entries, key, before[key], after[key]);
	}
	return entries;
}

function unionKeys(a: JsonRecord, b: JsonRecord): readonly string[] {
	const s = new Set(Object.keys(a));
	Object.keys(b).forEach(k => s.add(k));
	return [...s];
}

function pushDiff(entries: MetadataDiffEntry[], path: string, before: Json | undefined, after: Json | undefined): void {
	if (Array.isArray(before) && Array.isArray(after)) {
		const length = Math.max(before.length, after.length);
		for (let i = 0; i < length; i++) {
			pushDiff(entries, `${path}[${i}]`, before[i], after[i]);
		}
		return;
	}
	if (isRecord(before) && isRecord(after)) {
		for (const key of unionKeys(before, after)) {
			pushDiff(entries, `${path}.${key}`, before[key], after[key]);
		}
		return;
	}
	if (!jsonEquals(before, after)) {
		entries.push({ path, before, after });
	}
}

export function isRecord(value: Json | undefined): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonEquals(a: Json | undefined, b: Json | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
