import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import { AuthManager } from "./auth.js";
import { DesktopAppBridge } from "./desktop-bridge.js";
import { describeError, enableFileLogging, getLogFilePath, logEvent } from "./logger.js";
import {
  applySessionModels,
  normalizeDesktopCatalog,
  resolveModelSelection,
  type ModelCatalog,
  type ModelSelection,
} from "./model-catalog.js";
import { CopilotSdkEngine } from "./sdk-engine.js";
import { SessionStateStore } from "./session-store.js";
import { TlsManager } from "./tls.js";
import type { DeliveryMode, DesktopHostStatus, SessionMode } from "./types.js";
import { WanTunnelManager } from "./wan-tunnel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = fs.existsSync(path.join(__dirname, "..", "package.json"))
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname);
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.join(PROJECT_ROOT, "src", "public");
const RELEASES_DIR = path.join(PROJECT_ROOT, "releases");
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
const SESSION_MODEL_CATALOG_TTL_MS = 60 * 1000;
const MODEL_INTENT_TTL_MS = 2 * 60 * 60 * 1000;
const MODEL_CATALOG_CACHE_PATH = path.join(os.homedir(), ".copilot", "remote-agent-cache", "model-catalog.json");
// Set on a client socket once it carries an HTTP request or WebSocket upgrade.
const REQUEST_SEEN = Symbol("remoteAgent.requestSeen");
type MarkedSocket = net.Socket & { [REQUEST_SEEN]?: boolean; _parent?: net.Socket };

/** A model change refused before reaching the desktop app, with the reason to show the user. */
class ModelChangeRefused extends Error {
  constructor(
    message: string,
    readonly status = 409
  ) {
    super(message);
  }
}

/** Whether two selections run the session the same way (Auto ignores effort; other models ignore levels). */
function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  if (a.model !== b.model) return false;
  if ((a.contextTier || "default") !== (b.contextTier || "default")) return false;
  return b.model === "auto"
    ? (a.autoTier || "") === (b.autoTier || "")
    : (a.reasoningEffort || "") === (b.reasoningEffort || "");
}

/** HTTP status and body for a model switch that was refused or failed. */
function describeModelSwitchError(
  sessionId: string,
  model: string,
  err: unknown
): [number, { error: string; blocked?: boolean }] {
  if (err instanceof ModelChangeRefused) return [err.status, { error: err.message }];
  const message = err instanceof Error ? err.message : String(err);
  logEvent("warn", "model switch failed", { sessionId, model, error: message });
  if (/has not been confirmed/i.test(message)) {
    // The app fences a session after a switch it couldn't confirm; only an app restart clears it.
    return [
      409,
      {
        error:
          "The desktop Copilot app is still waiting to confirm an earlier model change for this session, so it won't accept model changes or new messages. Restart the GitHub Copilot app on the desktop to clear it.",
        blocked: true,
      },
    ];
  }
  return [502, { error: message.replace(/^Failed to set session model:\s*/i, "") || message }];
}

export interface RemoteAgentServerOptions {
  port?: number;
  host?: string;
  customToken?: string;
  allowLocalhostBypass?: boolean;
  enableWanAutoStart?: boolean;
  /** WAN access log path; null disables. Defaults to ~/.copilot/remote-agent-access.log unless port is 0 (tests). */
  accessLogPath?: string | null;
}

export class RemoteAgentServer {
  private netServer: net.Server;
  private httpServer: http.Server;
  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer;
  private auth: AuthManager;
  private store: SessionStateStore;
  private bridge: DesktopAppBridge;
  private sdk: CopilotSdkEngine;
  private wan: WanTunnelManager;
  private clients = new Set<WsClient>();
  private pendingSteering = new Map<
    string,
    Array<{
      id: string;
      prompt: string;
      deliveryMode: DeliveryMode;
      attachments?: Array<{ name: string; url: string }>;
      createdAt: string;
    }>
  >();
  private resolvedRequestIds = new Set<string>();
  private stateWatcher: fs.FSWatcher | null = null;
  private publicWatcher: fs.FSWatcher | null = null;
  private wsAlive = new WeakMap<WsClient, boolean>();
  private wsHeartbeatTimer: NodeJS.Timeout | null = null;
  private pendingFileBroadcasts = new Map<string, NodeJS.Timeout>();
  private lastFileBroadcastAt = new Map<string, number>();
  private readonly startedAt = new Date().toISOString();
  private port: number;
  private host: string;
  private allowLocalhostBypass: boolean;
  private enableWanAutoStart: boolean;
  private accessLogPath: string | null;
  private modelCatalog: ModelCatalog | null = null;
  private modelCatalogStale = false;
  private modelCatalogRequest: Promise<ModelCatalog> | null = null;
  private sessionModelCatalogs = new Map<string, { catalog: ModelCatalog; expiresAt: number }>();
  /**
   * Model choices made while a change was still waiting for the session's turn to end. The newest choice
   * wins and is applied once the session is idle, so steps never reach the runtime out of order.
   */
  private modelIntents = new Map<string, { selection: ModelSelection & { model: string }; expiresAt: number }>();
  private modelIntentTimer: NodeJS.Timeout | null = null;

  constructor(options: RemoteAgentServerOptions = {}) {
    this.port = options.port ?? Number(process.env.PORT || 4321);
    this.host = options.host ?? (process.env.HOST || "0.0.0.0");
    this.allowLocalhostBypass = options.allowLocalhostBypass ?? true;
    this.enableWanAutoStart = options.enableWanAutoStart ?? true;
    this.accessLogPath =
      options.accessLogPath !== undefined
        ? options.accessLogPath
        : this.port === 0
          ? null
          : path.join(os.homedir(), ".copilot", "remote-agent-access.log");

    this.auth = new AuthManager(options.customToken);
    this.store = new SessionStateStore({ persistEventIndex: !options.customToken });
    this.store.onStaleDetailServed = (sessionId, retryInMs) =>
      this.scheduleSessionFileUpdate(sessionId, "events.jsonl", retryInMs);
    this.bridge = new DesktopAppBridge();
    this.sdk = new CopilotSdkEngine();
    this.wan = new WanTunnelManager();

    this.wan.on("status", (st) => {
      this.broadcast({
        type: "wan_status",
        wan: st,
      });
    });

    const reqHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      (req.socket as MarkedSocket)[REQUEST_SEEN] = true;
      this.handleHttpRequest(req, res).catch((err) => {
        logEvent("warn", "request failed", { path: (req.url || "").split("?")[0], ...describeError(err) });
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    };

    // Allow slow cellular uploads and keep idle mobile TLS connections warm, while still bounding header stalls.
    const applyHttpTimeouts = (srv: http.Server) => {
      srv.requestTimeout = 300_000;
      srv.headersTimeout = 35_000;
      srv.keepAliveTimeout = 30_000;
    };

    // A 'clientError' listener replaces Node's default handling, so this mirrors it after logging.
    const onClientError = (err: NodeJS.ErrnoException, socket: net.Socket) => {
      const code = err.code || err.message;
      const quietReset = (code === "ECONNRESET" || code === "EPIPE") && (socket as MarkedSocket)[REQUEST_SEEN];
      if (!quietReset) {
        this.appendWanLog(this.peerIpOf(socket), `HTTP client error ${code}`);
      }
      const pending = (socket as net.Socket & { _httpMessage?: { headersSent?: boolean } })._httpMessage;
      if (!socket.writable || pending?.headersSent) {
        socket.destroy();
        return;
      }
      const status =
        code === "HPE_HEADER_OVERFLOW"
          ? "431 Request Header Fields Too Large"
          : code === "ERR_HTTP_REQUEST_TIMEOUT"
            ? "408 Request Timeout"
            : "400 Bad Request";
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };

    this.httpServer = http.createServer(reqHandler);
    applyHttpTimeouts(this.httpServer);
    this.httpServer.on("clientError", onClientError);

    const tlsCreds = TlsManager.ensureCredentials();
    if (tlsCreds) {
      this.httpsServer = https.createServer(
        {
          key: tlsCreds.key,
          cert: tlsCreds.cert,
        },
        reqHandler
      );
      applyHttpTimeouts(this.httpsServer);
      this.httpsServer.on("clientError", onClientError);
      this.httpsServer.on("tlsClientError", (err: NodeJS.ErrnoException, tlsSocket: TLSSocket) => {
        this.appendWanLog(this.peerIpOf(tlsSocket), `TLS handshake failed: ${err.code || err.message}`);
      });
      this.httpsServer.on("secureConnection", (tlsSocket: TLSSocket) => this.watchForRequestlessTls(tlsSocket));
    }

    // Single-port HTTP + HTTPS (TLS) multiplexer with 5s first-byte anti-Slowloris timeout:
    // Peeks at the first byte on port 4321: 0x16 (TLS ClientHello) -> httpsServer, else -> httpServer
    this.netServer = net.createServer((socket) => {
      socket.setNoDelay(true);
      // TCP keepalive detects dead phone connections and keeps carrier NAT mappings warm.
      socket.setKeepAlive(true, 30_000);
      const firstByteTimer = setTimeout(() => {
        this.appendWanLog(this.peerIpOf(socket), "TCP connection sent no data within 5s; closed");
        socket.destroy();
      }, 5_000);
      firstByteTimer.unref();

      const onReadable = () => {
        const chunk = socket.read(1) as Buffer | null;
        if (!chunk) return;
        clearTimeout(firstByteTimer);
        socket.removeListener("readable", onReadable);
        socket.unshift(chunk);
        if (chunk[0] === 0x16 && this.httpsServer) {
          this.httpsServer.emit("connection", socket);
        } else {
          this.httpServer.emit("connection", socket);
        }
      };
      socket.on("readable", onReadable);
      socket.on("close", () => clearTimeout(firstByteTimer));
      socket.on("error", () => {
        clearTimeout(firstByteTimer);
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocketServer();
    this.setupBridgeListeners();
  }

  getAuthManager(): AuthManager {
    return this.auth;
  }

  getPort(): number {
    const addr = this.netServer.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.port;
  }

  async start(): Promise<{ port: number; lanUrls: string[]; tailscaleUrls: string[]; token: string }> {
    // Claim the port before starting watchers/bridges so a duplicate instance exits without side effects.
    await new Promise<void>((resolve, reject) => {
      this.netServer.once("error", reject);
      this.netServer.listen(this.port, this.host, () => {
        this.netServer.removeListener("error", reject);
        resolve();
      });
    });

    try {
      await this.sdk.initialize();
      this.bridge.start();
      this.startSessionStateWatcher();
      this.startWebSocketHeartbeat();
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }

    const actualPort = this.getPort();
    this.wan.setLocalPort(actualPort);
    if (this.enableWanAutoStart && this.wan.shouldAutoStart()) {
      this.wan.startTunnel().catch(() => {
        // Non-fatal on startup
      });
    }
    const { lanUrls, tailscaleUrls } = AuthManager.getNetworkUrls(actualPort);
    return {
      port: actualPort,
      lanUrls,
      tailscaleUrls,
      token: this.auth.token,
    };
  }

  async stop(): Promise<void> {
    this.wan.stopTunnel();
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
    if (this.modelIntentTimer) {
      clearInterval(this.modelIntentTimer);
      this.modelIntentTimer = null;
    }
    this.store.stopBackgroundWork();
    if (this.stateWatcher) {
      this.stateWatcher.close();
      this.stateWatcher = null;
    }
    if (this.publicWatcher) {
      this.publicWatcher.close();
      this.publicWatcher = null;
    }
    this.bridge.stop();
    await this.sdk.stop();
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.httpServer.close();
        this.httpsServer?.close();
        this.netServer.close(() => resolve());
      });
    });
  }

  private setupWebSocketServer(): void {
    const onUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
      (socket as MarkedSocket)[REQUEST_SEEN] = true;
      const parsed = new URL(req.url || "/", "http://localhost");
      if (parsed.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      if (!this.auth.isAuthorized(req, this.allowLocalhostBypass)) {
        const deniedIp = this.auth.getClientIp(req);
        logEvent("warn", "websocket unauthorized", { ip: deniedIp });
        this.appendWanLog(deniedIp, "WS /ws 401");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const clientIp = this.auth.getClientIp(req);
        const wsStarted = Date.now();
        this.appendWanLog(clientIp, "WS /ws open");
        ws.on("close", (code) =>
          this.appendWanLog(clientIp, `WS /ws close code=${code} after ${Math.round((Date.now() - wsStarted) / 1000)}s`)
        );
        this.clients.add(ws);
        this.wsAlive.set(ws, true);
        logEvent("info", "websocket connected", { ip: clientIp, clients: this.clients.size });
        ws.send(
          JSON.stringify({
            type: "connected",
            timestamp: new Date().toISOString(),
            serverStartedAt: this.startedAt,
            desktopAppConnected: this.bridge.isConnected(),
            hostname: os.hostname(),
            uiVersion: this.getUiVersion(),
          })
        );
        ws.on("pong", () => {
          this.wsAlive.set(ws, true);
        });
        ws.on("message", (raw) => {
          this.wsAlive.set(ws, true);
          try {
            const parsed = JSON.parse(String(raw));
            if (parsed?.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
            }
          } catch {}
        });
        ws.on("error", () => {
          // Close handler below performs cleanup
        });
        ws.on("close", (code) => {
          this.clients.delete(ws);
          logEvent("info", "websocket closed", { ip: clientIp, code, clients: this.clients.size });
        });
      });
    };

    this.httpServer.on("upgrade", onUpgrade);
    this.httpsServer?.on("upgrade", onUpgrade);
  }

