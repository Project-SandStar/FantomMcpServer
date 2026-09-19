/**
 * MCP client for the Axon MCP server.
 *
 * - stdio: spawns `settings.command settings.args` with cwd = projectPath (the
 *   Axon server resolves its config/proj relative to its own package.json, so
 *   the cwd matters for its .env / DATABASE_URL).
 * - http:  StreamableHTTP to `settings.url`.
 *
 * Lazy connect on first use, reconnect with exponential backoff after a drop,
 * tool list cached on connect, `callTool()` proxy, `getStatus()` for the admin
 * route. Never throws from status; `callTool` throws when disabled/unreachable.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/index.js';
import { getAxonSettings, type AxonSettings } from './axonSettings.js';

const logger = createLogger('axon-mcp');

export interface AxonToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface AxonClientStatus {
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  transport: 'stdio' | 'http';
  projectPath: string;
  command?: string;
  url?: string;
  toolCount: number;
  toolNames: string[];
  lastError?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  reconnectAttempts: number;
  serverInfo?: { name?: string; version?: string };
  pid?: number;
}

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

class AxonMcpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private tools: AxonToolInfo[] = [];
  private connecting: Promise<void> | null = null;
  private lastError?: string;
  private lastConnectedAt?: string;
  private lastDisconnectedAt?: string;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private serverInfo?: { name?: string; version?: string };
  private settingsKey = '';
  private stopped = false;

  private snapshotSettings(s: AxonSettings): string {
    return JSON.stringify([s.projectPath, s.transport, s.command, s.args, s.url, s.enabled]);
  }

  /** Called by updateSettings — drop the connection so the next call uses the new config. */
  async applySettingsChange(): Promise<void> {
    const s = getAxonSettings();
    const key = this.snapshotSettings(s);
    if (key === this.settingsKey) return;
    logger.info('Axon settings changed — resetting MCP connection');
    await this.disconnect('settings-changed');
    this.reconnectAttempts = 0;
    this.lastError = undefined;
  }

  isConnected(): boolean {
    return !!this.client && !!this.transport;
  }

  getStatus(): AxonClientStatus {
    const s = getAxonSettings();
    const pid = (this.transport as any)?.pid ?? (this.transport as any)?._process?.pid;
    return {
      enabled: s.enabled,
      connected: this.isConnected(),
      connecting: !!this.connecting,
      transport: s.transport,
      projectPath: s.projectPath,
      command: s.transport === 'stdio' ? `${s.command} ${s.args.join(' ')}` : undefined,
      url: s.transport === 'http' ? s.url : undefined,
      toolCount: this.tools.length,
      toolNames: this.tools.map(t => t.name),
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      reconnectAttempts: this.reconnectAttempts,
      serverInfo: this.serverInfo,
      pid: typeof pid === 'number' ? pid : undefined,
    };
  }

  listTools(): AxonToolInfo[] {
    return this.tools;
  }

  /** Connect if needed. Throws when disabled or the connection fails. */
  async ensureConnected(): Promise<Client> {
    const s = getAxonSettings();
    if (!s.enabled) throw new Error('Axon integration is disabled (settings.axon.enabled = false)');
    if (this.client && this.transport) return this.client;
    if (this.connecting) { await this.connecting; return this.client!; }
    this.stopped = false;
    this.connecting = this.connect(s).finally(() => { this.connecting = null; });
    await this.connecting;
    return this.client!;
  }

  private async connect(s: AxonSettings): Promise<void> {
    this.settingsKey = this.snapshotSettings(s);
    let transport: Transport;
    if (s.transport === 'http') {
      transport = new StreamableHTTPClientTransport(new URL(s.url));
      logger.info(`Connecting to Axon MCP over HTTP at ${s.url}`);
    } else {
      const entry = s.args.find(a => a.endsWith('.js'));
      if (entry && !fs.existsSync(path.resolve(s.projectPath, entry))) {
        throw this.fail(`Axon server entry not found: ${path.resolve(s.projectPath, entry)} — build the Axon server or fix axon.projectPath`);
      }
      transport = new StdioClientTransport({
        command: s.command,
        args: s.args,
        cwd: s.projectPath,
        // Force stdio on the child regardless of what our own env says; keep
        // PATH etc. The Axon server reads MCP_TRANSPORT.
        // DOTENV_CONFIG_QUIET: the Axon server loads dotenv@17, which prints
        // "[dotenv@17.x] injecting env (n) from .env" to STDOUT — on a stdio
        // transport that line corrupts the JSON-RPC stream and the SDK drops
        // the connection ("Connection closed"). dotenv honours this env var.
        // Our own MCP_PORT/DATABASE_URL must not leak into the child either.
        env: {
          ...(process.env as Record<string, string>),
          MCP_TRANSPORT: 'stdio',
          DOTENV_CONFIG_QUIET: 'true',
          NODE_NO_WARNINGS: '1',
          MCP_PORT: '',
          DATABASE_URL: '',
        },
        stderr: 'pipe',
      });
      const stderr = (transport as StdioClientTransport).stderr;
      stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) logger.debug(`[axon-server] ${line.split('\n')[0].slice(0, 200)}`);
      });
      logger.info(`Spawning Axon MCP server: ${s.command} ${s.args.join(' ')} (cwd ${s.projectPath})`);
    }

    const client = new Client({ name: 'mcp-fantom', version: '1.0.1' }, { capabilities: {} });
    transport.onclose = () => this.onDropped('transport closed');
    transport.onerror = (err: Error) => { this.lastError = err.message; logger.warn(`Axon transport error: ${err.message}`); };

    try {
      await client.connect(transport);
      const list = await client.listTools();
      this.tools = (list.tools ?? []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      this.serverInfo = client.getServerVersion() as { name?: string; version?: string } | undefined;
      this.client = client;
      this.transport = transport;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = undefined;
      this.reconnectAttempts = 0;
      logger.info(`Axon MCP connected (${this.tools.length} tools, server ${this.serverInfo?.name ?? '?'} ${this.serverInfo?.version ?? ''})`);
    } catch (err) {
      try { await transport.close(); } catch { /* ignore */ }
      throw this.fail(`Axon MCP connect failed: ${(err as Error).message}`);
    }
  }

  private fail(msg: string): Error {
    this.lastError = msg;
    logger.error(msg);
    return new Error(msg);
  }

  private onDropped(reason: string): void {
    if (!this.client && !this.transport) return;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.lastDisconnectedAt = new Date().toISOString();
    logger.warn(`Axon MCP disconnected: ${reason}`);
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const s = getAxonSettings();
    if (!s.enabled) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts++;
    logger.info(`Axon MCP reconnect #${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<{ text: string; isError: boolean; raw: unknown }> {
    const client = await this.ensureConnected();
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const content = (res as any).content as Array<{ type: string; text?: string }> | undefined;
      const text = (content ?? []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text!).join('\n');
      return { text, isError: !!(res as any).isError, raw: res };
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = `callTool ${name}: ${msg}`;
      // A transport-level failure means the connection is gone; drop so the next call reconnects.
      if (/closed|ECONN|EPIPE|not connected/i.test(msg)) this.onDropped(msg);
      throw err;
    }
  }

  async disconnect(reason = 'manual'): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const t = this.transport;
    this.client = null;
    this.transport = null;
    this.tools = [];
    if (t) {
      this.lastDisconnectedAt = new Date().toISOString();
      try { await t.close(); } catch { /* ignore */ }
      logger.info(`Axon MCP disconnected (${reason})`);
    }
  }
}

let singleton: AxonMcpClient | null = null;
export function getAxonMcpClient(): AxonMcpClient {
  if (!singleton) singleton = new AxonMcpClient();
  return singleton;
}
