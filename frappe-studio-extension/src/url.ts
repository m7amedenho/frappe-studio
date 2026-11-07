/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function normalizeSiteUrl(input: string): { origin: string } {
	const raw = input.trim();
	if (!raw) { throw new Error('Enter a site URL.'); }
	const local = /^(localhost|127\.0\.0\.1|\[::1\]|[^./:]+)(:\d+)?\/?$/i.test(raw);
	const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `${local ? 'http' : 'https'}://${raw}`);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw new Error('Enter a site origin without credentials, path, query, or fragment.');
	}
	return { origin: url.origin };
}
