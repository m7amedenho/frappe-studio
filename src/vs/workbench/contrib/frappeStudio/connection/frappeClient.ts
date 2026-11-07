/*--------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FrappeMethodResult } from '../common/frappeTypes.js';
import { buildCapabilities, CAPABILITY_PROBES, connectionPath, FrappeCapability, IFrappeCapabilities, parseMajorVersion } from '../common/frappeCapabilities.js';
import { NormalizedSiteUrl } from '../common/frappeUrl.js';
import { CookieJar } from './cookieJar.js';

export class SiteUnreachableError extends Error {
	readonly code = 'site_unreachable';
	constructor(origin: string, detail: string) {
		super(`Could not reach ${origin}: ${detail}`);
		this.name = 'SiteUnreachableError';
	}
}

export class FrappeHttpError extends Error {
	constructor(readonly status: number, readonly bodyText: string, readonly url: string) {
		super(`Frappe request failed (HTTP ${status})`);
		this.name = 'FrappeHttpError';
	}
}

export class FrappeSessionExpiredError extends Error {
	constructor() {
		super('Frappe session expired. Re-authenticate to continue.');
		this.name = 'FrappeSessionExpiredError';
	}
}

export class FrappeMethodMissingError extends Error {
	constructor(readonly qualifiedName: string) {
		super(`Method ${qualifiedName} is not available on this site.`);
		this.name = 'FrappeMethodMissingError';
	}
}

export class FrappeAuthenticationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FrappeAuthenticationError';
	}
}

interface RequestResult {
	status: number | undefined;
	setCookieHeaders: readonly string[];
	body: string;
	contentType: string | undefined;
}

export interface IFrappeClient {
	/** The normalized origin the client talks to. */
	readonly origin: string;
	readonly site: NormalizedSiteUrl;
	/** The cookies currently kept for the session. Never logged. */
	readonly cookieJar: CookieJar;

	login(username: string, password: string, token: CancellationToken): Promise<SessionInfo>;
	logout(token: CancellationToken): Promise<void>;
	getLoggedUser(token: CancellationToken): Promise<string>;
	probeCapabilities(token: CancellationToken): Promise<IFrappeCapabilities>;
	getVersions(token: CancellationToken): Promise<GetVersionsResult>;
	isSessionValid(token: CancellationToken): Promise<boolean>;

	callMethod<T>(qualifiedName: string, method: 'GET' | 'POST', params: Record<string, string> | undefined, jsonBody: unknown | undefined, token: CancellationToken): Promise<FrappeMethodResult<T>>;
	getResource<T>(doctype: string, token: CancellationToken, params?: Record<string, string>): Promise<T[]>;
	requestHtml(path: string, token: CancellationToken): Promise<string>;
}

export interface SessionInfo {
	readonly user: string;
	readonly fullName: string | undefined;
	readonly homePage: string | undefined;
}

export interface GetVersionsResult {
	readonly frappe: string | undefined;
	readonly apps: readonly { name: string; version: string | undefined }[];
}

const csrfTokenCookieName = 'csrf_token';
const sessionCookieName = 'sid';

const jsonSafe = (text: string): unknown | undefined => {
	try {
		return JSON.parse(text);
	} catch {
		// A non-JSON payload is usually the site's login page or an HTML error.
		return undefined;
	}
};

/**
 * HTTP session client against a single Frappe site. Secures:
 * - session cookie handling over the platform's request infrastructure,
 * - CSRF tokens for all mutating requests, refreshed on demand,
 * - timeouts and structured error identities.
 * Passwords are only ever kept in transport form for the login POST; they are never logged.
 */
export class FrappeClient implements IFrappeClient {

	readonly cookieJar = new CookieJar();
	private readonly _unreachableEmitter = new Emitter<string>();
	readonly onDidSessionExpire = this._unreachableEmitter.event;

	constructor(
		readonly site: NormalizedSiteUrl,
		private readonly requestService: IRequestService,
		private readonly logService: ILogService
	) { }

	get origin(): string {
		return this.site.origin;
	}

