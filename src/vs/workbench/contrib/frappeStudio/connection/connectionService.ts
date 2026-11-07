/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Frappe Studio contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { DeveloperModeStatus, FrappeConnectionState, FrappeSiteIdentity } from '../common/frappeTypes.js';
import { IFrappeCapabilities } from '../common/frappeCapabilities.js';
import { normalizeSiteUrl, NormalizedSiteUrl, SiteUrlError } from '../common/frappeUrl.js';
import { FrappeClient, FrappeAuthenticationError, FrappeSessionExpiredError, GetVersionsResult, IFrappeClient } from './frappeClient.js';

export const ISiteConnectionService = createDecorator<ISiteConnectionService>('frappeStudioSiteConnectionService');

export interface IFrappeSiteConnection {
	/** Stable id, derived from the origin plus a disambiguator. */
	readonly id: string;
	readonly origin: string;
	/** Friendly label, defaults to the host name. */
	label: string;
	/** Last known username; secrets live in OS storage, never here. */
	username: string | undefined;
	readonly trusted: boolean;
	lastUsedAt: number;
}

export interface IActiveConnectionSession {
	readonly connection: IFrappeSiteConnection;
	readonly client: IFrappeClient;
	state: FrappeConnectionState;
	capabilities: IFrappeCapabilities | undefined;
	identity: FrappeSiteIdentity | undefined;
	versions: GetVersionsResult | undefined;
}

type ConnectionSecret = { username: string; password: string };

export interface ISiteConnectionService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeActiveConnection: Event<void>;
	readonly onDidChangeConnections: Event<void>;
	readonly onDidChangeSessionState: Event<readonly IActiveConnectionSession[]>;

	/** Every stored connection, regardless of session state. */
	getConnections(): readonly IFrappeSiteConnection[];
	getSession(connectionId: string): IActiveConnectionSession | undefined;
	getSessions(): readonly IActiveConnectionSession[];
	activeSessionId: string | undefined;
	setActiveSession(connectionId: string | undefined): void;

	/**
	 * Connects to a site: verifies it is a Frappe server, authenticates, verifies identity
	 * and probes capabilities + versions. Never logs or stores credentials in plain text.
	 */
	connect(url: string, username: string, password: string, options: ConnectOptions, token?: CancellationToken): Promise<IActiveConnectionSession>;

	/** Re-establishes the session for one connection using the stored secret, if any. */
	reconnect(connectionId: string, token?: CancellationToken): Promise<boolean>;

	disconnect(connectionId: string, closeServerSession: boolean): Promise<void>;

	/** Fully removes the stored connection and its OS-stored secret. */
	forget(connectionId: string): Promise<void>;

	developerModeStatus(sessionId: string): DeveloperModeStatus;
	/** Applies a verified Developer Mode change from the local Bench integration. */
	setDeveloperModeStatus(connectionId: string, status: DeveloperModeStatus): void;

	clientFor(connectionId: string): IFrappeClient | undefined;
	listCredentials(connectionId: string): Promise<ConnectionSecret | undefined>;
}

export interface ConnectOptions {
	/** Trust the site even when its certificate does not validate. */
	readonly ignoreTlsError?: boolean;
	/** Persist the password in OS storage to enable silent session restore. */
	readonly rememberPassword: boolean;
}

interface StoredConnections {
	connections: { id: string; origin: string; label: string; username: string | undefined; trusted: boolean; lastUsedAt: number }[];
	activeId: string | undefined;
}

const storageKey = 'frappe-studio.connections.v1';
const secretService = 'frappe-studio';

function nextFreeId(origin: string, taken: ReadonlySet<string>): string {
	if (!taken.has(origin)) {
		return origin;
	}
	let index = 2;
	while (taken.has(`${origin}#${index}`)) {
		index++;
	}
	return `${origin}#${index}`;
}

export class SiteConnectionService extends Disposable implements ISiteConnectionService {

	declare readonly _serviceBrand: undefined;

	private readonly _stored: StoredConnections;
	private readonly _sessions = new Map<string, IActiveConnectionSession>();
	private readonly _secrets = new Map<string, ConnectionSecret>();
	private readonly _pendingTokens = new Map<string, CancellationTokenSource>();

	private readonly _onDidChangeActiveConnection = new Emitter<void>();
	readonly onDidChangeActiveConnection = this._onDidChangeActiveConnection.event;
	private readonly _onDidChangeConnections = new Emitter<void>();
	readonly onDidChangeConnections = this._onDidChangeConnections.event;
	private readonly _onDidChangeSessionState = new Emitter<readonly IActiveConnectionSession[]>();
	readonly onDidChangeSessionState = this._onDidChangeSessionState.event;

