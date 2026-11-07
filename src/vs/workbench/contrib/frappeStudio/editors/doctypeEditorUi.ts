/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildFrappeDocument, newFrappeNonce } from './frappeWebviewEditor.js';

/**
 * Visual DocType Studio document: field palette + form canvas + properties inspector with a
 * synchronized JSON view. The webview script performs no network access; the host controller
 * provides and receives data exclusively through the typed protocol.
 */

interface PaletteGroup { readonly category: string; readonly types: readonly string[] }

const PALETTE: readonly PaletteGroup[] = [
	{ category: 'Basic', types: ['Data', 'Small Text', 'Long Text', 'Text Editor', 'Text', 'Code', 'Read Only'] },
	{ category: 'Numbers', types: ['Int', 'Float', 'Currency', 'Percent'] },
	{ category: 'Choices', types: ['Check', 'Select', 'Link', 'Dynamic Link', 'Table', 'Table MultiSelect'] },
	{ category: 'Date and Time', types: ['Date', 'Datetime', 'Time', 'Duration'] },
	{ category: 'Media and Files', types: ['Attach', 'Attach Image', 'Signature'] },
	{ category: 'Layout', types: ['Section Break', 'Column Break', 'Tab Break'] },
	{ category: 'Other', types: ['Button', 'HTML', 'Rating', 'Geolocation', 'JSON', 'Phone', 'Color'] }
];

const INSPECTOR_GROUPS: readonly { readonly title: string; readonly keys: readonly (readonly [string, 'text' | 'check'])[] }[] = [
	{
		title: 'General',
		keys: [['label', 'text'], ['fieldname', 'text'], ['description', 'text'], ['default', 'text'], ['active_options', 'text']]
	},
	{
		title: 'Behaviour',
		keys: [['reqd', 'check'], ['read_only', 'check'], ['hidden', 'check'], ['unique', 'check'], ['allow_on_submit', 'check'],
		['in_list_view', 'check'], ['in_standard_filter', 'check'], ['in_global_search', 'check'], ['in_preview', 'check'],
		['bold', 'check'], ['allow_in_quick_entry', 'check'], ['ignore_user_permissions', 'check'], ['search_index', 'check'], ['translatable', 'check']]
	},
	{
		title: 'Advanced',
		keys: [['depends_on', 'text'], ['mandatory_depends_on', 'text'], ['read_only_depends_on', 'text'], ['fetch_from', 'text'],
		['fetch_if_empty', 'check'], ['precision', 'text'], ['length', 'text'], ['non_negative', 'check'],
		['print_hide', 'check'], ['print_width', 'text'], ['collapsible', 'check'], ['contains_html', 'check'], ['remember_last_selected_value', 'check']]
	}
];

const META_FIELDS: readonly (readonly [key: string, label: string, kind: 'text' | 'check'])[] = [
	['module', 'Module', 'text'],
	['autoname', 'Naming', 'text'],
	['naming_rule', 'Naming Rule', 'text'],
	['engine', 'Database Engine', 'text'],
	['istable', 'Child Table', 'check'],
	['issingle', 'Single', 'check'],
	['istree', 'Tree', 'check'],
	['isvirtual', 'Virtual', 'check'],
	['is_submittable', 'Submittable', 'check'],
	['custom', 'Custom', 'check'],
	['track_changes', 'Track Changes', 'check'],
	['title_field', 'Title Field', 'text'],
	['image_field', 'Image Field', 'text'],
	['sort_field', 'Sort Field', 'text'],
	['sort_order', 'Sort Order', 'text'],
	['search_fields', 'Search Fields', 'text']
];