	/** Performs one HTTP call with cookie attachment; returns parsed result. */
	private async doRequest(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		absoluteUrl: string,
		requestOptions: {
			form?: URLSearchParams;
			json?: unknown;
			extraHeaders?: Record<string, string>;
		},
		token: CancellationToken
	): Promise<RequestResult> {
		const originUrl = new URL(this.site.origin);
		const headers: Record<string, string> = { Accept: 'application/json, text/html;q=0.9', ...(requestOptions.extraHeaders ?? {}) };
		if (requestOptions.json !== undefined && requestOptions.form === undefined) {
			headers['Content-Type'] = 'application/json';
		}
		if (method !== 'GET' && headers['Content-Type'] === undefined && requestOptions.form !== undefined) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
		}
		const cookieHeader = this.cookieJar.serializeFor(originUrl);
		if (cookieHeader) {
			headers['Cookie'] = cookieHeader;
		}
		if (method !== 'GET') {
			const csrf = this.cookieJar.get(csrfTokenCookieName, originUrl)?.value ?? await this.fetchCsrfToken(token).catch(() => undefined);
			if (csrf) {
				headers['X-Frappe-CSRF-Token'] = csrf;
			}
		}
		const body = requestOptions.form ? requestOptions.form.toString() : requestOptions.json !== undefined ? JSON.stringify(requestOptions.json) : undefined;
		try {
			const context = await this.requestService.request({
				type: method,
				url: absoluteUrl,
				headers,
				data: body,
				timeout: 30_000,
				followRedirects: 5,
				callSite: 'FrappeStudio'
			}, token);
			const buffer = await streamToBuffer(context.stream);
			const entries = Object.entries(context.res.headers);
			const setCookies = entries
				.filter(([h]) => h.toLowerCase() === 'set-cookie')
				.flatMap(([, v]) => Array.isArray(v) ? v : [v])
				.filter((value): value is string => typeof value === 'string');
			for (const raw of setCookies) {
				this.cookieJar.setFromResponseHeader(raw, originUrl);
			}
			this.cookieJar.clearExpired();
			return {
				status: context.res.statusCode,
				setCookieHeaders: setCookies,
				body: buffer.toString(),
				contentType: (context.res.headers['content-type'] ?? context.res.headers['Content-Type']) as string | undefined
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._unreachableEmitter.fire(absoluteUrl);
			if (error instanceof Error && typeof (error as unknown as { readonly code?: string }).code === 'string') {
				throw new SiteUnreachableError(this.site.origin, (error as unknown as { readonly code: string }).code);
			}
			throw new SiteUnreachableError(this.site.origin, message);
		}
	}

	private async fetchCsrfToken(token: CancellationToken): Promise<string | undefined> {
		const result = await this.doRequest('GET', connectionPath(this.site, 'frappe.auth.get_csrf_token'), {}, token);
		if (result.status === 200) {
			const fromCookie = this.cookieJar.get(csrfTokenCookieName, new URL(this.site.origin))?.value;
			if (fromCookie) {
				return fromCookie;
			}
			const payload = jsonSafe(result.body);
			const message = payload && typeof payload === 'object' ? (payload as { message?: string }).message : undefined;
			if (typeof message === 'string') {
				return message;
			}
		}
		return undefined;
	}

	async login(username: string, password: string, token: CancellationToken): Promise<SessionInfo> {
		const form = new URLSearchParams();
		form.set('usr', username);
		form.set('pwd', password);
		const result = await this.doRequest('POST', connectionPath(this.site, 'login'), { form }, token);
		const payload = jsonSafe(result.body);
		if (result.status !== 200) {
			const message = payload && typeof payload === 'object' ? (payload as { exc_type?: string; _server_messages?: unknown })._server_messages : payload;
			const friendly = typeof message === 'string' && message.includes('Auth') ? 'Incorrect username or password.' : 'Login was rejected by the site.';
			throw new FrappeAuthenticationError(friendly);
		}
		if (payload && typeof payload === 'object' && (payload as { message?: unknown }).message === 'Logged In') {
			const user = await this.getLoggedUser(token);
			return { user, fullName: undefined, homePage: undefined };
		}
		throw new FrappeAuthenticationError('The site accepted the request but did not return a session.');
	}