  private startWebSocketHeartbeat(): void {
    if (this.wsHeartbeatTimer) return;
    // Phones that sleep or switch networks leave half-open sockets; reap them instead of buffering broadcasts forever.
    this.wsHeartbeatTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (this.wsAlive.get(ws) === false) {
          this.clients.delete(ws);
          try {
            ws.terminate();
          } catch {}
          continue;
        }
        this.wsAlive.set(ws, false);
        try {
          ws.ping();
        } catch {}
      }
    }, 20_000);
    this.wsHeartbeatTimer.unref();
  }

  private setupBridgeListeners(): void {
    this.bridge.on("status", (status) => {
      this.broadcast({
        type: "desktop_status",
        ...status,
      });
      if ((status as { connected?: boolean }).connected) {
        // The account (and with it the catalog) may have changed while the app was away.
        this.modelCatalogStale = true;
        this.sessionModelCatalogs.clear();
        void this.getModelCatalog();
      } else if (this.modelIntents.size > 0) {
        // A restarted app starts its sessions over, so choices waiting for a turn to end are dropped.
        this.modelIntents.clear();
        this.afterModelChange();
      }
    });

    this.bridge.on("workspaces_updated", () => {
      this.broadcast({
        type: "sessions_updated",
        timestamp: new Date().toISOString(),
      });
    });

    this.bridge.on("external_model_change", ({ sessionId }: { sessionId: string }) => {
      // A newer choice made in the desktop app wins over one still waiting here.
      if (this.modelIntents.delete(sessionId)) this.afterModelChange();
    });

    this.bridge.on("session_event", ({ sessionId, event }) => {
      // Sub-agents report their own events; only the session's own idle means its turn has ended.
      if (event?.type === "session.idle" && !event.agentId && sessionId) {
        this.runModelIntent(sessionId);
      }
      if (event && event.type === "user.message" && sessionId) {
        const content = String((event.data as Record<string, unknown>)?.content || "");
        const list = this.pendingSteering.get(sessionId) || [];
        if (list.length > 0) {
          this.pendingSteering.set(
            sessionId,
            list.filter((item) => !content.includes(item.prompt))
          );
        }
      }
      this.broadcast({
        type: "session_event",
        sessionId,
        event,
      });
    });

    this.bridge.on("desktop_notification", (msg) => {
      this.broadcast({
        type: "desktop_notification",
        notification: msg,
      });
    });
  }

  private getUiVersion(): string {
    try {
      const h = crypto.createHash("sha1");
      for (const f of ["index.html", "styles.css", "app.js"]) {
        const p = path.join(PUBLIC_DIR, f);
        if (fs.existsSync(p)) {
          const st = fs.statSync(p);
          h.update(`${f}:${st.size}:${st.mtimeMs};`);
        }
      }
      return h.digest("hex").slice(0, 10);
    } catch {
      return "1";
    }
  }

  private startSessionStateWatcher(): void {
    // Also watch src/public so any UI edit immediately hot-reloads connected mobile/web clients!
    try {
      let uiDebounce: NodeJS.Timeout | null = null;
      this.publicWatcher = fs.watch(PUBLIC_DIR, (_ev, filename) => {
        if (!filename) return;
        if (uiDebounce) clearTimeout(uiDebounce);
        uiDebounce = setTimeout(() => {
          this.broadcast({
            type: "ui_reload",
            uiVersion: this.getUiVersion(),
            timestamp: new Date().toISOString(),
          });
        }, 180);
      });
    } catch {
      // Ignore
    }

    const stateDir = path.join(this.store.getCopilotHome(), "session-state");
    if (!fs.existsSync(stateDir)) return;

    try {
      this.stateWatcher = fs.watch(stateDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const normalized = filename.replace(/\\/g, "/");
        const sessionId = normalized.split("/")[0];
        if (!sessionId) return;

        // Only notify on events.jsonl, workspace.yaml, plan.md, or files/ changes
        if (
          normalized.endsWith("events.jsonl") ||
          normalized.endsWith("workspace.yaml") ||
          normalized.endsWith("plan.md") ||
          normalized.includes("/files/")
        ) {
          this.store.invalidateSessionCache(sessionId);
          this.scheduleSessionFileUpdate(sessionId, normalized);
        }
      });
    } catch {
      // Ignore if recursive watch unsupported
    }
  }

  // Per-session throttle (at most ~1/s): active agents write constantly, so a trailing-only debounce
  // could starve updates.
  private scheduleSessionFileUpdate(sessionId: string, file: string, minDelayMs = 150): void {
    if (this.pendingFileBroadcasts.has(sessionId)) return;
    const sinceLast = Date.now() - (this.lastFileBroadcastAt.get(sessionId) || 0);
    const delay = Math.max(minDelayMs, sinceLast >= 1000 ? 0 : 1000 - sinceLast);
    const timer = setTimeout(() => {
      this.pendingFileBroadcasts.delete(sessionId);
      this.lastFileBroadcastAt.set(sessionId, Date.now());
      this.broadcast({
        type: "session_file_updated",
        sessionId,
        file,
        timestamp: new Date().toISOString(),
      });
    }, delay);
    timer.unref();
    this.pendingFileBroadcasts.set(sessionId, timer);
  }

  private broadcast(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try {
          client.send(raw);
        } catch {
          // Ignore send error
        }
      }
    }
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...extraHeaders,
    });
    res.end(data);
  }

  private async readJsonBody<T = Record<string, unknown>>(
    req: http.IncomingMessage,
    maxBytes = 25 * 1024 * 1024
  ): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new Error(`Request body too large (max ${Math.round(maxBytes / 1024)}KB)`);
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private isBotScannerProbe(pathname: string, userAgent: string): boolean {
    const lowerPath = pathname.toLowerCase();
    const lowerUa = userAgent.toLowerCase();
    if (
      lowerUa.includes("masscan") ||
      lowerUa.includes("zgrab") ||
      lowerUa.includes("nmap") ||
      lowerUa.includes("nuclei") ||
      lowerUa.includes("nikto") ||
      lowerUa.includes("sqlmap")
    ) {
      return true;
    }
    const honeypotPrefixes = [
      "/.env",
      "/.git",
      "/wp-",
      "/wordpress",
      "/phpmyadmin",
      "/cgi-bin",
      "/actuator",
      "/boaform",
      "/vendor/",
      "/sdk/",
      "/solr",
      "/hnap1",
      "/evox",
    ];
    if (honeypotPrefixes.some((p) => lowerPath.startsWith(p))) {
      return true;
    }
    if (/\.(php|asp|aspx|jsp|cgi|env|bak|sql)$/i.test(lowerPath)) {
      return true;
    }
    return false;
  }

  private async getHostStatus(): Promise<DesktopHostStatus> {
    const actualPort = this.getPort();
    const { lanUrls, tailscaleUrls } = AuthManager.getNetworkUrls(actualPort);
    const sessions = this.store.listSessions(this.bridge.getLiveWorkspaces());
    const sdkStatus = this.sdk.getStatus();
    const wanStatus = this.wan.getStatus(tailscaleUrls);
    const accounts = this.store.getGitHubAccounts();
    const primaryAccount = accounts.find((a) => a.isDefault)?.login || accounts[0]?.login || null;
    const quota = await this.store.getCopilotQuota();
    const availableModels = (await this.getModelCatalog()).models.map((m) => ({ id: m.id, name: m.name }));
    const peerHosts = this.store.listPeerHosts();
    const apkPath = path.join(RELEASES_DIR, "RemoteAgent-android.apk");
    const setupPath = path.join(RELEASES_DIR, "RemoteAgent-Desktop-Setup.exe");

    return {
      hostId: os.hostname().toLowerCase(),
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      desktopAppConnected: this.bridge.isConnected(),
      desktopAppPort: this.bridge.getPort(),
      desktopAppPid: this.bridge.getPid(),
      sdkAvailable: sdkStatus.available,
      sdkVersion: sdkStatus.cliVersion,
      copilotCliVersion: sdkStatus.cliVersion,
      accounts,
      primaryAccount,
      quota,
      availableModels,
      peerHosts,
      mcpServers: this.store.getMcpServers(),
      lanUrls,
      tailscaleUrls,
      wan: {
        enabled: wanStatus.enabled,
        status: wanStatus.status,
        provider: wanStatus.provider,
        publicUrl: wanStatus.publicUrl,
        customWanUrl: wanStatus.customWanUrl,
        error: wanStatus.error,
      },
      apkAvailable: fs.existsSync(apkPath),
      apkDownloadUrl: "/download/RemoteAgent-android.apk",
      desktopSetupAvailable: fs.existsSync(setupPath),
      activeSessionsCount: sessions.filter((s) => s.isRunning).length,
      totalSessionsCount: sessions.length,
      uiVersion: this.getUiVersion(),
      uiPrefs: this.store.getUiPreferences(),
    };
  }

  private sendCompressible(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    headers: Record<string, string>,
  ): void {
    const type = headers["Content-Type"] || "";
    const textual = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    if (textual && acceptsGzip && body.length > 1024) {
      const gz = zlib.gzipSync(body);
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": gz.length });
      res.end(gz);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": body.length });
    res.end(body);
  }

  private peerIpOf(socket: net.Socket | null | undefined): string {
    const marked = socket as MarkedSocket | null | undefined;
    return (marked?.remoteAddress || marked?._parent?.remoteAddress || "unknown").replace(/^::ffff:/i, "");
  }

  // Records secure connections that never carried a request, e.g. a client whose traffic stalls after the handshake.
  private watchForRequestlessTls(tlsSocket: TLSSocket): void {
    const ip = this.peerIpOf(tlsSocket);
    if (!this.accessLogPath || this.auth.isPrivateLanOrLocalIp(ip)) return;
    const opened = Date.now();
    const protocol = tlsSocket.getProtocol() || "TLS";
    tlsSocket.once("close", () => {
      if ((tlsSocket as MarkedSocket)[REQUEST_SEEN]) return;
      this.appendWanLog(
        ip,
        `${protocol} connected but closed after ${Math.round((Date.now() - opened) / 1000)}s without an HTTP request`
      );
    });
  }

  /**
   * The account's model catalog, asked from the desktop app (`list_models`) and cached for a few minutes.
   * When the app can't be reached, the last good copy on disk and then the app's own cached list are used.
   */
  private async getModelCatalog(forceRefresh = false): Promise<ModelCatalog> {
    const cached = this.modelCatalog;
    const fresh =
      cached?.source === "desktop" &&
      !this.modelCatalogStale &&
      Date.now() - Date.parse(cached.fetchedAt) < MODEL_CATALOG_TTL_MS;
    if (cached && fresh && !forceRefresh) return cached;
    if (this.modelCatalogRequest) return this.modelCatalogRequest;
    this.modelCatalogRequest = (async () => {
      if (this.bridge.isConnected()) {
        try {
          const raw = await this.bridge.listModels();
          const catalog = normalizeDesktopCatalog(raw, "desktop");
          if (catalog.models.length > 0) {
            this.modelCatalog = catalog;
            this.modelCatalogStale = false;
            this.saveModelCatalog(raw);
            return catalog;
          }
        } catch (err) {
          logEvent("warn", "model catalog request failed", describeError(err));
        }
      }
      const fallback = this.modelCatalog ?? this.loadSavedModelCatalog() ?? this.appStateModelCatalog();
      this.modelCatalog = fallback;
      return fallback;
    })().finally(() => {
      this.modelCatalogRequest = null;
    });
    return this.modelCatalogRequest;
  }

  private saveModelCatalog(raw: Record<string, unknown>): void {
    if (this.port === 0) return; // Test servers never touch the user's cache.
    try {
      fs.mkdirSync(path.dirname(MODEL_CATALOG_CACHE_PATH), { recursive: true });
      fs.writeFileSync(MODEL_CATALOG_CACHE_PATH, JSON.stringify(raw), "utf8");
    } catch {
      // Best effort
    }
  }

  private loadSavedModelCatalog(): ModelCatalog | null {
    if (this.port === 0) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(MODEL_CATALOG_CACHE_PATH, "utf8")) as unknown;
      const catalog = normalizeDesktopCatalog(raw, "cache");
      if (catalog.models.length === 0) return null;
      catalog.fetchedAt = fs.statSync(MODEL_CATALOG_CACHE_PATH).mtime.toISOString();
      return catalog;
    } catch {
      return null;
    }
  }

  private appStateModelCatalog(): ModelCatalog {
    const models = this.store.getAvailableModels();
    return {
      models,
      autoTiers: [],
      defaultAutoTier: this.store.getDefaultAutoTier() ?? "balance",
      source: models.length > 1 ? "app-state" : "fallback",
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * The models and Auto levels one session accepts. Sessions can belong to accounts with different
   * offerings, and the runtime rejects anything outside the session's own list, so a loaded session's
   * list is authoritative (no `auto_tiers` there means plain Auto only). Unloaded sessions can't list
   * their models; the account's levels stand in for display, as in the desktop picker, and are confirmed
   * by loading the session before one is sent (see `getVerifiedSessionModelCatalog`).
   */
  private async getSessionModelCatalog(
    sessionId: string,
    forceRefresh = false,
    refreshAccount = forceRefresh
  ): Promise<ModelCatalog> {
    const account = await this.getModelCatalog(refreshAccount);
    const cached = this.sessionModelCatalogs.get(sessionId);
    if (cached && !forceRefresh && Date.now() < cached.expiresAt) return cached.catalog;
    if (!this.bridge.isConnected()) return { ...account, autoTiers: [], sessionId };
    try {
      const raw = await this.bridge.listSessionModels(sessionId);
      return this.cacheSessionModelCatalog(sessionId, applySessionModels(account, raw, sessionId), SESSION_MODEL_CATALOG_TTL_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const catalog: ModelCatalog = { ...account, autoTiers: [], sessionId };
      // The app's wording for a session whose runtime isn't loaded right now.
      if (/after the cloud session is connected/i.test(message) && account.autoTiers.length > 0) {
        catalog.autoTiers = account.autoTiers;
        catalog.autoTiersUnverified = true;
      } else {
        logEvent("info", "session model list unavailable", { sessionId, error: message });
      }
      return this.cacheSessionModelCatalog(sessionId, catalog, 15_000);
    }
  }

  /**
   * The session's catalog with its Auto levels confirmed by the session itself. An unloaded session is
   * loaded first, as opening it in the desktop app would. Throws when the app has blocked the session
   * (an unconfirmed model change); other load failures leave plain Auto only.
   */
  private async getVerifiedSessionModelCatalog(sessionId: string): Promise<ModelCatalog> {
    let catalog = await this.getSessionModelCatalog(sessionId, true, false);
    if (!catalog.autoTiersUnverified) return catalog;
    // Bounded well inside the phone's request timeout.
    const deadline = Date.now() + 25_000;
    try {
      await this.bridge.resumeSession(sessionId);
      while (Date.now() < deadline) {
        catalog = await this.getSessionModelCatalog(sessionId, true, false);
        if (!catalog.autoTiersUnverified) return catalog;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/has not been confirmed/i.test(message)) throw err;
      logEvent("warn", "couldn't load session to confirm its Auto levels", { sessionId, error: message });
    }
    const plain: ModelCatalog = { ...catalog, autoTiers: [], autoTiersUnverified: undefined };
    return this.cacheSessionModelCatalog(sessionId, plain, 15_000);
  }

  private cacheSessionModelCatalog(sessionId: string, catalog: ModelCatalog, ttlMs: number): ModelCatalog {
    this.sessionModelCatalogs.delete(sessionId);
    this.sessionModelCatalogs.set(sessionId, { catalog, expiresAt: Date.now() + ttlMs });
    if (this.sessionModelCatalogs.size > 200) {
      const oldest = this.sessionModelCatalogs.keys().next().value;
      if (oldest) this.sessionModelCatalogs.delete(oldest);
    }
    return catalog;
  }

  private afterModelChange(): void {
    this.store.invalidateSessionsList();
    this.broadcast({ type: "sessions_updated", timestamp: new Date().toISOString() });
  }

  /** A choice still waiting for the session's turn to end, if any. */
  private activeModelIntent(sessionId: string): (ModelSelection & { model: string }) | undefined {
    const intent = this.modelIntents.get(sessionId);
    if (intent && Date.now() > intent.expiresAt) this.modelIntents.delete(sessionId);
    return this.modelIntents.get(sessionId)?.selection;
  }

  /** What the session will run next: a held choice, a change the app is holding, or what it runs now. */
  private currentModelChoice(sessionId: string): ModelSelection | null {
    return this.activeModelIntent(sessionId) ?? this.bridge.getQueuedSelection(sessionId) ?? this.appliedModelSelection(sessionId);
  }

  /**
   * Whether the session is mid-turn. Its own turn events are exact; before one has been seen (e.g. after
   * a restart mid-turn), the session list's running state stands in.
   */
  private isSessionBusy(sessionId: string): boolean {
    const known = this.bridge.isSessionBusy(sessionId);
    if (known !== undefined) return known;
    return Boolean(this.store.listSessions(this.bridge.getLiveWorkspaces()).find((s) => s.id === sessionId)?.isRunning);
  }

  /**
   * The selection the session runs: its persisted selection in data.db, with the runtime's own record
   * filling in sessions that never changed model, and the Auto level (known only to the bridge and the
   * event log). Null when the session is unknown. data.db already shows changes the app is holding for
   * the end of a turn, so this is only trustworthy while nothing is queued.
   */
  private appliedModelSelection(sessionId: string, maxStaleMs = 0): ModelSelection | null {
    const row = this.store.getSessionModelConfig(sessionId);
    const recorded = this.store.getRecordedModelState(sessionId, maxStaleMs);
    const model = row?.model ?? recorded.model;
    if (!model) return null;
    const fromRow = Boolean(row?.model);
    const selection: ModelSelection = {
      model,
      reasoningEffort: fromRow ? row?.reasoningEffort : recorded.reasoningEffort,
      contextTier: (fromRow ? row?.contextTier : recorded.contextTier) === "long_context" ? "long_context" : "default",
    };
    if (model === "auto") {
      selection.reasoningEffort = undefined;
      selection.autoTier = this.bridge.getSessionAutoTier(sessionId) ?? recorded.autoTier;
    }
    return selection;
  }

  /**
   * Sends a resolved selection to the desktop app, or holds it as the session's pending choice while the
   * session is mid-turn or an earlier change is still waiting (as the desktop picker does), so nothing sent
   * from here ever sits in the app's queue behind another change. Auto levels and long context never
   * change in the same step: the runtime refuses Fusion levels while long context is on, and a refused
   * switch blocks the session until the desktop app restarts.
   */
  private async applyModelSelection(
    sessionId: string,
    sel: ModelSelection & { model: string },
    catalog: ModelCatalog
  ): Promise<{ selection: ModelSelection; queued: boolean; notes: string[] }> {
    const hold = () => {
      this.modelIntents.set(sessionId, { selection: sel, expiresAt: Date.now() + MODEL_INTENT_TTL_MS });
      this.watchModelIntents();
      return { selection: sel, queued: true, notes: [] as string[] };
    };
    if (this.activeModelIntent(sessionId) || this.bridge.getQueuedSelection(sessionId) || this.isSessionBusy(sessionId)) {
      return hold();
    }
    const applied = this.appliedModelSelection(sessionId);
    if (!applied?.model) {
      throw new ModelChangeRefused("The desktop Copilot app has no model recorded for this session.", 404);
    }
    // data.db changes when a change is queued and the event log when the runtime applies it; if either
    // says long context (or Auto), treat it as on.
    const runtime = this.store.getRecordedModelState(sessionId);
    const longContextOn = applied.contextTier === "long_context" || runtime.contextTier === "long_context";
    const onAuto = applied.model === "auto" || runtime.model === "auto";
    const notes: string[] = [];
    const runtimeAgrees =
      (!runtime.model || runtime.model === applied.model) &&
      (!runtime.contextTier || runtime.contextTier === applied.contextTier);
    // E.g. a held change cancelled by choosing the current model again: nothing to send. (Auto levels are
    // re-sent, since a remembered level can be stale and re-sending one is harmless.)
    if (sel.model !== "auto" && sameModelSelection(applied, sel) && runtimeAgrees) {
      return { selection: applied, queued: false, notes };
    }
    let firstStep: (ModelSelection & { model: string }) | null = null;
    if (sel.model === "auto" && longContextOn) {
      if (applied.model === "auto") {
        if (!sel.autoTier) return { selection: applied, queued: false, notes };
        throw new ModelChangeRefused(
          "This session is on Auto with long context, and Auto levels can't be combined with long context. Pick another model first, then Auto."
        );
      }
      // Re-selecting the current model must itself be a switch the runtime accepts.
      const reset = resolveModelSelection(catalog, applied, { model: applied.model, contextTier: "default" });
      if (!reset.ok) {
        throw new ModelChangeRefused(
          `Long context has to be turned off before choosing an Auto level, and ${applied.model} can't be re-selected to do that (${reset.error}) Turn long context off in the desktop app first.`
        );
      }
      firstStep = { ...reset.selection, contextTier: "default" };
      notes.push("Long context was turned off first, since Auto doesn't use it.");
    } else if (sel.model !== "auto" && onAuto && sel.contextTier === "long_context") {
      firstStep = { ...sel, contextTier: "default" };
    }
    if (firstStep) {
      const first = await this.bridge.setSessionModel(sessionId, firstStep);
      if (first.queued) return hold();
    }
    const result = await this.bridge.setSessionModel(sessionId, sel);
    if (result.notice) notes.push(result.notice);
    return {
      selection: {
        model: result.model,
        reasoningEffort: result.reasoningEffort,
        contextTier: result.contextTier,
        autoTier: result.autoTier,
      },
      queued: result.queued,
      notes,
    };
  }

  /** Applies the session's held choice once it is idle; otherwise keeps holding it. */
  private runModelIntent(sessionId: string): void {
    const intent = this.activeModelIntent(sessionId);
    if (!intent || !this.bridge.isConnected()) return;
    if (this.bridge.getQueuedSelection(sessionId) || this.isSessionBusy(sessionId)) return;
    this.modelIntents.delete(sessionId);
    void (async () => {
      const catalog = await this.getSessionModelCatalog(sessionId);
      return this.applyModelSelection(sessionId, intent, catalog);
    })()
      .then((outcome) =>
        logEvent("info", "pending model change applied", { sessionId, model: intent.model, queued: outcome.queued })
      )
      .catch((err) => {
        const [, body] = describeModelSwitchError(sessionId, intent.model, err);
        this.broadcast({ type: "model_switch_failed", sessionId, error: body.error });
      })
      .finally(() => this.afterModelChange());
  }

  /** Re-checks held choices now and then, in case a session's idle event was missed. */
  private watchModelIntents(): void {
    if (this.modelIntentTimer) return;
    this.modelIntentTimer = setInterval(() => {
      if (this.modelIntents.size === 0) {
        if (this.modelIntentTimer) clearInterval(this.modelIntentTimer);
        this.modelIntentTimer = null;
        return;
      }
      for (const sessionId of [...this.modelIntents.keys()]) this.runModelIntent(sessionId);
    }, 15_000);
    this.modelIntentTimer.unref?.();
  }

  private appendWanLog(clientIp: string, line: string): void {
    const logPath = this.accessLogPath;
    if (!logPath || this.auth.isPrivateLanOrLocalIp(clientIp)) return;
    try {
      try {
        if (fs.statSync(logPath).size > 1_000_000) fs.renameSync(logPath, `${logPath}.1`);
      } catch {}
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${clientIp} ${line}\n`);
    } catch {}
  }

  // Records non-LAN requests (no query strings/tokens) to help diagnose WAN connectivity.
  private logWanAccess(req: http.IncomingMessage, res: http.ServerResponse, clientIp: string, pathname: string): void {
    if (!this.accessLogPath || this.auth.isPrivateLanOrLocalIp(clientIp)) return;
    const started = Date.now();
    res.on("finish", () => {
      const authed = this.auth.isAuthorized(req, false) ? "auth" : "anon";
      const ua = String(req.headers["user-agent"] || "").slice(0, 60);
      this.appendWanLog(clientIp, `${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ${authed} ${ua}`);
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        this.appendWanLog(clientIp, `${req.method} ${pathname} ABORTED by client after ${Date.now() - started}ms`);
      }
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method || "GET";
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;
    const clientIp = this.auth.getClientIp(req);
    const userAgent = String(req.headers["user-agent"] || "");
    this.logWanAccess(req, res, clientIp, pathname);

    // 1. Bot/Vulnerability Scanner Honeypot Trap (never blocks already-authenticated devices or static UI loads)
    const isAlreadyAuthed = this.auth.isAuthorized(req, this.allowLocalhostBypass);
    if (!isAlreadyAuthed && !this.auth.isLoopbackRequest(req)) {
      if (this.isBotScannerProbe(pathname, userAgent)) {
        this.auth.recordFailedAttempt(clientIp, 10, 60); // Instant 60-minute ban on exploit scanner probes
        res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
        res.end("Not Found");
        req.socket?.destroy();
        return;
      }
      if (pathname.startsWith("/api/") && pathname !== "/api/health" && this.auth.isIpBlocked(clientIp)) {
        this.sendJson(res, 429, { error: "Too many failed attempts. IP temporarily blocked." });
        return;
      }
    }

    if (pathname === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("User-agent: *\nDisallow: /\n");
      return;
    }

    // Set cookie automatically if valid ?token= query param (master token OR 6-digit MFA code) is provided on page navigation
    const queryToken = parsedUrl.searchParams.get("token");
    if (queryToken) {
      if (this.auth.isAuthorized(req, false)) {
        res.setHeader(
          "Set-Cookie",
          `ra_token=${encodeURIComponent(queryToken)}; Path=/; SameSite=Lax; Max-Age=2592000`
        );
      } else if (this.auth.verifyTotpCode(queryToken)) {
        const grant = this.auth.issueTempSession({
          label: "Paired Mobile / Web Device",
          clientIp,
          durationHours: 24 * 30,
        });
        res.setHeader(
          "Set-Cookie",
          `ra_token=${encodeURIComponent(grant.token)}; Path=/; SameSite=Lax; Max-Age=2592000`
        );
      }
    }

    // Public unauthenticated health check & static manifest/assets
    if (pathname === "/api/health") {
      this.sendJson(res, 200, {
        ok: true,
        authenticated: this.auth.isAuthorized(req, this.allowLocalhostBypass),
        desktopAppConnected: this.bridge.isConnected(),
        serverStartedAt: this.startedAt,
      });
      return;
    }

    if (pathname === "/api/auth/verify" && method === "POST") {
      if (this.auth.isIpBlocked(clientIp)) {
        this.sendJson(res, 429, { ok: false, error: "Too many failed attempts. Try again in 15 minutes." });
        return;
      }
      const body = await this.readJsonBody<{
        token?: string;
        durationHours?: number;
        label?: string;
      }>(req, 8 * 1024); // Strict 8KB body limit on unauthenticated auth endpoint
      const candidate = (body.token || "").trim();

      if (candidate && this.auth.isTokenStringAuthorized(candidate)) {
        this.auth.clearFailedAttempts(clientIp);
        this.sendJson(
          res,
          200,
          { ok: true, token: candidate, isTempSession: candidate !== this.auth.token },
          {
            "Set-Cookie": `ra_token=${encodeURIComponent(candidate)}; Path=/; SameSite=Lax; Max-Age=2592000`,
          }
        );
        return;
      }

      // Check if candidate is a 6-digit Rolling TOTP MFA code (from paired Android app or Authenticator app)
      if (candidate && this.auth.verifyTotpCode(candidate)) {
        this.auth.clearFailedAttempts(clientIp);
        const hours = Number(body.durationHours || 8);
        const defaultLabel = userAgent.includes("Windows")
          ? "Desktop (Windows)"
          : userAgent.includes("CrOS")
          ? "Chromebook"
          : userAgent.includes("Mac")
          ? "Mac"
          : "Web Session";
        const grant = this.auth.issueTempSession({
          label: body.label || defaultLabel,
          clientIp,
          durationHours: hours,
        });
        const maxAgeSec = Math.round(hours * 3600);
        this.sendJson(
          res,
          200,
          {
            ok: true,
            token: grant.token,
            expiresAt: grant.expiresAt,
            isTempSession: true,
          },
          {
            "Set-Cookie": `ra_token=${encodeURIComponent(grant.token)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`,
          }
        );
        return;
      }

      this.auth.recordFailedAttempt(clientIp, 1, 15);
      this.sendJson(res, 401, {
        ok: false,
        error: "Invalid 6-digit MFA code or pairing token",
      });
      return;
    }

    if (pathname === "/api/auth/request-approval" && method === "POST") {
      if (!this.auth.canRequestPhoneApproval(clientIp)) {
        this.sendJson(res, 429, { error: "Rate limit exceeded for phone approval requests." });
        return;
      }
      const body = await this.readJsonBody<{ label?: string; durationHours?: number }>(req, 8 * 1024);
      const defaultLabel = userAgent.includes("Windows")
        ? "Windows Desktop"
        : userAgent.includes("CrOS")
        ? "Chromebook"
        : userAgent.includes("Mac")
        ? "Mac"
        : "Remote Browser";
      const approval = this.auth.createLoginApprovalRequest({
        label: body.label || defaultLabel,
        clientIp,
        durationHours: body.durationHours || 8,
      });

      this.broadcast({
        type: "login_approval_request",
        request: {
          requestId: approval.requestId,
          matchCode: approval.matchCode,
          label: approval.label,
          clientIp: approval.clientIp,
          durationHours: approval.durationHours,
        },
      });

      this.sendJson(res, 200, {
        ok: true,
        requestId: approval.requestId,
        matchCode: approval.matchCode,
      });
      return;
    }

    if (pathname === "/api/auth/poll-approval" && method === "GET") {
      const requestId = parsedUrl.searchParams.get("requestId") || "";
      const item = this.auth.getLoginApprovalRequest(requestId);
      if (!item) {
        this.sendJson(res, 404, { status: "expired" });
        return;
      }
      if (item.status === "approved" && item.issuedToken) {
        const maxAgeSec = Math.round(item.durationHours * 3600);
        this.sendJson(
          res,
          200,
          {
            status: "approved",
            token: item.issuedToken,
            expiresAt: item.expiresAt,
          },
          {
            "Set-Cookie": `ra_token=${encodeURIComponent(item.issuedToken)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`,
          }
        );
        return;
      }
      this.sendJson(res, 200, { status: item.status });
      return;
    }

    // Protect all /api/* routes
    if (pathname.startsWith("/api/")) {
      if (!this.auth.isAuthorized(req, this.allowLocalhostBypass)) {
        this.sendJson(res, 401, {
          error: "Unauthorized. Enter your 6-digit MFA code, approve on your paired phone, or scan the QR code.",
        });
        return;
      }

      if (pathname === "/api/auth/resolve-approval" && method === "POST") {
        const body = await this.readJsonBody<{
          requestId?: string;
          approved?: boolean;
          durationHours?: number;
        }>(req);
        if (!body.requestId || typeof body.approved !== "boolean") {
          this.sendJson(res, 400, { error: "requestId and approved boolean are required" });
          return;
        }
        const resolved = this.auth.resolveLoginApprovalRequest(
          body.requestId,
          body.approved,
          body.durationHours
        );
        this.broadcast({
          type: "login_approval_resolved",
          requestId: body.requestId,
          status: resolved?.status || "expired",
        });
        this.sendJson(res, 200, { ok: Boolean(resolved), status: resolved?.status });
        return;
      }

      if (pathname === "/api/auth/revoke-temp" && method === "POST") {
        const body = await this.readJsonBody<{ id?: string }>(req);
        const ok = body.id ? this.auth.revokeTempSession(body.id) : false;
        this.sendJson(res, 200, { ok, tempSessions: this.auth.listTempSessions() });
        return;
      }

      if (pathname === "/api/status" && method === "GET") {
        const status = await this.getHostStatus();
        this.sendJson(res, 200, status);
        return;
      }

      if (pathname === "/api/pair-info" && method === "GET") {
        const actualPort = this.getPort();
        const { lanUrls, tailscaleUrls } = AuthManager.getNetworkUrls(actualPort);
        const wanStatus = this.wan.getStatus(tailscaleUrls);
        const lanBase = lanUrls[0] || `http://localhost:${actualPort}`;
        const wanBase = wanStatus.publicUrl || tailscaleUrls[0] || null;
        const primaryUrl = wanBase || lanBase;

        const qrDataUrl = await this.auth.generatePairingQrDataUrl(primaryUrl);
        const lanQrDataUrl = await this.auth.generatePairingQrDataUrl(lanBase);
        const wanQrDataUrl = wanBase
          ? await this.auth.generatePairingQrDataUrl(wanBase)
          : null;
        const apkUrl = `${lanBase}/download/RemoteAgent-android.apk?token=${encodeURIComponent(
          this.auth.token
        )}`;
        const apkQrDataUrl = await this.auth.generatePairingQrDataUrl(
          `${lanBase}/download/RemoteAgent-android.apk`
        );
        const totpInfo = this.auth.getCurrentTotpInfo();
        const otpauthUri = this.auth.getOtpAuthUri(os.hostname());
        const totpQrDataUrl = await this.auth.generateTotpQrDataUrl(os.hostname());

        this.sendJson(res, 200, {
          primaryUrl,
          lanBase,
          wanBase,
          pairUrl: `${primaryUrl}/?token=${encodeURIComponent(this.auth.token)}`,
          lanPairUrl: `${lanBase}/?token=${encodeURIComponent(this.auth.token)}`,
          wanPairUrl: wanBase ? `${wanBase}/?token=${encodeURIComponent(this.auth.token)}` : null,
          apkDownloadUrl: apkUrl,
          apkAvailable: fs.existsSync(path.join(RELEASES_DIR, "RemoteAgent-android.apk")),
          lanUrls,
          tailscaleUrls,
          wan: wanStatus,
          token: this.auth.token,
          qrDataUrl,
          lanQrDataUrl,
          wanQrDataUrl,
          apkQrDataUrl,
          mfa: {
            code: totpInfo.code,
            secondsRemaining: totpInfo.secondsRemaining,
            otpauthUri,
            totpQrDataUrl,
            tempSessions: this.auth.listTempSessions(),
          },
        });
        return;
      }

      if (pathname === "/api/wan/status" && method === "GET") {
        const { tailscaleUrls } = AuthManager.getNetworkUrls(this.getPort());
        this.sendJson(res, 200, { wan: this.wan.getStatus(tailscaleUrls) });
        return;
      }

      if (pathname === "/api/wan/start" && method === "POST") {
        const body = await this.readJsonBody<{ persistAutoStart?: boolean }>(req);
        const wanStatus = await this.wan.startTunnel({
          persistAutoStart: body.persistAutoStart ?? true,
        });
        this.sendJson(res, 200, { ok: true, wan: wanStatus });
        return;
      }

      if (pathname === "/api/wan/stop" && method === "POST") {
        const wanStatus = this.wan.stopTunnel(true);
        this.sendJson(res, 200, { ok: true, wan: wanStatus });
        return;
      }

      if (pathname === "/api/wan/custom-url" && method === "POST") {
        const body = await this.readJsonBody<{ url?: string | null }>(req);
        const wanStatus = this.wan.setCustomWanUrl(body.url || null);
        this.sendJson(res, 200, { ok: true, wan: wanStatus });
        return;
      }

      if (pathname === "/api/auth/rotate" && method === "POST") {
        const newToken = this.auth.rotateToken();
        this.sendJson(res, 200, { ok: true, token: newToken });
        return;
      }

      if (pathname === "/api/peers" && method === "GET") {
        this.sendJson(res, 200, { peers: this.store.listPeerHosts() });
        return;
      }

      if (pathname === "/api/ui-prefs" && method === "GET") {
        this.sendJson(res, 200, { uiPrefs: this.store.getUiPreferences() });
        return;
      }

      if (pathname === "/api/ui-prefs" && method === "POST") {
        const body = await this.readJsonBody<{
          pinnedSessionIds?: string[];
          sessionOrderIds?: string[];
          groupBy?: "project" | "flat" | "status";
          sortBy?: "custom" | "recent" | "title";
        }>(req, 64 * 1024);
        const uiPrefs = this.store.saveUiPreferences(body);
        this.broadcast({ type: "ui_prefs_updated", uiPrefs });
        this.sendJson(res, 200, { ok: true, uiPrefs });
        return;
      }

      // Transparent LAN-to-WAN Peer Hub Reverse Proxy:
      // Allows a single WAN-exposed desktop (e.g. port 4321) to proxy API & artifact requests
      // to any additional desktop/server on the same local network without needing extra router port-forwards!
      const peerProxyMatch = pathname.match(/^\/api\/peer-proxy\/([^/]+)(\/.*)$/);
      if (peerProxyMatch) {
        const peerId = decodeURIComponent(peerProxyMatch[1]);
        const targetSubPath = peerProxyMatch[2] || "/api/status";
        const peer = this.store.listPeerHosts().find((p) => p.id === peerId || p.name.toLowerCase() === peerId.toLowerCase());
        if (!peer) {
          this.sendJson(res, 404, { error: `Peer desktop '${peerId}' not found` });
          return;
        }

        const baseTarget = (peer.lanUrl || peer.wanUrl || "").replace(/\/+$/, "");
        const forwardSearch = new URLSearchParams(parsedUrl.searchParams);
        forwardSearch.delete("token");
        const qs = forwardSearch.toString();
        const targetUrl = `${baseTarget}${targetSubPath}${qs ? `?${qs}` : ""}`;

        try {
          const headers: Record<string, string> = {};
          if (peer.token) {
            headers["Authorization"] = `Bearer ${peer.token}`;
          }
          if (req.headers["content-type"]) {
            headers["Content-Type"] = String(req.headers["content-type"]);
          }

          let rawBody: Buffer | undefined;
          if (method !== "GET" && method !== "HEAD") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            rawBody = Buffer.concat(chunks);
          }

          const upstreamRes = await fetch(targetUrl, {
            method,
            headers,
            body: rawBody ? (rawBody as any) : undefined,
          });

          const contentType = upstreamRes.headers.get("content-type") || "application/json";
          const buf = Buffer.from(await upstreamRes.arrayBuffer());
          res.writeHead(upstreamRes.status, {
            "Content-Type": contentType,
            "Content-Length": buf.length,
            "Cache-Control": "no-cache",
          });
          res.end(buf);
        } catch (err) {
          this.sendJson(res, 502, {
            error: `Failed to reach peer desktop '${peer.name}' at ${baseTarget}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      if (pathname === "/api/desktop-apps/launch" && method === "POST") {
        const body = await this.readJsonBody<{ app?: string }>(req);
        if (!body.app) {
          this.sendJson(res, 400, { error: "app id is required" });
          return;
        }
        const result = this.store.launchDesktopApp(body.app);
        this.sendJson(res, result.ok ? 200 : 404, result);
        return;
      }

      if (pathname === "/api/peers" && method === "POST") {
        const body = await this.readJsonBody<{
          id?: string;
          name?: string;
          pairingUrl?: string;
          lanUrl?: string;
          wanUrl?: string;
          token?: string;
          accountLogin?: string;
          noReciprocal?: boolean;
        }>(req);

        let rawUrl = (body.pairingUrl || body.lanUrl || body.wanUrl || "").trim();
        let peerToken = (body.token || "").trim();
        if (rawUrl.includes("?token=")) {
          const [basePart, queryPart] = rawUrl.split("?token=");
          rawUrl = basePart.replace(/\/+$/, "");
          if (!peerToken && queryPart) {
            peerToken = decodeURIComponent(queryPart.split("&")[0]);
          }
        }
        rawUrl = rawUrl.replace(/\/+$/, "");

        if (!rawUrl) {
          this.sendJson(res, 400, { error: "pairingUrl, lanUrl, or wanUrl is required" });
          return;
        }

        let discoveredName = (body.name || "").trim();
        let discoveredLan = (body.lanUrl || rawUrl).replace(/\?.*$/, "").replace(/\/+$/, "");
        let discoveredWan = (body.wanUrl || (rawUrl.startsWith("https://") ? rawUrl : "")).replace(/\?.*$/, "").replace(/\/+$/, "");
        let discoveredAccount = (body.accountLogin || "").trim();

        // Probe the remote machine to auto-discover its hostname, @account, LAN URL, and WAN URL
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          const headers: Record<string, string> = peerToken ? { Authorization: `Bearer ${peerToken}` } : {};
          const statusRes = await fetch(`${rawUrl}/api/status`, { headers, signal: controller.signal });
          if (statusRes.ok) {
            const st = (await statusRes.json()) as Record<string, any>;
            if (!discoveredName && st.hostname) discoveredName = String(st.hostname);
            if (!discoveredAccount && st.primaryAccount) discoveredAccount = String(st.primaryAccount);
            if (Array.isArray(st.lanUrls) && st.lanUrls[0]) discoveredLan = String(st.lanUrls[0]);
            if (st.wan?.publicUrl) discoveredWan = String(st.wan.publicUrl);
          }
          clearTimeout(timer);

          // Automatically register THIS machine back on the peer so switching works both ways!
          if (!body.noReciprocal) {
            const actualPort = this.getPort();
            const { lanUrls, tailscaleUrls } = AuthManager.getNetworkUrls(actualPort);
            const myWan = this.wan.getStatus(tailscaleUrls).publicUrl || undefined;
            const myLan = lanUrls[0] || `http://${os.hostname()}:${actualPort}`;
            const myAccounts = this.store.getGitHubAccounts();
            const myPrimary = myAccounts.find((a) => a.isDefault)?.login || myAccounts[0]?.login;
            await fetch(`${rawUrl}/api/peers`, {
              method: "POST",
              headers: {
                ...headers,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                name: os.hostname(),
                lanUrl: myLan,
                wanUrl: myWan,
                token: this.auth.token,
                accountLogin: myPrimary,
                noReciprocal: true,
              }),
            }).catch(() => {});
          }
        } catch {
          // Offline or unreachable right now; save with provided fields
        }

        const peers = this.store.upsertPeerHost({
          id: body.id,
          name: discoveredName || "Desktop Host",
          lanUrl: discoveredLan || rawUrl,
          wanUrl: discoveredWan || undefined,
          token: peerToken || undefined,
          accountLogin: discoveredAccount || undefined,
        });
        this.sendJson(res, 200, { ok: true, peers });
        return;
      }

      const peerDeleteMatch = pathname.match(/^\/api\/peers\/([^/]+)$/);
      if (peerDeleteMatch && method === "DELETE") {
        const peerId = decodeURIComponent(peerDeleteMatch[1]);
        const peers = this.store.removePeerHost(peerId);
        this.sendJson(res, 200, { ok: true, peers });
        return;
      }

      if (pathname === "/api/models" && method === "GET") {
        this.sendJson(res, 200, await this.getModelCatalog(parsedUrl.searchParams.get("refresh") === "1"));
        return;
      }

      if (pathname === "/api/sessions" && method === "GET") {
        const sessions = this.store.listSessions(this.bridge.getLiveWorkspaces());
        this.sendJson(res, 200, { sessions });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const subRoute = sessionMatch[2] || "";

        if (!subRoute && method === "GET") {
          const allSessions = this.store.listSessions(this.bridge.getLiveWorkspaces());
          const summary = allSessions.find((s) => s.id === sessionId) || {
            id: sessionId,
            workspaceId: sessionId,
            title: `Session ${sessionId.slice(0, 8)}`,
            sessionType: "project" as const,
            isRunning: false,
            activityStatus: "idle" as const,
            mode: "interactive" as const,
            model: "auto",
            modelUnset: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            counts: { turns: 0, artifacts: 0, images: 0, models3d: 0, todos: 0, todosDone: 0 },
          };

          const details = this.store.getSessionConversationAndArtifacts(sessionId, summary.cwd);
          const todos = this.store.getSessionTodos(sessionId);
          const reviews = this.store.listReviewComments(sessionId);
          const streaming = this.bridge.getStreamingState(sessionId);

          // Reconcile pending steering messages against admitted user turns in events.jsonl
          const userTurns = details.turns.filter((t) => t.role === "user");
          const latestUserTurnMs =
            userTurns.length > 0
              ? new Date(userTurns[userTurns.length - 1].timestamp).getTime()
              : 0;
          const currentSteering = (this.pendingSteering.get(sessionId) || []).filter((item) => {
            const itemMs = new Date(item.createdAt).getTime();
            if (Date.now() - itemMs > 30 * 60 * 1000) return false;
            const matchedInTurns = userTurns.some(
              (ut) =>
                ut.content.includes(item.prompt) &&
                new Date(ut.timestamp).getTime() >= itemMs - 5000
            );
            if (matchedInTurns || latestUserTurnMs > itemMs + 2000) {
              return false;
            }
            return true;
          });
          this.pendingSteering.set(sessionId, currentSteering);

          summary.awaitingUserInput =
            details.awaitingUserInput &&
            !this.resolvedRequestIds.has(details.awaitingUserInput.requestId)
              ? details.awaitingUserInput
              : null;
          summary.awaitingPlanApproval =
            details.awaitingPlanApproval &&
            !this.resolvedRequestIds.has(details.awaitingPlanApproval.requestId)
              ? details.awaitingPlanApproval
              : null;
          summary.awaitingPermission = details.awaitingPermission;
          // Sessions without a listed model (never switched, or older than the list) use what the
          // runtime recorded; "auto" can be a real selection, so listed models are kept. The event log is
          // only read when needed, and display may reuse a recent read since busy logs change constantly.
          const liveTier = summary.model === "auto" ? this.bridge.getSessionAutoTier(sessionId) : undefined;
          if (summary.modelUnset || (summary.model === "auto" && !liveTier)) {
            const applied = this.appliedModelSelection(sessionId, 15_000);
            if (summary.modelUnset && applied?.model) {
              summary.model = applied.model;
              summary.reasoningEffort = applied.reasoningEffort;
              summary.contextTier = applied.contextTier;
            } else if (summary.modelUnset && details.selectedModel) {
              summary.model = details.selectedModel;
            }
            if (summary.model === "auto") summary.autoTier = applied?.autoTier || details.autoTier;
          } else if (liveTier) {
            summary.autoTier = liveTier;
          }
          // The newest choice still waiting for the session's turn to end is what it runs next.
          const pendingModel = this.activeModelIntent(sessionId) ?? this.bridge.getQueuedSelection(sessionId);
          if (pendingModel) summary.pendingModel = pendingModel;
          if (details.sessionCwd && !summary.cwd) {
            summary.cwd = details.sessionCwd;
          }
          summary.counts = {
            turns: details.turns.length,
            artifacts: details.artifacts.length,
            images: details.artifacts.filter((a) => a.category === "image").length,
            models3d: details.artifacts.filter((a) => a.category === "3d").length,
            todos: todos.length,
            todosDone: todos.filter((t) => t.status === "done").length,
            subAgents: details.subAgents.length,
            runningSubAgents: details.subAgents.filter((sa) => sa.status === "running").length,
          };

          this.sendJson(res, 200, {
            session: summary,
            turns: details.turns,
            artifacts: details.artifacts,
            subAgents: details.subAgents,
            detachedShells: details.detachedShells,
            todos,
            reviews,
            streaming,
            pendingSteering: currentSteering,
          });
          return;
        }

        if (subRoute === "diff" && method === "GET") {
          const allSessions = this.store.listSessions(this.bridge.getLiveWorkspaces());
          const summary = allSessions.find((s) => s.id === sessionId);
          const details = this.store.getSessionConversationAndArtifacts(sessionId, summary?.cwd);
          const diff = await this.store.getWorkspaceGitDiff(summary?.cwd || details.sessionCwd);
          this.sendJson(res, 200, { diff });
          return;
        }

        if (subRoute === "artifact" && method === "GET") {
          const targetPath = parsedUrl.searchParams.get("path") || "";
          const allowedPath = this.store.resolveAllowedArtifactPath(sessionId, targetPath);
          if (!allowedPath) {
            this.sendJson(res, 404, { error: "Artifact not found or outside allowed workspace paths" });
            return;
          }

          const stat = fs.statSync(allowedPath);
          const ext = path.extname(allowedPath).toLowerCase();
          const mimeMap: Record<string, string> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".svg": "image/svg+xml",
            ".bmp": "image/bmp",
            ".stl": "model/stl",
            ".obj": "model/obj",
            ".apk": "application/vnd.android.package-archive",
            ".exe": "application/vnd.microsoft.portable-executable",
            ".zip": "application/zip",
            ".pdf": "application/pdf",
            ".md": "text/markdown; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".txt": "text/plain; charset=utf-8",
            ".log": "text/plain; charset=utf-8",
            ".csv": "text/csv; charset=utf-8",
            ".py": "text/plain; charset=utf-8",
            ".ts": "text/plain; charset=utf-8",
            ".js": "text/plain; charset=utf-8",
            ".patch": "text/plain; charset=utf-8",
          };
          const contentType = mimeMap[ext] || "application/octet-stream";
          const isDownloadableBinary = [".apk", ".aab", ".exe", ".zip", ".f3d", ".3mf", ".step", ".stp"].includes(ext) || parsedUrl.searchParams.get("download") === "1";
          const headers: Record<string, string | number> = {
            "Content-Type": contentType,
            "Content-Length": stat.size,
            "Cache-Control": "no-cache",
          };
          if (isDownloadableBinary) {
            headers["Content-Disposition"] = `attachment; filename="${path.basename(allowedPath)}"`;
          }

          res.writeHead(200, headers);
          fs.createReadStream(allowedPath).pipe(res);
          return;
        }

        if (subRoute === "message" && method === "POST") {
          const body = await this.readJsonBody<{
            prompt?: string;
            deliveryMode?: DeliveryMode;
            mode?: SessionMode;
            attachments?: Array<{ name: string; dataBase64: string }>;
            attachmentPaths?: string[];
          }>(req);

          const prompt = (body.prompt || "").trim();
          if (!prompt) {
            this.sendJson(res, 400, { error: "Prompt is required" });
            return;
          }

          const attachmentPaths: string[] = [...(body.attachmentPaths || [])];
          const savedAttachments: Array<{ name: string; url: string }> = [];
          if (Array.isArray(body.attachments)) {
            for (const att of body.attachments) {
              if (att.dataBase64) {
                const saved = this.store.saveUploadedAttachment(
                  sessionId,
                  att.name || "mobile-upload.png",
                  att.dataBase64
                );
                attachmentPaths.push(saved);
                savedAttachments.push({
                  name: att.name || path.basename(saved),
                  url: `/api/sessions/${encodeURIComponent(sessionId)}/artifact?path=${encodeURIComponent(saved)}`,
                });
              }
            }
          }

          const steeringItem = {
            id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            prompt,
            deliveryMode: (body.deliveryMode || "immediate") as DeliveryMode,
            attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
            createdAt: new Date().toISOString(),
          };
          const existingQueue = this.pendingSteering.get(sessionId) || [];
          existingQueue.push(steeringItem);
          this.pendingSteering.set(sessionId, existingQueue);
          this.broadcast({
            type: "steering_queued",
            sessionId,
            steeringItem,
          });

          if (this.bridge.isConnected()) {
            const result = await this.bridge.sendMessage({
              sessionId,
              prompt,
              deliveryMode: body.deliveryMode || "immediate",
              mode: body.mode,
              attachmentPaths,
            });
            this.sendJson(res, 200, {
              ok: true,
              method: result.method,
              attachmentPaths,
              steeringItem,
            });
            return;
          }

          // Fallback to @github/copilot-sdk when Desktop App is not running
          const allSessions = this.store.listSessions();
          const summary = allSessions.find((s) => s.id === sessionId);
          const sdkResult = await this.sdk.resumeAndSend({
            sessionId,
            prompt,
            cwd: summary?.cwd,
            attachmentPaths,
            onEvent: (event) => {
              this.broadcast({
                type: "session_event",
                sessionId,
                event,
              });
            },
          });

          this.sendJson(res, 200, {
            ok: true,
            method: sdkResult.method,
            messageId: sdkResult.messageId,
            attachmentPaths,
          });
          return;
        }

        if (subRoute === "respond-input" && method === "POST") {
          const body = await this.readJsonBody<{
            requestId: string;
            answer: string;
            wasFreeform?: boolean;
          }>(req);
          if (!body.requestId || typeof body.answer !== "string") {
            this.sendJson(res, 400, { error: "requestId and answer are required" });
            return;
          }
          this.resolvedRequestIds.add(body.requestId);

          const steeringItem = {
            id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            prompt: body.answer,
            deliveryMode: "immediate" as DeliveryMode,
            createdAt: new Date().toISOString(),
          };
          const existingQueue = this.pendingSteering.get(sessionId) || [];
          existingQueue.push(steeringItem);
          this.pendingSteering.set(sessionId, existingQueue);
          this.broadcast({
            type: "steering_queued",
            sessionId,
            steeringItem,
          });

          const allSessions = this.store.listSessions(this.bridge.getLiveWorkspaces());
          const summary = allSessions.find((s) => s.id === sessionId);

          let ok = this.bridge.respondToUserInput({
            sessionId,
            requestId: body.requestId,
            answer: body.answer,
            wasFreeform: body.wasFreeform,
          });

          // If the session was interrupted/idle when ask_user was left open, respond_to_user_input
          // alone won't wake a dead CLI turn — also dispatch send_message so the session resumes with the answer!
          if (!summary?.isRunning && this.bridge.isConnected()) {
            await this.bridge.sendMessage({
              sessionId,
              prompt: body.answer,
              deliveryMode: "immediate",
            });
            ok = true;
          }

          this.sendJson(res, 200, { ok, steeringItem });
          return;
        }

        if (subRoute === "respond-plan" && method === "POST") {
          const body = await this.readJsonBody<{
            requestId: string;
            approved: boolean;
            feedback?: string;
            selectedAction?: string;
          }>(req);
          if (!body.requestId || typeof body.approved !== "boolean") {
            this.sendJson(res, 400, { error: "requestId and approved boolean are required" });
            return;
          }
          this.resolvedRequestIds.add(body.requestId);
          const allSessions = this.store.listSessions(this.bridge.getLiveWorkspaces());
          const summary = allSessions.find((s) => s.id === sessionId);

          let ok = this.bridge.respondToPlanApproval({
            sessionId,
            requestId: body.requestId,
            approved: body.approved,
            feedback: body.feedback,
            selectedAction: body.selectedAction,
          });

          if (!summary?.isRunning && this.bridge.isConnected()) {
            const promptText = body.approved
              ? "Approved. Please proceed with the plan."
              : body.feedback || "Please revise the plan.";
            await this.bridge.sendMessage({
              sessionId,
              prompt: promptText,
              deliveryMode: "immediate",
            });
            ok = true;
          }

          this.sendJson(res, 200, { ok });
          return;
        }

        if (subRoute === "respond-permission" && method === "POST") {
          const body = await this.readJsonBody<{
            requestId: string;
            approved: boolean;
          }>(req);
          const ok = this.bridge.respondToPermission({
            sessionId,
            requestId: body.requestId,
            approved: Boolean(body.approved),
          });
          this.sendJson(res, 200, { ok });
          return;
        }

        if (subRoute === "models" && method === "GET") {
          this.sendJson(
            res,
            200,
            await this.getSessionModelCatalog(sessionId, parsedUrl.searchParams.get("refresh") === "1")
          );
          return;
        }

        if (subRoute === "mode" && method === "POST") {
          const body = await this.readJsonBody<{ mode: SessionMode }>(req);
          if (!["interactive", "plan", "autopilot"].includes(body.mode)) {
            this.sendJson(res, 400, { error: "Invalid mode" });
            return;
          }
          const ok = this.bridge.setSessionMode(sessionId, body.mode);
          this.store.updateSessionConfigInDb(sessionId, { mode: body.mode });
          this.store.invalidateSessionsList();
          this.broadcast({ type: "sessions_updated", timestamp: new Date().toISOString() });
          this.sendJson(res, 200, { ok, mode: body.mode });
          return;
        }

        if (subRoute === "config" && method === "POST") {
          const body = await this.readJsonBody<
            ModelSelection & {
              mode?: SessionMode;
            }
          >(req);

          if (body.mode && ["interactive", "plan", "autopilot"].includes(body.mode)) {
            this.bridge.setSessionMode(sessionId, body.mode);
            this.store.updateSessionConfigInDb(sessionId, { mode: body.mode });
            this.store.invalidateSessionsList();
          }

          const patch: ModelSelection = {
            model: body.model || undefined,
            reasoningEffort: body.reasoningEffort || undefined,
            contextTier: body.contextTier || undefined,
            autoTier: body.autoTier || undefined,
          };
          if (!patch.model && !patch.reasoningEffort && !patch.contextTier && !patch.autoTier) {
            this.broadcast({ type: "sessions_updated", timestamp: new Date().toISOString() });
            this.sendJson(res, 200, { ok: true, mode: body.mode });
            return;
          }
          if (!this.bridge.isConnected()) {
            this.sendJson(res, 503, {
              error: "The desktop Copilot app isn't connected, so the model can't be changed right now.",
            });
            return;
          }

          const before = this.currentModelChoice(sessionId);
          if (!before?.model) {
            this.sendJson(res, 404, {
              error: "The desktop Copilot app has no model recorded for this session, so it can't be changed from here.",
            });
            return;
          }
          let catalog: ModelCatalog;
          try {
            // Auto levels must come from the session itself; an unloaded session is loaded to ask it.
            catalog =
              (patch.model || before.model) === "auto"
                ? await this.getVerifiedSessionModelCatalog(sessionId)
                : await this.getSessionModelCatalog(sessionId);
          } catch (err) {
            this.sendJson(res, ...describeModelSwitchError(sessionId, patch.model || "auto", err));
            return;
          }
          // Choices build on the newest one still waiting for the session's turn to end. Read it again:
          // the turn may have ended (and a held choice run) while the catalog loaded.
          const current = this.currentModelChoice(sessionId) ?? before;
          const resolved = resolveModelSelection(catalog, current, patch);
          if (!resolved.ok) {
            this.sendJson(res, 400, { error: resolved.error });
            return;
          }

          // Skip no-ops: they would only add a model change to the session's history.
          const sel = resolved.selection;
          if (sameModelSelection(current, sel)) {
            this.sendJson(res, 200, {
              ok: true,
              ...sel,
              adjustments: resolved.adjustments,
              unchanged: true,
              queued: Boolean(this.activeModelIntent(sessionId) || this.bridge.getQueuedSelection(sessionId)),
              mode: body.mode,
            });
            return;
          }

          try {
            // The desktop app validates, applies, and persists the selection, or explains why it can't.
            const outcome = await this.applyModelSelection(sessionId, sel, catalog);
            this.afterModelChange();
            this.sendJson(res, 200, {
              ok: true,
              ...outcome.selection,
              queued: outcome.queued,
              adjustments: [...resolved.adjustments, ...outcome.notes],
              mode: body.mode,
            });
          } catch (err) {
            this.afterModelChange();
            this.sendJson(res, ...describeModelSwitchError(sessionId, sel.model, err));
          }
          return;
        }

        if (subRoute === "abort" && method === "POST") {
          const ok = this.bridge.abortSession(sessionId);
          this.sendJson(res, 200, { ok });
          return;
        }

        if (subRoute === "reviews" && method === "GET") {
          const reviews = this.store.listReviewComments(sessionId);
          this.sendJson(res, 200, { reviews });
          return;
        }

        if (subRoute === "reviews" && method === "POST") {
          const body = await this.readJsonBody<{
            targetType?: "artifact" | "diff" | "general";
            targetPath?: string;
            lineStart?: number;
            lineEnd?: number;
            comment?: string;
            annotatedImageBase64?: string;
            syncToDesktopDiff?: boolean;
          }>(req);

          const commentText = (body.comment || "").trim();
          if (!commentText) {
            this.sendJson(res, 400, { error: "Comment text is required" });
            return;
          }

          const created = this.store.addReviewComment({
            sessionId,
            targetType: body.targetType || "general",
            targetPath: body.targetPath,
            lineStart: body.lineStart,
            lineEnd: body.lineEnd,
            comment: commentText,
            annotatedImageBase64: body.annotatedImageBase64,
          });

          if (body.syncToDesktopDiff && body.targetPath && this.bridge.isConnected()) {
            this.bridge.saveInlineReviewComment({
              workspaceId: sessionId,
              filePath: body.targetPath,
              lineStart: body.lineStart || 1,
              lineEnd: body.lineEnd || body.lineStart || 1,
              text: commentText,
            });
          }

          this.sendJson(res, 201, { review: created });
          return;
        }

        const deleteReviewMatch = subRoute.match(/^reviews\/([^/]+)$/);
        if (deleteReviewMatch && method === "DELETE") {
          const commentId = decodeURIComponent(deleteReviewMatch[1]);
          const deleted = this.store.deleteReviewComment(sessionId, commentId);
          this.sendJson(res, 200, { ok: deleted });
          return;
        }

        if (subRoute === "reviews/dispatch" && method === "POST") {
          const body = await this.readJsonBody<{
            additionalNote?: string;
            deliveryMode?: DeliveryMode;
          }>(req);

          const queued = this.store
            .listReviewComments(sessionId)
            .filter((r) => r.status === "queued");

          if (queued.length === 0 && !body.additionalNote?.trim()) {
            this.sendJson(res, 400, { error: "No queued review comments to dispatch" });
            return;
          }

          const lines: string[] = [];
          if (body.additionalNote?.trim()) {
            lines.push(body.additionalNote.trim(), "");
          }
          if (queued.length > 0) {
            lines.push("### Mobile Review Feedback & Annotations:");
            queued.forEach((item, idx) => {
              const loc = item.targetPath
                ? item.lineStart
                  ? ` (\`${item.targetPath}\` lines ${item.lineStart}${item.lineEnd && item.lineEnd !== item.lineStart ? `-${item.lineEnd}` : ""})`
                  : ` (\`${item.targetPath}\`)`
                : "";
              lines.push(`${idx + 1}. **[${item.targetType.toUpperCase()}]**${loc}: ${item.comment}`);
            });
          }

          const attachmentPaths = queued
            .map((q) => q.annotatedImageLocalPath)
            .filter((p): p is string => Boolean(p));

          const combinedPrompt = lines.join("\n");

          if (this.bridge.isConnected()) {
            await this.bridge.sendMessage({
              sessionId,
              prompt: combinedPrompt,
              deliveryMode: body.deliveryMode || "immediate",
              attachmentPaths,
            });
          } else {
            const allSessions = this.store.listSessions();
            const summary = allSessions.find((s) => s.id === sessionId);
            await this.sdk.resumeAndSend({
              sessionId,
              prompt: combinedPrompt,
              cwd: summary?.cwd,
              attachmentPaths,
            });
          }

          this.store.markReviewsSent(
            sessionId,
            queued.map((q) => q.id)
          );

          this.sendJson(res, 200, {
            ok: true,
            dispatchedCount: queued.length,
            prompt: combinedPrompt,
          });
          return;
        }
      }

      this.sendJson(res, 404, { error: `Unknown API endpoint: ${method} ${pathname}` });
      return;
    }

    // Quick local mobile install & 1-tap auto-pair page (/install and /apk). The pre-paired APK embeds the
    // pairing token, so it is only served to authenticated clients or directly on the private LAN.
    const isTrustedInstallClient =
      this.auth.isAuthorized(req, this.allowLocalhostBypass) ||
      (this.allowLocalhostBypass && this.auth.isPrivateLanOrLocalIp(clientIp));

    if (pathname === "/apk") {
      if (!isTrustedInstallClient) {
        this.sendJson(res, 401, { error: "Open /apk from your home Wi-Fi or a paired device." });
        return;
      }
      const pairedApk = path.join(os.homedir(), ".copilot", "RemoteAgent-paired.apk");
      const fallbackApk = path.join(RELEASES_DIR, "RemoteAgent-android.apk");
      const targetApk =
        fs.existsSync(pairedApk) && fs.statSync(pairedApk).isFile() ? pairedApk : fallbackApk;
      if (!fs.existsSync(targetApk) || !fs.statSync(targetApk).isFile()) {
        this.sendJson(res, 404, { error: "Android APK not found" });
        return;
      }
      const stat = fs.statSync(targetApk);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Length": stat.size,
        "Content-Disposition": 'attachment; filename="RemoteAgent-android.apk"',
        "Cache-Control": "no-store",
      });
      fs.createReadStream(targetApk).pipe(res);
      return;
    }

    if (pathname === "/install" && isTrustedInstallClient) {
      const actualPort = this.getPort();
      const { lanUrls, tailscaleUrls } = AuthManager.getNetworkUrls(actualPort);
      const wanStatus = this.wan.getStatus(tailscaleUrls);
      const lanBase = lanUrls[0] || `http://${req.headers.host || "localhost:4321"}`;
      const wanBase = wanStatus.publicUrl || tailscaleUrls[0] || "";
      const tok = this.auth.token;
      const deepLink = `remoteagent://pair?lan=${encodeURIComponent(lanBase)}&wan=${encodeURIComponent(
        wanBase
      )}&token=${encodeURIComponent(tok)}`;
      const webLink = `/?token=${encodeURIComponent(tok)}`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Install Copilot Remote Agent</title><style>body{margin:0;padding:24px 16px;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}.card{max-width:460px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:14px;padding:22px 18px;}h2{margin:0 0 8px;font-size:20px;}p{margin:0 0 18px;font-size:13.5px;color:#8b949e;line-height:1.45;}a.btn{display:block;text-decoration:none;text-align:center;padding:13px 16px;border-radius:10px;font-weight:600;font-size:14.5px;margin-bottom:12px;}.btn-green{background:#238636;color:#fff;}.btn-blue{background:#1f6feb;color:#fff;}.btn-sec{background:#21262d;color:#e6edf3;border:1px solid #30363d;}.meta{font-size:11.5px;color:#8b949e;margin-top:14px;word-break:break-all;}</style></head><body><div class="card"><h2>Copilot Remote Agent</h2><p>Download the pre-paired Android APK or tap below to auto-configure your installed app.</p><a class="btn btn-green" href="/apk">⬇ Download Pre-Paired Android APK</a><a class="btn btn-blue" href="${deepLink}">⚡ 1-Tap Auto-Pair Installed App</a><a class="btn btn-sec" href="${webLink}">🌐 Open Web Companion in Browser</a><div class="meta">LAN: ${lanBase}${
        wanBase ? `<br/>WAN: ${wanBase}` : ""
      }</div></div></body></html>`;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    // Serve downloadable Android APK & Windows Desktop Installer under /download/*
    if (pathname.startsWith("/download/")) {
      if (!isTrustedInstallClient) {
        this.sendJson(res, 401, { error: "Unauthorized download request" });
        return;
      }
      const fileName = path.basename(pathname);
      const pairedApk = path.join(os.homedir(), ".copilot", "RemoteAgent-paired.apk");
      const releaseFile =
        fileName === "RemoteAgent-android.apk" &&
        fs.existsSync(pairedApk) &&
        fs.statSync(pairedApk).isFile()
          ? pairedApk
          : path.join(RELEASES_DIR, fileName);
      if (!fs.existsSync(releaseFile) || !fs.statSync(releaseFile).isFile()) {
        this.sendJson(res, 404, { error: `Release binary ${fileName} not found` });
        return;
      }
      const stat = fs.statSync(releaseFile);
      const contentType = fileName.endsWith(".apk")
        ? "application/vnd.android.package-archive"
        : "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(releaseFile).pipe(res);
      return;
    }

    // Serve static PWA files from src/public
    let staticRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (staticRel.includes("..")) {
      this.sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    const staticPath = path.join(PUBLIC_DIR, staticRel);
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      if (ext === ".html") {
        const uiVer = this.getUiVersion();
        const htmlRaw = fs
          .readFileSync(staticPath, "utf8")
          .replace('href="/styles.css"', `href="/styles.css?v=${uiVer}"`)
          .replace('src="/app.js"', `src="/app.js?v=${uiVer}"`);
        this.sendCompressible(req, res, Buffer.from(htmlRaw, "utf8"), {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        return;
      }
      // Versioned asset URLs (?v=<uiVersion>) change whenever the file changes, so they are safe to cache.
      const versioned = parsedUrl.searchParams.get("v") === this.getUiVersion();
      this.sendCompressible(req, res, fs.readFileSync(staticPath), {
        "Content-Type": mimeMap[ext] || "application/octet-stream",
        "Cache-Control": versioned ? "private, max-age=604800, immutable" : "no-store, no-cache, must-revalidate",
      });
      return;
    }

    // Only serve SPA fallback on root "/" or "/pair" — return 404 for unknown scanner paths
    if (pathname === "/" || pathname === "/pair") {
      const indexHtml = path.join(PUBLIC_DIR, "index.html");
      if (fs.existsSync(indexHtml)) {
        const uiVer = this.getUiVersion();
        const htmlRaw = fs
          .readFileSync(indexHtml, "utf8")
          .replace('href="/styles.css"', `href="/styles.css?v=${uiVer}"`)
          .replace('src="/app.js"', `src="/app.js?v=${uiVer}"`);
        this.sendCompressible(req, res, Buffer.from(htmlRaw, "utf8"), {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Frame-Options": "DENY",
        });
        return;
      }
    }

    this.sendJson(res, 404, { error: "Not found" });
  }
}

// Direct CLI execution entrypoint
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase();

if (isMain) {
  enableFileLogging();
  process.on("uncaughtException", (err) => {
    logEvent("error", "uncaught exception; exiting so the supervisor restarts cleanly", describeError(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logEvent("warn", "unhandled promise rejection", describeError(reason));
  });

  const server = new RemoteAgentServer();
  server
    .start()
    .then(async (info) => {
      logEvent("info", "server started", { pid: process.pid, port: info.port, log: getLogFilePath() });

      // Record event-loop stalls and memory so intermittent disconnects can be diagnosed afterwards.
      let lastTick = Date.now();
      setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - 1000;
        lastTick = now;
        if (lag > 1500) logEvent("warn", "event loop stalled", { lagMs: lag });
      }, 1000).unref();
      setInterval(() => {
        const mem = process.memoryUsage();
        logEvent("info", "health", {
          rssMB: Math.round(mem.rss / 1048576),
          heapMB: Math.round(mem.heapUsed / 1048576),
        });
      }, 10 * 60_000).unref();

      const shutdown = (signal: string) => {
        logEvent("info", "server stopping", { signal });
        server
          .stop()
          .catch(() => {})
          .finally(() => process.exit(0));
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));

      const primaryUrl = info.lanUrls[0] || info.tailscaleUrls[0] || `http://localhost:${info.port}`;
      const pairUrl = `${primaryUrl}/?token=${encodeURIComponent(info.token)}`;
      console.log("\n==============================================================");
      console.log("  🚀 Remote Agent — Desktop GitHub Copilot Mobile Companion");
      console.log("==============================================================");
      console.log(`  Local Desktop URL : http://localhost:${info.port}`);
      for (const lan of info.lanUrls) {
        console.log(`  Android LAN URL   : ${lan}/?token=${info.token}`);
      }
      for (const ts of info.tailscaleUrls) {
        console.log(`  Tailscale WAN URL : ${ts}/?token=${info.token}`);
      }
      console.log("--------------------------------------------------------------");
      console.log("  Scan this QR code with your Android Phone camera to connect:");
      console.log("--------------------------------------------------------------\n");
      try {
        const qrAscii = await server.getAuthManager().generateTerminalQr(primaryUrl);
        console.log(qrAscii);
      } catch {
        console.log(`  Pairing URL: ${pairUrl}`);
      }
      console.log("==============================================================\n");
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err?.code === "EADDRINUSE") {
        // Another healthy instance already owns the port; exit quietly instead of becoming a duplicate.
        logEvent("warn", "port already in use; another Remote Agent instance is running", { pid: process.pid });
        process.exit(3);
      }
      logEvent("error", "failed to start server", describeError(err));
      console.error("Failed to start Remote Agent server:", err);
      process.exit(1);
    });
}
