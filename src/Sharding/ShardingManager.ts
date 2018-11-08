import { EventEmitter } from 'events';
import { cpus, platform } from 'os';
import { Client, ClientOptions } from 'discord.js';
import { Util } from '../Util/Util';
import { isMaster } from 'cluster';
import { http } from '../Util/Constants';
import fetch from 'node-fetch';
import { MasterIPC } from '../IPC/MasterIPC';
import { Cluster } from '../Cluster/Cluster';
import { CloseEvent } from '../Cluster/BaseCluster';

export const { version } = require('../../package.json');

export type SharderOptions = {
	token?: string
	shardCount?: number | 'auto';
	clusterCount?: number;
	name?: string;
	development?: boolean;
	client?: typeof Client,
	clientOptions?: ClientOptions;
	guildsPerShard?: number,
	respawn?: boolean;
	ipcSocket?: string;
};

export type SessionObject = {
	url: string;
	shards: number;
	session_start_limit: {
		total: number;
		remaining: number;
		reset_after: number;
	}
};

export class ShardingManager extends EventEmitter {
	public clusters = new Map<number, Cluster>();
	public clientOptions: ClientOptions;
	public shardCount: number | 'auto';
	public guildsPerShard: number;
	public client: typeof Client;
	public clusterCount: number;
	public ipcSocket: string;
	public respawn: boolean;
	public ipc: MasterIPC;

	private development: boolean;
	private token?: string;

	constructor(public path: string, options: SharderOptions) {
		super();
		this.clusterCount = options.clusterCount || cpus().length;
		this.guildsPerShard = options.guildsPerShard || 1000;
		this.clientOptions = options.clientOptions || {};
		this.development = options.development || false;
		this.shardCount = options.shardCount || 'auto';
		this.client = options.client || Client;
		this.respawn = options.respawn || true;
		this.ipcSocket = options.ipcSocket || (platform() === 'win32' ? '//./pipe/tmp/DiscordBot.sock' : '/tmp/DiscordBot.sock');
		this.token = options.token;
		this.ipc = new MasterIPC(this);

		this.ipc.on('debug', msg => this.emit('debug', msg));
		this.ipc.on('error', err => this.emit('error', err));

		if (!this.path) throw new Error('You need to supply a Path!');
	}

	public async spawn(): Promise<void> {
		if (isMaster) {
			if (this.shardCount === 'auto') {
				this.emit('debug', 'Fetching Session Endpoint');
				const { shards: recommendShards } = await this._fetchSessionEndpoint();

				this.shardCount = ShardingManager._calcShards(recommendShards, this.guildsPerShard);
				this.emit('debug', `Using recommend shard count of ${this.shardCount} shards with ${this.guildsPerShard} guilds per shard`);
			}

			this.emit('debug', `Starting ${this.shardCount} Shards in ${this.clusterCount} Clusters!`);

			if (this.shardCount < this.clusterCount) {
				this.clusterCount = this.shardCount;
			}

			const shardsPerCluster = Math.round(this.shardCount / this.clusterCount);
			const shardArray = [...Array(this.shardCount).keys()];
			const shardTuple = Util.chunk(shardArray, shardsPerCluster);
			for (let index = 0; index < this.clusterCount; index++) {
				const shards = shardTuple.shift()!;

				const cluster = new Cluster({ id: index, shards, manager: this });

				this.clusters.set(index, cluster);

				await cluster.spawn();
			}
		} else {
			Cluster._run(this);
		}
	}

	public async restartAll(): Promise<void> {
		this.emit('debug', 'Restarting all Clusters!');

		for (const cluster of this.clusters.values()) {
			await cluster.respawn();
		}
	}

	public async restart(clusterID: number): Promise<void> {
		const cluster = this.clusters.get(clusterID);
		if (!cluster) throw new Error('No Cluster with that ID found.');

		this.emit('debug', `Restarting Cluster ${clusterID}`);

		await cluster.respawn();
	}

	public fetchClientValues<T>(prop: string): Promise<T[]> {
		return this.ipc.broadcast<T>(`this.${prop}`);
	}

	public eval<T>(script: string): Promise<T> {
		return new Promise((resolve, reject) => {
			try {
				return resolve(eval(script));
			} catch (error) {
				reject(error);
			}
		});
	}

	public on(event: 'debug', listener: (message: string) => void): this;
	public on(event: 'message', listener: (message: any) => void): this;
	public on(event: 'ready', listener: (cluster: Cluster) => void): this;
	public on(event: 'shardReady' | 'shardReconnect', listener: (shardID: number) => void): this;
	public on(event: 'shardResumed', listener: (replayed: number, shardID: number) => void): this;
	public on(event: 'shardDisconnect', listener: (closeEvent: CloseEvent, shardID: number) => void): this;
	public on(event: any, listener: (...args: any[]) => void): this {
		return super.on(event, listener);
	}

	public once(event: 'debug', listener: (message: string) => void): this;
	public once(event: 'message', listener: (message: any) => void): this;
	public once(event: 'ready', listener: (cluster: Cluster) => void): this;
	public once(event: 'shardReady' | 'shardReconnect', listener: (shardID: number) => void): this;
	public once(event: 'shardResumed', listener: (replayed: number, shardID: number) => void): this;
	public once(event: 'shardDisconnect', listener: (closeEvent: CloseEvent, shardID: number) => void): this;
	public once(event: any, listener: (...args: any[]) => void): this {
		return super.once(event, listener);
	}

	private async _fetchSessionEndpoint(): Promise<SessionObject> {
		if (!this.token) throw new Error('No token was provided!');
		const res = await fetch(`${http.api}/v${http.version}/gateway/bot`, {
			method: 'GET',
			headers: { Authorization: `Bot ${this.token.replace(/^Bot\s*/i, '')}` },
		});
		if (res.ok)
			return res.json();
		throw res;
	}

	private static _calcShards(shards: number, guildsPerShard: number): number {
		return Math.ceil(shards * (1000 / guildsPerShard));
	}
}
