/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { normalizeSiteUrl } from './url';

export type DocumentKind = 'DocType' | 'Workflow' | 'Report' | 'Print Format';
export type FrappeDocument = Record<string, unknown>;

export class FrappeError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

export class FrappeClient {
	readonly origin: string;
	private readonly cookies = new Map<string, string>();
	private csrfToken: string | undefined;
	readonly username: string;

	constructor(site: string, username: string) {
		this.origin = normalizeSiteUrl(site).origin;
		this.username = username;
	}

	private async request<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: URLSearchParams | FrappeDocument): Promise<T> {
		if (!path.startsWith('/') || path.startsWith('//')) {
			throw new FrappeError('Request path must be relative to the connected site.');
		}
		const url = new URL(path, this.origin);
		if (url.origin !== this.origin) {
			throw new FrappeError('Request cannot leave the connected site.');
		}
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (this.cookies.size) {
			headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
		}
		if (method !== 'GET' && path !== '/api/method/login' && !this.csrfToken) {
			try {
				const token = await this.request<{ message?: string }>('/api/method/frappe.auth.get_csrf_token');
				if (typeof token.message === 'string') { this.csrfToken = token.message; }
			} catch { /* Older Frappe versions may rely on the session cookie alone. */ }
		}
		if (method !== 'GET' && this.csrfToken) {
			headers['X-Frappe-CSRF-Token'] = this.csrfToken;
		}
		if (body) {
			headers['Content-Type'] = body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json';
		}
		let response: Response;
		try {
			response = await fetch(url, {
				method, headers, body: body instanceof URLSearchParams ? body.toString() : body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(30000), redirect: 'manual'
			});
		} catch (error) {
			throw new FrappeError(`Cannot reach ${this.origin}: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(';', 1)[0];
			const index = pair.indexOf('=');
			if (index > 0) {
				const name = pair.slice(0, index);
				const value = pair.slice(index + 1);
				if (/^[\w-]+$/.test(name) && !/[\r\n;]/.test(value)) {
					if (value) { this.cookies.set(name, value); } else { this.cookies.delete(name); }
					if (name === 'csrf_token') { this.csrfToken = decodeURIComponent(value); }
				}
			}
		}
		const text = await response.text();
		let payload: Record<string, unknown>;
		try { payload = JSON.parse(text) as Record<string, unknown>; }
		catch { throw new FrappeError(`Site returned a non-JSON response (HTTP ${response.status}).`, response.status); }
		if (!response.ok || payload.exc || payload.exception) {
			const message = typeof payload._server_messages === 'string' ? 'Frappe rejected the request.' : String(payload.message ?? payload.exception ?? `HTTP ${response.status}`);
			throw new FrappeError(message, response.status);
		}
		return payload as T;
	}

	async login(password: string): Promise<string> {
		const reply = await this.request<{ message?: string; home_page?: string }>('/api/method/login', 'POST', new URLSearchParams({ usr: this.username, pwd: password }));
		if (reply.message !== 'Logged In') { throw new FrappeError('Login was not accepted.'); }
		return this.loggedUser();
	}

	async loggedUser(): Promise<string> {
		const reply = await this.request<{ message: string }>('/api/method/frappe.auth.get_logged_user');
		if (!reply.message || reply.message === 'Guest') { throw new FrappeError('Session expired. Connect again.', 401); }
		return reply.message;
	}

	async logout(): Promise<void> {
		try { await this.request('/api/method/logout'); } finally { this.cookies.clear(); this.csrfToken = undefined; }
	}

	async call<T>(method: string, params: Record<string, string> = {}, write = false): Promise<T> {
		if (!/^[a-zA-Z_][\w.]*$/.test(method)) { throw new FrappeError('Invalid method name.'); }
		const path = `/api/method/${method}`;
		const reply = write
			? await this.request<{ message: T }>(path, 'POST', new URLSearchParams(params))
			: await this.request<{ message: T }>(`${path}?${new URLSearchParams(params)}`);
		return reply.message;
	}

	async apiRequest(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: FrappeDocument): Promise<unknown> {
		if (!/^\/api\/(method|resource|v1|v2)\//.test(path)) {
			throw new FrappeError('Use a Frappe API path under /api/method/, /api/resource/, /api/v1/, or /api/v2/.');
		}
		return this.request<unknown>(path, method, body);
	}

	async list(doctype: string, fields: string[] = ['name']): Promise<FrappeDocument[]> {
		const all: FrappeDocument[] = [];
		for (let start = 0; ; start += 500) {
			const page = await this.call<FrappeDocument[]>('frappe.client.get_list', { doctype, fields: JSON.stringify(fields), limit_page_length: '500', limit_start: String(start), order_by: 'name asc' }, true);
			all.push(...page);
			if (page.length < 500) { return all; }
		}
	}

	async get(doctype: DocumentKind, name: string): Promise<FrappeDocument> {
		return this.call<FrappeDocument>('frappe.client.get', { doctype, name });
	}

	async save(document: FrappeDocument, create: boolean): Promise<FrappeDocument> {
		return this.call<FrappeDocument>(create ? 'frappe.client.insert' : 'frappe.client.update', { doc: JSON.stringify(document) }, true);
	}

	async version(): Promise<string> {
		try { return await this.call<string>('frappe.utils.change_log.get_versions'); }
		catch { return 'Unknown'; }
	}
}