	async getLoggedUser(token: CancellationToken): Promise<string> {
		const result = await this.doRequest('GET', connectionPath(this.site, 'frappe.auth.get_logged_user'), {}, token);
		if (result.status === 200) {
			const user = typedGetLoggedUser(jsonSafe(result.body));
			if (typeof user === 'string') {
				return user;
			}
		}
		if (result.status === 401 || result.status === 403) {
			this.cookieJar.clear();
			throw new FrappeSessionExpiredError();
		}
		throw new FrappeHttpError(result.status ?? 0, result.body, 'frappe.auth.get_logged_user');
	}

	async isSessionValid(token: CancellationToken): Promise<boolean> {
		try {
			const user = await this.getLoggedUser(token);
			return Boolean(user) && user !== 'Guest';
		} catch {
			return false;
		}
	}

	async logout(token: CancellationToken): Promise<void> {
		if (!this.cookieJar.get(sessionCookieName, new URL(this.site.origin))) {
			return;
		}
		await this.doRequest('POST', connectionPath(this.site, 'logout'), { form: new URLSearchParams() }, token);
		this.cookieJar.clear();
	}

	async callMethod<T>(qualifiedName: string, method: 'GET' | 'POST', params: Record<string, string> | undefined, jsonBody: unknown | undefined, token: CancellationToken): Promise<FrappeMethodResult<T>> {
		const joined = params ? new URLSearchParams(params).toString() : '';
		const url = `${connectionPath(this.site, qualifiedName)}${joined ? `?${joined}` : ''}`;
		const result = await this.doRequest(method, url, { form: method === 'POST' ? params ? new URLSearchParams(params) : undefined : undefined, json: method === 'POST' ? jsonBody : undefined }, token);
		return this.interpretJson(result, qualifiedName);
	}

	async getResource<T>(doctype: string, token: CancellationToken, params?: Record<string, string>): Promise<T[]> {
		const cleaned = doctype.replace(/\s+/g, '%20') + (params ? `?${new URLSearchParams(params).toString()}` : '');
		const url = `${this.site.origin}/api/resource/${cleaned}`;
		const result = await this.doRequest('GET', url, {}, token);
		const payload = jsonSafe(result.body);
		if (result.status === 200) {
			if (Array.isArray(payload)) {
				return payload as T[];
			}
			const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined;
			if (Array.isArray(data)) {
				return data as T[];
			}
		}
		return this.interpretJson<T[]>(result, doctype).message;
	}

	async requestHtml(path: string, token: CancellationToken): Promise<string> {
		const url = `${this.site.origin}${path.startsWith('/') ? '' : '/'}${path}`;
		const result = await this.doRequest('GET', url, { extraHeaders: { Accept: 'text/html' } }, token);
		if (result.status === 401 || result.status === 403) {
			throw new FrappeSessionExpiredError();
		}
		if (result.status !== 200) {
			throw new FrappeHttpError(result.status ?? 0, result.body, path);
		}
		return result.body;
	}

	private interpretJson<T>(result: RequestResult, context: string): FrappeMethodResult<T> {
		const status = result.status ?? 0;
		const payload = jsonSafe(result.body);
		const contentType = result.contentType ?? '';
		if (!contentType.includes('application/json') && !payload) {
			if (status === 200 && result.body.startsWith('<')) {
				throw new FrappeSessionExpiredError();
			}
		}
		const frappeError = interpretFrappeErrorBody(payload);
		if (status >= 400) {
			if (status === 401 || (status === 403 && /session expired/i.test(frappeError.message))) {
				this.cookieJar.clear();
				throw new FrappeSessionExpiredError();
			}
			if (status === 403) {
				throw new FrappeHttpError(status, frappeError.message, context);
			}
			if (status === 404) {
				throw new FrappeMethodMissingError(context);
			}
			throw new FrappeHttpError(status, frappeError.message, context);
		}
		if (status >= 500) {
			throw new FrappeHttpError(status, frappeError.message, context);
		}
		if (status >= 300 && !payload) {
			throw new FrappeHttpError(status, frappeError.message, context);
		}
		return { message: ((payload as { message?: T }).message !== undefined ? (payload as { message?: T }).message : payload) as T };
	}

