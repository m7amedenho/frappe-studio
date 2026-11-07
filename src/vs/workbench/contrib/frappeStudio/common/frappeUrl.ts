/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers to normalize and validate a Frappe site URL before any network activity happens.
 * Keeping this logic pure makes it testable without a network stack.
 */

export interface NormalizedSiteUrl {
	/** Scheme-normalized origin URL, without a trailing slash. e.g. https://erp.example.com */
	readonly origin: string;
	readonly scheme: 'http' | 'https';
	readonly host: string;
	readonly port: number;
	readonly pathname: string;
}

export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;

const DEFAULT_PORTS: Record<'http' | 'https', number> = {
	http: DEFAULT_HTTP_PORT,
	https: DEFAULT_HTTPS_PORT
};

export class SiteUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SiteUrlError';
	}
}

/**
 * Normalizes a user-provided Frappe site URL.
 *
 * - Accepts `erp.example.com`, `http://frappe.local`, `https://erp.example.com:8443/blog`, ...
 * - Defaults to https unless the user typed a local origin.
 * - Local origins (`localhost`, `127.0.0.1`, `*.local`, plain host names, private IPs) keep `http`
 *   by default so a fresh `bench start` URL can be typed without a scheme.
 * - Trailing slashes, stray whitespace, and implicit ports are normalized away.
 */
export function normalizeSiteUrl(input: string): NormalizedSiteUrl {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new SiteUrlError('Enter a URL.');
	}
	if (/[<>"'\\\s]/.test(trimmed) && !/^https?:\/\//.test(trimmed)) {
		// characters that look like an attack or a mistake, unless the URL itself says otherwise
		throw new SiteUrlError('Enter a valid URL.');
	}
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${defaultSchemeFor(trimmed)}://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new SiteUrlError('Enter a valid URL.');
	}
	if (url.username || url.password) {
		throw new SiteUrlError('Userinfo in the URL is not supported.');
	}
	if (url.search || url.hash) {
		throw new SiteUrlError('Query strings and fragments are not supported.');
	}
	if (url.pathname.length > 1) {
		throw new SiteUrlError('Paths in the URL are not supported.');
	}
	if (url.port && !/^\d{1,5}$/.test(url.port)) {
		throw new SiteUrlError('Enter a valid port.');
	}
	const scheme: 'http' | 'https' = url.protocol === 'https:' ? 'https' : 'http';
	const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];
	if (port < 1 || port > 65535) {
		throw new SiteUrlError('Enter a valid port.');
	}
	const path = url.pathname.replace(/\/+$/, '') || '';
	const portSuffix = port === DEFAULT_PORTS[scheme] ? '' : `:${port}`;
	const origin = `${scheme}://${url.hostname.toLowerCase()}${portSuffix}`;
	return { origin, scheme, host: url.hostname.toLowerCase(), port, pathname: path };
}

/**
 * Sites likely addressed over plain HTTP (development style origins) keep http by default;
 * anything else defaults to https. This only applies when the user did not type a scheme.
 */
function defaultSchemeFor(raw: string): 'http' | 'https' {
	const host = raw.split('/')[0].split(':')[0].toLowerCase();
	if (/^(localhost|127\.|10\.|0\.0\.0\.0$|\[::1\]|::1$|host\.localhost)/.test(host)) {
		return 'http';
	}
	if (/\.local$/.test(host)) {
		return 'http';
	}
	if (!/\./.test(host)) {
		// plain host names reachable on a LAN, e.g. `mybench:8000`
		return 'http';
	}
	return 'https';
}