const STYLES = `
* { box-sizing: border-box; }
body { margin:0; font-size:13px; height:100vh; display:flex; flex-direction:column; }
.fr-toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border, rgb(128 128 128/30%)); flex-wrap: wrap; }
.fr-toolbar .meta-chip { color: var(--vscode-descriptionForeground); }
.fr-body { flex:1; min-height:0; display:grid; grid-template-columns: 200px minmax(0,1fr) 290px; }
.fr-palette { border-right:1px solid var(--vscode-panel-border, rgb(128 128 128/30%)); overflow:auto; padding:6px; }
.fr-palette h3 { font-size:11px; margin:8px 2px 2px; text-transform:uppercase; letter-spacing:.4px; opacity:.75; }
.fr-palette button { display:block; width:100%; text-align:left; padding:3px 8px; margin:2px 0; background:transparent; color:var(--vscode-foreground); border:none; border-radius:3px; cursor:grab; font-size:12px; }
.fr-palette button:hover { background:var(--vscode-list-hoverBackground); }
.fr-canvas { overflow:auto; padding:10px 14px 40px; }
.fr-tab, .fr-section { border:1px solid var(--vscode-panel-border, rgb(128 128 128/30%)); border-radius:4px; margin:8px 0; }
.fr-tab > header, .fr-section > header { padding:2px 6px; border-bottom:1px solid var(--vscode-panel-border, rgb(128 128 128/20%)); display:flex; gap:4px; align-items:center; }
.fr-columns { display:flex; }
.fr-column { flex:1; padding:6px; border-right:1px solid var(--vscode-panel-border, rgb(128 128 128/15%)); min-height:30px; }
.fr-column:last-child { border-right:none; }
.fr-row { display:flex; align-items:center; gap:6px; padding:2px 4px; border:1px solid transparent; border-radius:3px; }
.fr-row:hover { background:var(--vscode-list-hoverBackground); }
.fr-row.selected { border-color:var(--vscode-focusBorder); background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
.fr-row .icon { opacity:.85; width:16px; text-align:center; }
.fr-row .type-chip { font-size:10px; padding:0 4px; border:1px solid var(--vscode-panel-border); border-radius:2px; color:var(--vscode-descriptionForeground); }
.fr-row .grow { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fr-row input[type=text] { background:transparent; color:inherit; border:none; font:inherit; padding:0; width:100%; }
.fr-row input[type=text]:focus { outline:1px solid var(--vscode-focusBorder); }
.fr-dragover { box-shadow: 0 -2px 0 var(--vscode-focusBorder); }
.fr-inspector { border-left:1px solid var(--vscode-panel-border, rgb(128 128 128/30%)); overflow:auto; padding:6px; }
.fr-inspector h3 { font-size:11px; text-transform:uppercase; letter-spacing:.4px; margin:10px 0 4px; opacity:.75; }
.fr-prop { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:2px; }
.fr-prop label { flex:0 0 46%; overflow:hidden; text-overflow:ellipsis; }
.fr-prop input[type=text], .fr-prop input[type=number], .fr-prop select { flex:1; min-width:0; width:100%; }
.fr-prop textarea { width:100%; min-height:56px; }
.fr-toolbar button, .fr-json button, .fr-section button, .fr-row button, .fr-inspector button { background:var(--vscode-button-secondaryBackground, transparent); color:var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border:1px solid var(--vscode-panel-border); border-radius:3px; padding:2px 8px; cursor:pointer; font-size:12px; }
.fr-json { position:absolute; inset:0; background:var(--vscode-editor-background); z-index:5; display:none; flex-direction:column; }
.fr-json.visible { display:flex; }
.fr-json textarea { flex:1; font-family:ui-monospace, monospace; font-size:12px; background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); border:1px solid var(--vscode-panel-border); padding:8px; }
.fr-ok { color:var(--vscode-testing-iconPassed, green); }
.fr-bad { color:var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
.fr-empty { color:var(--vscode-descriptionForeground); text-align:center; padding:16px; }
.fr-checks { color:var(--vscode-descriptionForeground); font-size:12px; padding:0 8px 6px; }
`;

