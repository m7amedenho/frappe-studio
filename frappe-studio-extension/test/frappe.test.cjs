/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSiteUrl } = require('../out/url.js');
const { FrappeClient } = require('../out/frappe.js');

test('site URL normalization rejects credentials, paths, and schemes other than HTTP', () => {
	assert.equal(normalizeSiteUrl('localhost:8000').origin, 'http://localhost:8000');
	assert.equal(normalizeSiteUrl('erp.example.com').origin, 'https://erp.example.com');
	for (const value of ['https://user:pass@example.com', 'https://example.com/subpath', 'file:///tmp/x']) {
		assert.throws(() => normalizeSiteUrl(value));
	}
});

test('client keeps session cookie on the connected site', async () => {
	const oldFetch = global.fetch;
	const calls = [];
	global.fetch = async (url, options) => {
		calls.push({ url: String(url), options });
		if (String(url).endsWith('/api/method/login')) {
			return new Response(JSON.stringify({ message: 'Logged In' }), { headers: { 'set-cookie': 'sid=test-session; HttpOnly' } });
		}
		if (String(url).endsWith('/api/method/frappe.auth.get_logged_user')) {
			return Response.json({ message: 'Administrator' });
		}
		return Response.json({ message: [{ name: 'Example' }] });
	};
	try {
		const client = new FrappeClient('https://frappe.example', 'Administrator');
		assert.equal(await client.login('secret'), 'Administrator');
		assert.deepEqual(await client.list('DocType'), [{ name: 'Example' }]);
		assert.equal(calls[1].options.headers.Cookie, 'sid=test-session');
		assert.equal(calls[2].url, 'https://frappe.example/api/method/frappe.auth.get_csrf_token');
		assert.equal(calls[3].options.headers.Cookie, 'sid=test-session');
		assert.equal(calls[3].options.headers['X-Frappe-CSRF-Token'], undefined);
	} finally {
		global.fetch = oldFetch;
	}
});

test('API explorer rejects paths outside Frappe API before making a request', async () => {
	const client = new FrappeClient('https://frappe.example', 'Administrator');
	await assert.rejects(client.apiRequest('//attacker.example/api/method/test', 'GET'));
	await assert.rejects(client.apiRequest('/private', 'GET'));
});
