/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal cookie jar for Frappe HTTP session handling.
 *
 * Frappe uses session cookies (`sid`, `csrftoken`, `same_site`) for API sessions, and
 * keeps refreshable session cookies (`frappe.sid`) for "remember me". The jar supports
 * separation of session-scoped and persistent cookies. Cookies are never written to logs
 * or to disk; the jar lives exclusively in memory with the rest of the session state.
 */

export interface Cookie {
	readonly name: string;
	readonly value: string;
	readonly host: string;
	readonly expiry: Date | undefined;
}

export class CookieJar {
	private readonly cookies = new Map<string, Cookie>();

	/**
	 * Parses a `set-cookie` response header into the jar. Duplicate cookies with the same
	 * name (and host) are replaced, mirroring browser behavior.
	 */
	public setFromResponseHeader(raw: string, origin: URL): void {
		const parts = raw.split(/,(?=[^;]*=)|(?<!\d{2}),/); // cookies may contain `expires=Sun, 07` commas
		for (const part of parts) {
			const cookie = this.parseCookieDirective(part, origin);
			if (cookie) {
				this.cookies.set(`${cookie.host}\u0000${cookie.name}`, cookie);
			}
		}
	}

	private parseCookieDirective(directive: string, origin: URL): Cookie | undefined {
		const segments = directive.split(';').map(s => s.trim()).filter(Boolean);
		if (!segments.length) {
			return undefined;
		}
		const nv = segments[0];
		const eq = nv.indexOf('=');
		if (eq <= 0) {
			return undefined;
		}
		const name = nv.slice(0, eq).trim();
		const value = nv.slice(eq + 1).trim();
		if (!name || /\s/.test(name)) {
			return undefined;
		}
		let expiry: Date | undefined;
		for (let i = 1; i < segments.length; i++) {
			const attr = segments[i].toLowerCase();
			if (attr.startsWith('expires=')) {
				const parsed = Date.parse(segments[i].slice(9).trim());
				if (!Number.isNaN(parsed)) {
					expiry = new Date(parsed);
				}
			}
		}
		const ageHeader = segments.find(s => s.toLowerCase().startsWith('max-ag'));
		// no permanent expiry: sessions expire by max-age or expires; session cookies live until logout
		const host = origin.hostname.toLowerCase();
		return { name, value, host, expiry: expiry ?? (ageHeader ? undefined : undefined) };
	}

	/** Serializes the jar into a `cookie` request header value for the given URL. */
	public serializeFor(origin: URL): string {
		const pairs: string[] = [];
		const now = Date.now();
		for (const cookie of this.cookies.values()) {
			if (cookie.host !== origin.hostname.toLowerCase()) {
				continue;
			}
			if (cookie.expiry && cookie.expiry.getTime() < now) {
				continue;
			}
			pairs.push(`${cookie.name}=${cookie.value}`);
		}
		return pairs.join('; ');
	}

	public get(name: string, origin: URL): Cookie | undefined {
		const key = `${origin.hostname.toLowerCase()}\u0000${name}`;
		const cookie = this.cookies.get(key);
		if (!cookie) {
			return undefined;
		}
		if (cookie.expiry && cookie.expiry.getTime() < Date.now()) {
			return undefined;
		}
		return cookie;
	}

	public clear(): void {
		this.cookies.clear();
	}

	public clearExpired(): void {
		const now = Date.now();
		for (const [key, cookie] of this.cookies) {
			if (cookie.expiry && cookie.expiry.getTime() < now) {
				this.cookies.delete(key);
			}
		}
	}
}