const SCRIPT = String.raw`
'use strict';
const vscode = acquireVsCodeApi();
const $ = sel => document.querySelector(sel);
const FRAPPE_FIELDTYPES = /^/;
const BREAKS = new Set(['Section Break','Column Break','Tab Break']);
const INSPECTOR_GROUPS = AS_JSON_INSPECTOR_GROUPS;
const META_FIELDS = AS_JSON_META_FIELDS;
const PALETTE_GROUPS = AS_JSON_PALETTE;

let meta = {};
let fields = [];            // flat array; break objects are regular entries keeping drag/drop uniform
let selected = -1;
let readOnly = false;
let doctypeName = undefined;
const undoStack = [];
const redoStack = [];
let dirty = false;

function isBreak(type) { return BREAKS.has(type); }

function snapshot() {
  undoStack.push(JSON.stringify({ meta: { ...meta }, fields: fields.map(f => ({ ...f })) }));
  if (undoStack.length > 150) { undoStack.shift(); }
  redoStack.length = 0;
  dirty = true;
  $('#dirtybadge').hidden = false;
}

function applySnapshot(text) {
  const parsed = JSON.parse(text);
  meta = parsed.meta;
  fields = parsed.fields;
  selected = Math.min(selected, fields.length - 1);
  renderAll();
}

function undo() { if (!undoStack.length || readOnly) { return; }
  redoStack.push(JSON.stringify({ meta: { ...meta }, fields: fields.map(f => ({ ...f })) }));
  applySnapshot(undoStack.pop());
}

function redo() { if (!redoStack.length || readOnly) { return; }
  undoStack.push(JSON.stringify({ meta: { ...meta }, fields: fields.map(f => ({ ...f })) }));
  applySnapshot(redoStack.pop());
}

function uniqueFieldname(label, ignoreIndex) {
  const base = (label || 'field').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
  const names = new Set(fields.filter((f, i) => i !== ignoreIndex && f.fieldname).map(f => f.fieldname));
  let name = base, i = 2;
  while (names.has(name)) { name = base + '_' + i; i++; }
  return name;
}

/** Insert position helper: append inside the current column/section context when possible. */
function insertionIndexForPalette() {
  if (selected < 0) { return fields.length; }
  // after the selected field but only within its section (stops at a break)
  for (let i = selected + 1; i < fields.length; i++) {
    if (isBreak(fields[i].fieldtype)) { return i; }
  }
  return fields.length;
}

function addField(type, atIndex) {
  snapshot();
  const def = { fieldtype: type };
  if (isBreak(type)) {
    def.label = type === 'Section Break' ? 'Section' : type === 'Column Break' ? 'Column' : 'Tab';
    delete def.fieldname;
  } else {
    def.label = type;
    def.fieldname = uniqueFieldname(type);
  }
  if (type === 'Select') { def.options = '\n'; }
  const insertAt = Number.isFinite(atIndex) ? Math.max(0, Math.min(atIndex, fields.length)) : insertionIndexForPalette();
  fields.splice(insertAt, 0, def);
  selected = insertAt;
  renderAll();
}

function removeField(index) {
  const target = fields[index];
  if (!target) { return; }
  snapshot();
  // Removing a Section/Tab break leaves orphan columns/fields at the previous level; splice
  // them up to the next break so the flat list stays well-formed.
  fields.splice(index, 1);
  selected = -1;
  renderAll();
}

function moveBy(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= fields.length) { return; }
  snapshot();
  const [f] = fields.splice(index, 1);
  fields.splice(target, 0, f);
  selected = target;
  renderAll();
}

let drag = null; // { kind: 'existing', index } or { kind: 'new', fieldtype }
function onDragStart(e, index) {
  if (readOnly) { return; }
  drag = { kind: 'existing', index };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', 'move:' + index); } catch {}
}
function onDragOver(e) {
  if (!drag) { return; }
  e.preventDefault();
  e.currentTarget.classList.add('fr-dragover');
}
function onDragLeave(e) { e.currentTarget.classList.remove('fr-dragover'); }
function onDrop(e, index) {
  e.preventDefault();
  e.currentTarget.classList.remove('fr-dragover');
  if (!drag) { return; }
  if (drag.kind === 'existing') {
    if (drag.index !== index && drag.index + 1 !== index) {
      snapshot();
      const [f] = fields.splice(drag.index, 1);
      const target = drag.index < index ? index - 1 : index;
      fields.splice(target, 0, f);
      selected = target;
    }
  } else {
    addField(drag.fieldtype, index);
  }
  const payload = drag;
  drag = null;
}

// ===== structure =====
/** Groups the flat fields array into tabs -> sections -> columns -> rows without cloning. */
function buildTree(list) {
  const tab = { breakField: null, sections: [] };
  const root = { breakField: null, sections: [] };
  const tabs = [{ tab, sections: tab.sections }];
  let currentTab = tab;
  let currentSection = null;
  let currentColumn = null;
  const startSection = () => {
    if (!currentSection) {
      currentSection = { breakField: null, columns: [] };
      currentTab.sections.push(currentSection);
    }
    return currentSection;
  };
  for (const f of list) {
    const t = f.fieldtype;
    if (t === 'Tab Break') {
      currentTab = { breakField: f, sections: [] };
      const holder = { tab: currentTab, sections: currentTab.sections };
      tabs.push(holder);
      currentSection = null;
      currentColumn = null;
      continue;
    }
    if (t === 'Section Break') {
      currentSection = { breakField: f, columns: [] };
      currentTab.sections.push(currentSection);
      currentColumn = null;
      continue;
    }
    if (t === 'Column Break') {
      const section = startSection();
      currentColumn = { breakField: f, fields: [] };
      section.columns.push(currentColumn);
      continue;
    }
    const section = startSection();
    if (!currentColumn) {
      currentColumn = { breakField: null, fields: [] };
      section.columns.push(currentColumn);
    }
    currentColumn.fields.push(f);
  }
  const hasBreak = list.some(f => isBreak(f.fieldtype));
  if (!hasBreak) {
    // everything is in the implicit single column; show one plain section
    root.sections.push(startSection());
  }
  return tabs;
}

function indexByReference(list) {
  const map = new Map();
  list.forEach((f, i) => map.set(f, i));
  return map;
}

function paintPalette() {
  const palette = $('#palette');
  palette.innerHTML = PALETTE_GROUPS.map(group =>
    '<h3>' + esc(group.category) + '</h3>' +
    group.types.map(t => '<button draggable="true" data-type="' + esc(t) + '">' + esc(t) + '</button>').join('')
  ).join('');
  palette.querySelectorAll('button').forEach(button => {
    const type = button.dataset.type;
    button.addEventListener('click', () => addField(type));
    button.addEventListener('dragstart', e => {
      if (readOnly) { return; }
      drag = { kind: 'new', fieldtype: type };
      e.dataTransfer.effectAllowed = 'copy';
      try { e.dataTransfer.setData('text/plain', 'new:' + type); } catch {}
    });
  });
}

function paintCanvas() {
  const canvas = $('#canvas');
  const map = indexByReference(fields);
  const tabs = buildTree(fields);
  const parts = [];
  for (const holder of tabs) {
    const tabElem = holder.tab.breakField
      ? '<div class="fr-tab"><header>' + rowHtml(holder.tab.breakField, map.get(holder.tab.breakField), '\u2630') + '</header>'
      : '<div>';
    parts.push(tabElem);
    let sections = holder.sections;
    if (!sections.length) { sections = [{ breakField: null, columns: [{ breakField: null, fields: [] }] }]; }
    for (const section of sections) {
      let header = '';
      if (section.breakField) {
        header = '<header>' + rowHtml(section.breakField, map.get(section.breakField), '\u25a6') + '</header>';
      }
      const cols = section.columns.length ? section.columns : [{ breakField: null, fields: [] }];
      const colHtml = cols.map(col => {
        const header2 = col.breakField ? rowHtml(col.breakField, map.get(col.breakField), '\u25a4') : '';
        return '<div class="fr-column">' + header2 + (col.fields || []).map(f => rowHtml(f, map.get(f))).join('') + '</div>';
      }).join('');
      parts.push('<div class="fr-section">' + header + '<div class="fr-columns">' + colHtml + '</div></div>');
    }
    if (holder.tab.breakField) { parts.push('</div>'); }
  }
  canvas.innerHTML = parts.join('');
  wireRows(canvas);
  if (!fields.length) {
    canvas.innerHTML = '<div class="fr-empty">Add fields from the palette, or drag one here.</div>';
  }
}

function wireRows(scope) {
  scope.querySelectorAll('.fr-row').forEach(rowEl => {
    const idx = Number(rowEl.dataset.index);
    rowEl.addEventListener('click', () => { selected = idx; renderAll(); });
    if (!readOnly) {
      rowEl.setAttribute('draggable', 'true');
      rowEl.addEventListener('dragstart', e => onDragStart(e, idx));
      rowEl.addEventListener('dragover', e => { e.preventDefault(); rowEl.classList.add('fr-dragover'); });
      rowEl.addEventListener('dragleave', () => rowEl.classList.remove('fr-dragover'));
      rowEl.addEventListener('drop', e => onDrop(e, idx));
    } else {
      rowEl.setAttribute('draggable', 'false');
    }
  });
  scope.querySelectorAll('.fr-column').forEach(col => {
    if (readOnly) { return; }
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('fr-dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('fr-dragover'));
    col.addEventListener('drop', e => onDrop(e, fields.length));
  });
}

function rowHtml(field, index, breakIcon) {
  if (index === undefined) { return ''; }
  const type = field.fieldtype || '';
  const icon = isBreak(type) ? (breakIcon || '\u25a6') : typeIcon(type);
  const selectedClass = selected === index ? ' selected' : '';
  const removable = !readOnly && !isBreak(type);
  const label = esc(field.label || field.fieldname || type);
  const chips = chipHtml(field);
  return '<div class="fr-row' + selectedClass + '" data-index="' + index + '">' +
    '<span class="icon">' + icon + '</span>' +
    '<span class="grow">' + label + '</span>' +
    chips +
    (removable ? '<button class="min" title="Remove field" data-remove="' + index + '">&times;</button>' : '') +
    '</div>';
}

function chipHtml(field) {
  const type = field.fieldtype || '';
  if (['Link', 'Dynamic Link'].includes(type) && field.options) {
    return '<span class="type-chip">' + esc(String(String(field.options).split('\n')[0]).slice(0, 14)) + '</span>';
  }
  if (['Table', 'Table MultiSelect'].includes(type) && field.options) {
    return '<span class="type-chip">' + esc(String(field.options).slice(0, 14)) + '</span>';
  }
  if (type === 'Select' && field.options) {
    return '<span class="type-chip">' + esc(String(field.options).split('\n').filter(Boolean).slice(0, 2).join('/') .slice(0, 18)) + '</span>';
  }
  if (type === 'Check' && (field.default === 1 || field.default === '1')) {
    return '<span class="type-chip">on</span>';
  }
  if (field.reqd) {
    return '<span class="type-chip">required</span>';
  }
  return '';
}

function typeIcon(type) {
  switch (type) {
    case 'Check': return '\u2611';
    case 'Select': return '\u25be';
    case 'Link': return '\u2192';
    case 'Date': return '\uD83D\uDCC5';
    case 'Datetime': return '\uD83D\uDCC6';
    case 'Code': return '</>';
    case 'Read Only': return '\uD83D\uDD12';
    case 'Attach': case 'Attach Image': return '\uD83D\uDCCE';
    case 'Currency': case 'Float': case 'Percent': return '\uD83D\uDCC8';
    default: return '\u2022';
  }
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== inspector =====
/** Which inspector properties are relevant for the selected fieldtype. */
function visibleGroups(fieldtype) {
  if (isBreak(fieldtype)) {
    return [{ title: 'Layout', keys: [['label', 'text'], ['collapsible', 'check'], ['depends_on', 'text'], ['hidden', 'check']] }];
  }
  const groupings = INSPECTOR_GROUPS.map(g => ({ title: g.title, keys: [...g.keys] }));
  const relevant = new Set(['label', 'fieldname']);
  const linkish = ['Link', 'Dynamic Link'].includes(fieldtype);
  const tableish = fieldtype === 'Table' || fieldtype === 'Table MultiSelect';
  if (tableish || linkish || fieldtype === 'Select' || fieldtype === 'Dynamic Link') { relevant.add('options'); }
  if (!['Button', 'HTML', 'Attach', 'Attach Image', 'Signature', 'Geolocation', 'Color'].includes(fieldtype)) {
    relevant.add('description'); relevant.add('default');
    ['reqd', 'read_only', 'hidden', 'allow_on_submit', 'in_list_view', 'bold'].forEach(k => relevant.add(k));
  }
  if (['Select', 'Data', 'Small Text', 'Link', 'Table', 'Check'].includes(fieldtype)) {
    relevant.add('in_standard_filter'); relevant.add('in_global_search');
  }
  if (linkish) { relevant.add('fetch_from'); relevant.add('fetch_if_empty'); relevant.add('remember_last_selected_value'); }
  if (['Float', 'Currency', 'Percent'].includes(fieldtype)) { relevant.add('precision'); relevant.add('non_negative'); }
  if (['Data', 'Small Text', 'Long Text', 'Text', 'Text Editor', 'Code'].includes(fieldtype)) { relevant.add('length'); relevant.add('unique'); }
  if (fieldtype === 'Read Only') { relevant.add('ignore_user_permissions'); }
  for (const group of groupings) {
    (group).keys = group.keys.filter(([key]) => relevant.has(key));
  }
  return groupings.filter(g => g.keys.length);
}

function setProp(index, key, value) {
  const f = fields[index];
  if (!f || readOnly) { return; }
  const labelSuggest = key === 'fieldname' && !f.fieldname;
  snapshot();
  if (value === null) { delete f[key]; } else { f[key] = value; }
  if (labelSuggest && typeof value === 'string' && value) {
    f.fieldname = uniqueFieldname(value, index);
  }
  renderAll();
}

function paintInspector() {
  const inspector = $('#inspector');
  const field = fields[selected];
  if (!field) {
    inspector.innerHTML = '<div class="fr-empty">Select a field to edit its properties.</div>' +
      '<h3>DocType</h3><div class="fr-checks">' + esc(doctypeName || 'New DocType') + '</div>';
    return;
  }
  const type = field.fieldtype || '';
  const html = ['<h3>' + esc(type) + '</h3>'];
  const groups = visibleGroups(type);
  for (const group of groups) {
    html.push('<h3>' + esc(group.title) + '</h3>');
    for (const [key, kind] of group.keys) {
      html.push(propEditor(field, key, kind));
    }
  }
  if (type && typeIconNotBetter(type)) {
    // no dynamic extras
  }
  html.push('<button id="removefield">' + 'Remove field' + '</button>');
  inspector.innerHTML = html.join('');
  const removeBtn = inspector.querySelector('#removefield');
  if (removeBtn) { removeBtn.addEventListener('click', () => removeField(selected)); }
  bindInspector();
}

function typeIconNotBetter() { return false; }

function choicesAreList(fieldtype) {
  return ['Select', 'Code', 'HTML', 'Small Text', 'Text', 'Long Text', 'Text Editor', 'Table MultiSelect'].includes(fieldtype);
}

function propEditor(field, key, kind) {
  if (kind === 'check') {
    return '<div class="fr-prop"><label for="p_' + key + '">' + esc(humanize(key)) + '</label>' +
      '<input id="p_' + key + '" type="checkbox" ' + (field[key] ? 'checked' : '') + (readOnly ? ' disabled' : '') + ' /></div>';
  }
  const value = esc(field[key]);
  let widget;
  if (choicesAreList(field.fieldtype) && key === 'options') {
    widget = '<textarea id="p_options" rows="3"' + (readOnly ? ' disabled' : '') + '>' + value + '</textarea>';
  } else if (key === 'options' && ['Table', 'Table MultiSelect', 'Link', 'Dynamic Link'].includes(String(field.fieldtype))) {
    widget = '<input id="p_' + key + '" type="text" placeholder="DocType name" value="' + value + '"' + (readOnly ? ' disabled' : '') + ' />';
  } else {
    widget = '<input id="p_' + key + '" type="text" value="' + value + '"' + (readOnly ? ' disabled' : '') + ' />';
  }
  return '<div class="fr-prop" style="flex-direction:column;align-items:stretch"><label for="p_' + key + '">' + esc(humanize(key)) + '</label>' + widget + '</div>';
}

function bindInspector() {
  const index = selected;
  const inputs = $('#inspector').querySelectorAll('input, textarea');
  inputs.forEach(input => {
    const key = input.id.startsWith('p_') ? input.id.slice(2) : undefined;
    if (!key) { return; }
    const handler = () => {
      let value;
      if (input.type === 'checkbox') { value = input.checked ? 1 : 0; }
      else if (String(input.value) === '' ) { value = null; }
      else { value = input.value; }
      setProp(index, key, value);
    };
    input.addEventListener('change', handler);
    if (input.type !== 'checkbox') { input.addEventListener('input', handler); }
  });
}

function humanize(key) {
  return key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// ===== metadata =====
function paintMeta() {
  const box = $('#metaeditor');
  const html = [];
  for (const [key, label, kind] of META_FIELDS) {
    if (kind === 'check') {
      html.push('<div class="fr-prop"><label for="m_' + key + '">' + esc(label) + '</label><input id="m_' + key + '" type="checkbox" ' + (meta[key] ? 'checked' : '') + (readOnly ? ' disabled' : '') + ' /></div>');
    } else {
      html.push('<div class="fr-prop"><label for="m_' + key + '">' + esc(label) + '</label><input id="m_' + key + '" type="text" value="' + esc(meta[key]) + '"' + (readOnly ? ' disabled' : '') + ' /></div>');
    }
  }
  box.innerHTML = html.join('');
  for (const [key, label, kind] of META_FIELDS) {
    const input = $('#m_' + key);
    if (!input) { continue; }
    input.addEventListener('change', () => {
      if (readOnly) { return; }
      snapshot();
      if (kind === 'check') { meta[key] = input.checked ? 1 : 0; }
      else if (input.value === '') { delete meta[key]; }
      else { meta[key] = input.value; }
      dirty = true;
    });
  }
}

// ===== json =====
function currentDoc() {
  const doc = { ...meta };
  doc.fields = fields.map(f => {
    const copy = { ...f };
    return copy;
  });
  doc.field_order = fields.filter(f => f.fieldname).map(f => f.fieldname);
  return doc;
}

let jsonVisible = false;
function paintJson() { $('#jsontext').value = JSON.stringify(currentDoc(), null, 2); }

function applyJson() {
  let candidate;
  try { candidate = JSON.parse($('#jsontext').value); }
  catch (e) { jsonStatus(false, 'Invalid JSON: ' + e.message); return; }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { jsonStatus(false, 'JSON must be an object.'); return; }
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) { jsonStatus(false, 'DocType needs a name.'); return; }
  const list = Array.isArray(candidate.fields) ? candidate.fields : [];
  const names = list.filter(f => f && typeof f.fieldname === 'string').map(f => f.fieldname);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) { jsonStatus(false, 'Duplicate fieldname: ' + dup); return; }
  for (const f of list) {
    if (f && !BREAKS.has(f.fieldtype) && !f.fieldname) { jsonStatus(false, 'Field "' + (f.label || f.fieldtype) + '" is missing a fieldname.'); return; }
    if (f && ['Table', 'Table MultiSelect'].includes(f.fieldtype) && !String(f.options || '').trim()) {
      jsonStatus(false, (f.fieldname || 'A table field') + ' needs a child DocType in options.'); return;
    }
  }
  snapshot();
  applyParsed(candidate);
  jsonStatus(true, 'Applied ' + fields.length + ' fields.');
}

function applyParsed(candidate) {
  meta = {};
  for (const key of Object.keys(candidate)) { if (key !== 'fields') { meta[key] = candidate[key]; } }
  fields = (Array.isArray(candidate.fields) ? candidate.fields : []).map(f => ({ ...f }));
  selected = -1;
  dirty = true;
  renderAll();
}

function jsonStatus(good, message) {
  const el = $('#jsonstatus');
  el.className = good ? 'fr-ok' : 'fr-bad';
  el.textContent = message;
}

// ===== save =====
function validateLocally() {
  const problems = [];
  const seen = new Set();
  for (const f of fields) {
    if (!f.fieldtype) { problems.push('A field has no fieldtype.'); continue; }
    if (!isBreak(f.fieldtype)) {
      if (!f.fieldname) { problems.push((f.label || f.fieldtype) + ' is missing a fieldname.'); }
      else if (seen.has(f.fieldname)) { problems.push('Duplicate fieldname: ' + f.fieldname); }
      else { seen.add(f.fieldname); }
      if (f.reqd && ['Check'].includes(f.fieldtype)) { /* allowed */ }
      if ((f.fieldtype === 'Table' || f.fieldtype === 'Table MultiSelect') && !String(f.options || '').trim()) {
        problems.push((f.fieldname || 'Field') + ' (' + f.fieldtype + ') needs a child DocType.');
      }
      if ((f.fieldtype === 'Link' || f.fieldtype === 'Dynamic Link') && !String(f.options || '').trim()) {
        problems.push((f.fieldname || 'Field') + ' (' + f.fieldtype + ') needs a target DocType.');
      }
    }
  }
  if (!String(meta.name || '').trim()) { problems.push('DocType name is required.'); }
  return problems;
}

function requestSave() {
  const problems = validateLocally();
  if (problems.length) {
    saveStatus(false, problems.join('  '));
    return;
  }
  saveStatus(true, 'Saving\u2026');
  vscode.postMessage({ type: 'save', rawJson: currentDoc() });
}

function saveStatus(good, message) {
  const el = $('#savestatus');
  el.className = good ? 'fr-ok' : 'fr-bad';
  el.textContent = message;
}

window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 's') {
    event.preventDefault();
    requestSave();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
    event.preventDefault();
    if (event.shiftKey) { redo(); } else { undo(); }
  }
});

window.addEventListener('message', event => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init': {
      rawInit(msg);
      break;
    }
    case 'saveResult': {
      saveStatus(!!msg.ok, msg.message || '');
      if (msg.ok) { dirty = false; $('#dirtybadge').hidden = true; }
      break;
    }
    case 'notice': {
      saveStatus(msg.level !== 'error', msg.message);
      break;
    }
  }
});

function rawInit(msg) {
  doctypeName = msg.doctypeName;
  readOnly = !!msg.readOnly;
  meta = {};
  for (const key of Object.keys(msg.rawJson)) { if (key !== 'fields') { meta[key] = msg.rawJson[key]; } }
  fields = (Array.isArray(msg.rawJson.fields) ? msg.rawJson.fields : []).map(f => ({ ...f }));
  selected = -1;
  undoStack.length = 0;
  redoStack.length = 0;
  dirty = false;
  $('#namefield').value = String(meta.name || '');
  $('#namefield').disabled = !!(doctypeName || readOnly);
  $('#deletebtn').hidden = !(Number(meta.custom) === 1 && doctypeName) || readOnly;
  $('#savebtn').disabled = !!readOnly;
  renderAll();
  $('#savestatus').textContent = '';
  $('#savestatus').className = '';
}

function renderAll() {
  $('#dirtybadge').hidden = !dirty;
  paintPalette();
  paintCanvas();
  paintInspector();
  paintMeta();
  if (jsonVisible) { paintJson(); }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#savebtn').addEventListener('click', requestSave);
  $('#reloadbtn').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  $('#deletebtn').addEventListener('click', () => {
    if (doctypeName && window.confirm('Delete this-custom DocType from the site? This cannot be undone from the IDE.')) {
      vscode.postMessage({ type: 'delete' });
    }
  });
  $('#jsontoggle').addEventListener('click', () => {
    jsonVisible = !jsonVisible;
    $('#jsonpanel').classList.toggle('visible', jsonVisible);
    if (jsonVisible) { paintJson(); }
  });
  $('#jsonapply').addEventListener('click', applyJson);
  $('#jsonclose').addEventListener('click', () => { jsonVisible = false; $('#jsonpanel').classList.remove('visible'); });
  vscode.postMessage({ type: 'ready' });
});
`;