	async probeCapabilities(token: CancellationToken): Promise<IFrappeCapabilities> {
		const statuses = new Map<FrappeCapability, number | undefined>();
		for (const probe of CAPABILITY_PROBES) {
			if (token.isCancellationRequested) {
				break;
			}
			try {
				let status: number;
				if (probe.method === 'GET') {
					status = await this.probeGet(probe.endpoint, token);
				} else {
					status = await this.probePost(probe.endpoint, probe.body!, token);
				}
				statuses.set(probe.capability, status);
			} catch (error) {
				this.logService.debug('[Frappe Studio] capability probe failed', error instanceof Error ? error.name : 'error');
				statuses.set(probe.capability, undefined);
			}
		}
		return buildCapabilities(statuses);
	}

	private async probeGet(endpoint: string, token: CancellationToken): Promise<number> {
		const result = await this.doRequest('GET', connectionPath(this.site, endpoint), {}, token);
		return result.status ?? 0;
	}

	private async probePost(endpoint: string, body: string, token: CancellationToken): Promise<number> {
		const result = await this.doRequest('POST', connectionPath(this.site, endpoint), { form: new URLSearchParams(body), extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' } }, token);
		return result.status ?? 0;
	}

	async getVersions(token: CancellationToken): Promise<GetVersionsResult> {
		try {
			const result = await this.doRequest('GET', connectionPath(this.site, 'frappe.get_versions'), {}, token);
			const payload = jsonSafe(result.body);
			const message = payload && typeof payload === 'object' && (payload as Record<string, unknown>).message;
			const appsRecord = message && typeof message === 'object' ? message as Record<string, { version?: string; branch_version?: string; framework_version?: string }> : undefined;
			const apps: { name: string; version: string | undefined }[] = appsRecord
				? Object.entries(appsRecord).map(([name, info]) => ({
					name,
					version: info?.version ?? info?.branch_version ?? info?.framework_version
				}))
				: [];
			const frappeEntry = apps.find(a => a.name.toLowerCase() === 'frappe' || a.name.toLowerCase() === 'frappe framework');
			return { frappe: frappeEntry?.version ?? appsRecord ? undefined : undefined, apps };
		} catch {
			return { frappe: undefined, apps: [] };
		}
	}
}

function typedGetLoggedUser(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const user = (payload as { message?: unknown }).message;
	if (typeof user === 'string') {
		return user;
	}
	if (user && typeof user === 'object' && typeof (user as { full_name?: unknown }).full_name === 'string') {
		return (user as { full_name: string }).full_name;
	}
	if (typeof (payload as { user?: unknown }).user === 'string') {
		return (payload as { user: string }).user;
	}
	return undefined;
}

interface FrappeErrorBody {
	readonly message: string;
	readonly excType: string | undefined;
}

function interpretFrappeErrorBody(payload: unknown): FrappeErrorBody {
	if (!payload) {
		return { message: 'Request rejected by the site.', excType: undefined };
	}
	const root = payload as Record<string, unknown>;
	const excType = typeof root.exc_type === 'string' ? root.exc_type : undefined;
	const messages = root._server_messages;
	if (typeof messages === 'string') {
		try {
			const parsed = JSON.parse(messages) as unknown;
			const arr = Array.isArray(parsed) ? parsed : [];
			const first = arr[0];
			const text = first && typeof first === 'object' ? String((first as { message?: unknown }).message ?? '') : '';
			if (text) {
				return { message: text, excType };
			}
		} catch { /* fall through */ }
	}
	if (typeof root.exc === 'string') {
		const lines = root.exc.split('\n');
		return { message: lines[lines.length - 4] ?? lines[0] ?? 'Request rejected by the site.', excType };
	}
	if (typeof root.message === 'string') {
		return { message: root.message, excType };
	}
	return { message: 'Request rejected by the site.', excType };
}

export function clientMajorVersion(client: IFrappeClient, versions: GetVersionsResult): number | undefined {
	const version = versions.frappe && parseMajorVersion(versions.frappe) !== undefined ? versions.frappe : undefined;
	if (version) {
		return parseMajorVersion(version);
	}
	return undefined;
}
