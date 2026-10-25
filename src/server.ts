import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { WebSocketServer, type WebSocket as WsClient } from "ws";
import { AuthManager } from "./auth.js";
import { DesktopAppBridge } from "./desktop-bridge.js";
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
  private port: number;
  private host: string;
  private allowLocalhostBypass: boolean;
  private enableWanAutoStart: boolean;
  private accessLogPath: string | null;

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
    this.store = new SessionStateStore();
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
      this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    };

    this.httpServer = http.createServer(reqHandler);
    this.httpServer.headersTimeout = 10_000;
    this.httpServer.requestTimeout = 25_000;
    this.httpServer.keepAliveTimeout = 5_000;

    const tlsCreds = TlsManager.ensureCredentials();
    if (tlsCreds) {
      this.httpsServer = https.createServer(
        {
          key: tlsCreds.key,
          cert: tlsCreds.cert,
        },
        reqHandler
      );
      this.httpsServer.headersTimeout = 10_000;
      this.httpsServer.requestTimeout = 25_000;
      this.httpsServer.keepAliveTimeout = 5_000;
    }

    // Single-port HTTP + HTTPS (TLS) multiplexer with 5s first-byte anti-Slowloris timeout:
    // Peeks at the first byte on port 4321: 0x16 (TLS ClientHello) -> httpsServer, else -> httpServer
    this.netServer = net.createServer((socket) => {
      const firstByteTimer = setTimeout(() => {
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
    await this.sdk.initialize();
    this.bridge.start();
    this.startSessionStateWatcher();

    await new Promise<void>((resolve, reject) => {
      this.netServer.once("error", reject);
      this.netServer.listen(this.port, this.host, () => {
        this.netServer.removeListener("error", reject);
        resolve();
      });
    });

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
      const parsed = new URL(req.url || "/", "http://localhost");
      if (parsed.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      if (!this.auth.isAuthorized(req, this.allowLocalhostBypass)) {
        this.appendWanLog(this.auth.getClientIp(req), "WS /ws 401");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const wsIp = this.auth.getClientIp(req);
        const wsStarted = Date.now();
        this.appendWanLog(wsIp, "WS /ws open");
        ws.on("close", (code) => this.appendWanLog(wsIp, `WS /ws close code=${code} after ${Math.round((Date.now() - wsStarted) / 1000)}s`));
        this.clients.add(ws);
        ws.send(
          JSON.stringify({
            type: "connected",
            timestamp: new Date().toISOString(),
            desktopAppConnected: this.bridge.isConnected(),
            hostname: os.hostname(),
            uiVersion: this.getUiVersion(),
          })
        );
        const pingTimer = setInterval(() => {
          if (ws.readyState === 1) {
            try {
              ws.ping();
            } catch {}
          }
        }, 20_000);
        ws.on("message", (raw) => {
          try {
            const parsed = JSON.parse(String(raw));
            if (parsed?.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
            }
          } catch {}
        });
        ws.on("close", () => {
          clearInterval(pingTimer);
          this.clients.delete(ws);
        });
      });
    };

    this.httpServer.on("upgrade", onUpgrade);
    this.httpsServer?.on("upgrade", onUpgrade);
  }

  private setupBridgeListeners(): void {
    this.bridge.on("status", (status) => {
      this.broadcast({
        type: "desktop_status",
        ...status,
      });
    });

    this.bridge.on("workspaces_updated", () => {
      this.broadcast({
        type: "sessions_updated",
        timestamp: new Date().toISOString(),
      });
    });

    this.bridge.on("session_event", ({ sessionId, event }) => {
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

    let debounceTimer: NodeJS.Timeout | null = null;
    let lastChangedSessionId: string | null = null;

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
          lastChangedSessionId = sessionId;
          this.store.invalidateSessionCache(sessionId);
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this.broadcast({
              type: "session_file_updated",
              sessionId: lastChangedSessionId,
              file: normalized,
              timestamp: new Date().toISOString(),
            });
          }, 250);
        }
      });
    } catch {
      // Ignore if recursive watch unsupported
    }
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
    const availableModels = this.store.getAvailableModels();
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
          if (details.selectedModel && summary.model === "auto") {
            summary.model = details.selectedModel;
          }
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

        if (subRoute === "mode" && method === "POST") {
          const body = await this.readJsonBody<{ mode: SessionMode }>(req);
          if (!["interactive", "plan", "autopilot"].includes(body.mode)) {
            this.sendJson(res, 400, { error: "Invalid mode" });
            return;
          }
          const ok = this.bridge.setSessionMode(sessionId, body.mode);
          this.store.updateSessionConfigInDb(sessionId, { mode: body.mode });
          this.broadcast({ type: "sessions_updated", timestamp: new Date().toISOString() });
          this.sendJson(res, 200, { ok, mode: body.mode });
          return;
        }

        if (subRoute === "config" && method === "POST") {
          const body = await this.readJsonBody<{
            model?: string;
            reasoningEffort?: string;
            contextTier?: string;
            mode?: SessionMode;
          }>(req);

          if (body.mode && ["interactive", "plan", "autopilot"].includes(body.mode)) {
            this.bridge.setSessionMode(sessionId, body.mode);
          }
          if (body.model || body.reasoningEffort || body.contextTier) {
            const currentSummary = this.store
              .listSessions(this.bridge.getLiveWorkspaces())
              .find((s) => s.id === sessionId);
            const targetModel = body.model || currentSummary?.model || "auto";
            this.bridge.setSessionModel(
              sessionId,
              targetModel,
              body.reasoningEffort,
              body.contextTier
            );
          }

          const dbUpdated = this.store.updateSessionConfigInDb(sessionId, {
            model: body.model,
            reasoningEffort: body.reasoningEffort,
            contextTier: body.contextTier,
            mode: body.mode,
          });
          this.broadcast({ type: "sessions_updated", timestamp: new Date().toISOString() });
          this.sendJson(res, 200, {
            ok: true,
            dbUpdated,
            model: body.model,
            reasoningEffort: body.reasoningEffort,
            contextTier: body.contextTier,
            mode: body.mode,
          });
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

    // Quick local mobile install & 1-tap auto-pair page (/install and /apk)
    if (pathname === "/apk") {
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

    if (
      pathname === "/install" &&
      (this.auth.isAuthorized(req, this.allowLocalhostBypass) ||
        (this.allowLocalhostBypass && this.auth.isPrivateLanOrLocalIp(clientIp)))
    ) {
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
      const isLanAllowed =
        this.allowLocalhostBypass && this.auth.isPrivateLanOrLocalIp(clientIp);
      if (!this.auth.isAuthorized(req, this.allowLocalhostBypass) && !isLanAllowed) {
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
  const server = new RemoteAgentServer();
  server
    .start()
    .then(async (info) => {
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
    .catch((err) => {
      console.error("Failed to start Remote Agent server:", err);
      process.exit(1);
    });
}