const BODY = `
<div class="fr-toolbar">
  <span style="font-weight:600">DocType Studio</span>
  <input id="namefield" type="text" placeholder="DocType name" style="max-width:220px" />
  <button id="savebtn">Save</button>
  <button id="reloadbtn">Reload</button>
  <button id="deletebtn" hidden>Delete</button>
  <button id="jsontoggle">JSON</button>
  <span id="dirtybadge" class="meta-chip" hidden>&#9679; changed</span>
  <span id="savestatus" class="meta-chip"></span>
</div>
<div class="fr-body">
  <aside class="fr-palette" id="palette"></aside>
  <main class="fr-canvas" id="canvas"></main>
  <aside class="fr-inspector">
    <div id="inspector"></div>
    <details open id="metadetails"><summary style="cursor:pointer;margin:10px 0 4px">DocType Metadata</summary><div id="metaeditor"></div></details>
  </aside>
</div>
<div class="fr-json" id="jsonpanel">
  <div class="fr-toolbar">
    <button id="jsonapply">Apply</button>
    <button id="jsonclose">Close</button>
    <span id="jsonstatus" class="meta-chip"></span>
  </div>
  <textarea id="jsontext" spellcheck="false" wrap="off"></textarea>
</div>
`;

/** Builds the complete DocType Studio html document with a fresh CSP nonce. */
export function buildDoctypeEditorDocument(): string {
	const script = SCRIPT
		.replace('const FRAPPE_FIELDTYPES = /^/;', '')
		.replace('AS_JSON_INSPECTOR_GROUPS', JSON.stringify(INSPECTOR_GROUPS))
		.replace('AS_JSON_META_FIELDS', JSON.stringify(META_FIELDS))
		.replace('AS_JSON_PALETTE', JSON.stringify(PALETTE));
	return buildFrappeDocument({
		nonce: newFrappeNonce(),
		styles: STYLES,
		body: BODY,
		scripts: script
	});
}