	private readonly _developerMode = new Map<string, DeveloperModeStatus>();

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this._stored = this.loadStored();
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, storageKey, new DisposableStore())(() => {
			const stored = this.loadStored();
			if (stored.activeId !== this._stored.activeId || stored.connections.length !== this._stored.connections.length) {
				this._stored.connections = stored.connections;
				this._stored.activeId = stored.activeId;
				this._onDidChangeConnections.fire();
			}
		}));
		this._register(this.secretStorageService.onDidChangeSecret(async key => {
			if (key.startsWith(`${secretService}.`) && key.endsWith('.password')) {
				const id = key.slice(secretService.length + 1, -'.password'.length);
				if (!this._secrets.has(id)) {
					const value = await this.secretStorageService.get(key);
					if (value) {
						try {
							this._secrets.set(id, JSON.parse(value) as ConnectionSecret);
						} catch { /* ignore corrupt secrets */ }
					}
				}
			}
		}));
		void this.loadSecrets();
	}

	private loadStored(): StoredConnections {
		const raw = this.storageService.get(storageKey, StorageScope.APPLICATION, 'null');
		try {
			const parsed = JSON.parse(raw) as Partial<StoredConnections>;
			const connections = Array.isArray(parsed.connections) ? parsed.connections.filter(c => typeof c?.id === 'string') : [];
			return { connections, activeId: typeof parsed.activeId === 'string' ? parsed.activeId : undefined };
		} catch {
			return { connections: [], activeId: undefined };
		}
	}

	private persist(): void {
		this.storageService.store(storageKey, JSON.stringify(this._stored), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangeConnections.fire();
	}

	private async loadSecrets(): Promise<void> {
		for (const connection of this._stored.connections) {
			const key = `${secretService}.${connection.id}.password`;
			try {
				const value = await this.secretStorageService.get(key);
				if (!value) {
					continue;
				}
				const parsed = JSON.parse(value) as Partial<ConnectionSecret>;
				if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
					this._secrets.set(connection.id, { username: parsed.username, password: parsed.password });
					if (connection.username !== parsed.username) {
						connection.username = parsed.username;
					}
				}
			} catch (error) {
				this.logService.debug('[Frappe Studio] secret load failed', error instanceof Error ? error.name : String(error));
			}
		}
		this._onDidChangeConnections.fire();
	}

	getConnections(): readonly IFrappeSiteConnection[] {
		return this._stored.connections;
	}

	getSession(connectionId: string): IActiveConnectionSession | undefined {
		return this._sessions.get(connectionId);
	}

	getSessions(): readonly IActiveConnectionSession[] {
		return [...this._sessions.values()];
	}

	set activeSessionId(value: string | undefined) {
		this.setActiveSession(value);
	}

	get activeSessionId(): string | undefined {
		return this._stored.activeId;
	}

	setActiveSession(connectionId: string | undefined): void {
		if (connectionId !== undefined && !this._sessions.has(connectionId)) {
			throw new Error(`No session for connection ${connectionId}`);
		}
		if (this._stored.activeId !== connectionId) {
			this._stored.activeId = connectionId;
			this.persist();
			this._onDidChangeActiveConnection.fire();
		}
	}

	getSessionsForStateChange(): readonly IActiveConnectionSession[] {
		return this.getSessions();
	}

	setDeveloperModeStatus(connectionId: string, status: DeveloperModeStatus): void {
		this._developerMode.set(connectionId, status);
		const session = this._sessions.get(connectionId);
		if (session && session.identity) {
			session.identity = { ...session.identity, developerMode: status };
			this._onDidChangeSessionState.fire(this.getSessions());
		}
	}

	developerModeStatus(sessionId: string): DeveloperModeStatus {
		const session = this._sessions.get(sessionId);
		const fromSession = session?.identity?.developerMode;
		if (fromSession && fromSession !== 'unknown') {
			return fromSession;
		}
		return this._developerMode.get(sessionId) ?? 'unknown';
	}

	clientFor(connectionId: string): IFrappeClient | undefined {
		return this._sessions.get(connectionId)?.client;
	}

	async listCredentials(connectionId: string): Promise<ConnectionSecret | undefined> {
		return this._secrets.get(connectionId);
	}

	async connect(url: string, username: string, password: string, options: ConnectOptions, token?: CancellationToken): Promise<IActiveConnectionSession> {
		if (!username) {
			throw new FrappeAuthenticationError('Username is required (usually Administrator).');
		}
		if (!password) {
			throw new FrappeAuthenticationError('Password is required.');
		}
		let site: NormalizedSiteUrl;
		try {
			site = normalizeSiteUrl(url);
		} catch (error) {
			throw new SiteUrlError(error instanceof Error ? error.message : String(error));
		}
		const client = new FrappeClient(site, this.requestService, this.logService);
		const state = new CancellationTokenSource(token ?? undefined);
		try {
			await client.login(username, password, state.token);
		} catch (error) {
			state.cancel();
			throw toConnectError(error);
		}
		const user = await client.getLoggedUser(state.token);
		let versions: GetVersionsResult | undefined;
		let capabilities: IFrappeCapabilities | undefined;
		let identity: FrappeSiteIdentity | undefined;
		const connectionId = this.upsertConnection(site.origin, site.host, username);
		const finalToken = state.token;
		try {
			versions = await client.getVersions(finalToken);
			capabilities = await client.probeCapabilities(finalToken);
			identity = {
				siteName: site.host,
				currentUser: user,
				frappeVersion: versions?.frappe,
				developerMode: 'unknown',
				installedApps: (versions?.apps ?? []).map(app => ({ name: app.name, version: app.version, modules: [] }))
			};
		} catch (error) {
			this.logService.debug('[Frappe Studio] connect probe failure', error instanceof Error ? error.name : String(error));
		}
		if (options.rememberPassword) {
			await this.storeSecret(connectionId, { username, password });
		}
		const session: IActiveConnectionSession = {
			connection: this.getConnection(connectionId)!,
			client,
			state: FrappeConnectionState.Connected,
			capabilities,
			identity,
			versions
		};
		this._secrets.set(connectionId, { username, password });
		this._sessions.set(connectionId, session);
		this.setActiveSession(connectionId);
		this._onDidChangeSessionState.fire(this.getSessions());
		return session;
	}

	async reconnect(connectionId: string, token?: CancellationToken): Promise<boolean> {
		const stored = this._stored.connections.find(c => c.id === connectionId);
		if (!stored) {
			return false;
		}
		const secret = await this.listCredentials(connectionId);
		if (!secret) {
			return false;
		}
		stored.lastUsedAt = Date.now();
		this.persist();
		await this.connect(stored.label || stored.origin, secret.username, secret.password, { rememberPassword: true, ignoreTlsError: stored.trusted }, token);
		return true;
	}

	/** Guarantees a working authenticated client for a connection, silently reconnecting when possible. */
	async ensureSession(connectionId: string, token?: CancellationToken): Promise<IActiveConnectionSession> {
		const existing = this._sessions.get(connectionId);
		if (existing && await existing.client.isSessionValid(token ?? CancellationToken.None)) {
			return existing;
		}
		const reconnected = await this.reconnect(connectionId, token);
		if (reconnected) {
			return this._sessions.get(connectionId)!;
		}
		throw new FrappeSessionExpiredError();
	}

	async disconnect(connectionId: string, closeServerSession: boolean): Promise<void> {
		const session = this._sessions.get(connectionId);
		if (session && closeServerSession) {
			try {
				await session.client.logout(CancellationToken.None);
			} catch (error) {
				this.logService.debug('[Frappe Studio] logout failed', error instanceof Error ? error.name : String(error));
			}
		}
		this._sessions.delete(connectionId);
		this._pendingTokens.get(connectionId)?.dispose();
		this._pendingTokens.delete(connectionId);
		if (this._stored.activeId === connectionId) {
			this._stored.activeId = undefined;
			this.persist();
			this._onDidChangeActiveConnection.fire();
		}
		this._onDidChangeSessionState.fire(this.getSessions());
	}

	async forget(connectionId: string): Promise<void> {
		await this.disconnect(connectionId, true);
		this._stored.connections = this._stored.connections.filter(c => c.id !== connectionId);
		this._developerMode.delete(connectionId);
		this.persist();
		await this.removeSecret(connectionId);
	}

	private upsertConnection(origin: string, host: string, username: string): string {
		const id = nextFreeId(origin, new Set(this._stored.connections.map(c => c.id)));
		let entry = this._stored.connections.find(c => c.id === id);
		if (!entry) {
			entry = { id, origin, label: host, username, trusted: false, lastUsedAt: Date.now() };
			this._stored.connections.push(entry);
		} else {
			entry.username = username;
			entry.lastUsedAt = Date.now();
		}
		this.persist();
		return id;
	}

	private getConnection(connectionId: string): IFrappeSiteConnection | undefined {
		return this._stored.connections.find(c => c.id === connectionId);
	}

	private async storeSecret(connectionId: string, secret: ConnectionSecret): Promise<void> {
		const key = `${secretService}.${connectionId}.password`;
		try {
			await this.secretStorageService.set(key, JSON.stringify({ username: secret.username, password: secret.password }));
		} catch (error) {
			this.logService.warn('[Frappe Studio] could not store the password securely; the connection will require re-authentication.', error instanceof Error ? error.name : String(error));
		}
	}

	private async removeSecret(connectionId: string): Promise<void> {
		const key = `${secretService}.${connectionId}.password`;
		this._secrets.delete(connectionId);
		try {
			await this.secretStorageService.delete(key);
		} catch { /* already gone */ }
	}
}

function toConnectError(error: unknown): Error {
	if (error instanceof FrappeSessionExpiredError) {
		return new FrappeAuthenticationError('The site rejected the login or the session expired.');
	}
	return error instanceof Error ? error : new Error(String(error));
}

registerSingleton(ISiteConnectionService, SiteConnectionService, InstantiationType.Eager);
