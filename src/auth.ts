import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import QRCode from "qrcode";
import { logEvent } from "./logger.js";

export interface AuthConfig {
  pairingToken: string;
  totpSecret: string;
  createdAt: string;
  tempSessions?: TempSessionGrant[];
}

export interface TempSessionGrant {
  id: string;
  token: string;
  label: string;
  clientIp: string;
  createdAt: string;
  expiresAt: string;
}

export interface PendingLoginApproval {
  requestId: string;
  matchCode: string;
  label: string;
  clientIp: string;
  durationHours: number;
  createdAt: number;
  status: "pending" | "approved" | "denied";
  issuedToken?: string;
  expiresAt?: string;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function fromBase32(base32: string): Buffer {
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const AUTH_FILE_PATH = path.join(os.homedir(), ".copilot", "remote-agent-auth.json");

// The token used by this repository's tests is public, and "sess-recovered-*" grants were minted
// by a removed auto-heal path that accepted unknown tokens; neither may ever authorize a client.
const PUBLIC_TEST_TOKENS = new Set(["test-secret-pairing-token-1234567890"]);

function isUntrustedGrant(grant: TempSessionGrant, pairingToken: string): boolean {
  return (
    grant.token === pairingToken ||
    PUBLIC_TEST_TOKENS.has(grant.token) ||
    String(grant.id || "").startsWith("sess-recovered-")
  );
}

export class AuthManager {
  private config: AuthConfig;
  private readonly authFilePath: string;
  private isEphemeralTestAuth = false;
  private failedAttempts = new Map<string, { count: number; lockedUntil: number }>();
  private approvalRateLimits = new Map<string, { count: number; resetAt: number }>();
  private consumedTotpCodes = new Set<string>();
  private tempSessions = new Map<string, TempSessionGrant>();
  private pendingApprovals = new Map<string, PendingLoginApproval>();

  constructor(customToken?: string, options: { authFilePath?: string } = {}) {
    this.authFilePath = options.authFilePath || AUTH_FILE_PATH;
    if (customToken) {
      this.isEphemeralTestAuth = true;
      this.config = {
        pairingToken: customToken,
        totpSecret: toBase32(crypto.randomBytes(20)),
        createdAt: new Date().toISOString(),
      };
      return;
    }
    this.config = this.loadOrCreateConfig();
  }

  private loadOrCreateConfig(): AuthConfig {
    try {
      if (fs.existsSync(this.authFilePath)) {
        const raw = JSON.parse(fs.readFileSync(this.authFilePath, "utf8")) as Partial<AuthConfig>;
        if (raw.pairingToken && raw.pairingToken.length >= 16) {
          const totpSecret =
            raw.totpSecret && raw.totpSecret.length >= 16
              ? raw.totpSecret
              : toBase32(crypto.randomBytes(20));
          const loaded: AuthConfig = {
            pairingToken: raw.pairingToken,
            totpSecret,
            createdAt: raw.createdAt || new Date().toISOString(),
            tempSessions: Array.isArray(raw.tempSessions) ? raw.tempSessions : [],
          };
          let droppedGrants = 0;
          for (const ts of loaded.tempSessions || []) {
            const usable =
              ts &&
              typeof ts.token === "string" &&
              ts.token.length > 0 &&
              new Date(ts.expiresAt).getTime() > Date.now() &&
              !isUntrustedGrant(ts, loaded.pairingToken);
            if (usable) {
              this.tempSessions.set(ts.token, ts);
            } else {
              droppedGrants++;
            }
          }
          if (droppedGrants > 0) {
            logEvent("warn", "Removed expired or untrusted device grants from the auth config", {
              removed: droppedGrants,
            });
          }
          if (!raw.totpSecret || droppedGrants > 0) {
            this.saveConfig(loaded);
          }
          return loaded;
        }
      }
    } catch {
      // Regenerate below
    }

    const fresh: AuthConfig = {
      pairingToken: crypto.randomBytes(24).toString("base64url"),
      totpSecret: toBase32(crypto.randomBytes(20)),
      createdAt: new Date().toISOString(),
    };

    try {
      fs.mkdirSync(path.dirname(this.authFilePath), { recursive: true });
      fs.writeFileSync(this.authFilePath, JSON.stringify(fresh, null, 2), "utf8");
    } catch {
      // Ignore write failures in restricted environments
    }

    return fresh;
  }

  private saveConfig(cfg = this.config): void {
    if (this.isEphemeralTestAuth) return;
    try {
      cfg.tempSessions = [...this.tempSessions.values()];
      fs.mkdirSync(path.dirname(this.authFilePath), { recursive: true });
      fs.writeFileSync(this.authFilePath, JSON.stringify(cfg, null, 2), "utf8");
    } catch {
      // Ignore write failures
    }
  }

  get token(): string {
    return this.config.pairingToken;
  }

  get totpSecret(): string {
    return this.config.totpSecret;
  }

  rotateToken(): string {
    this.tempSessions.clear();
    this.config = {
      pairingToken: crypto.randomBytes(24).toString("base64url"),
      totpSecret: toBase32(crypto.randomBytes(20)),
      createdAt: new Date().toISOString(),
      tempSessions: [],
    };
    this.saveConfig();
    return this.config.pairingToken;
  }

  generateTotpAtStep(step: number): string {
    const key = fromBase32(this.config.totpSecret);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
    buf.writeUInt32BE(step >>> 0, 4);
    const hmac = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
      (((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff)) %
      1_000_000;
    return String(code).padStart(6, "0");
  }

  getCurrentTotpInfo(nowMs = Date.now()): { code: string; secondsRemaining: number } {
    const epochSec = Math.floor(nowMs / 1000);
    const step = Math.floor(epochSec / 30);
    const secondsRemaining = 30 - (epochSec % 30);
    return {
      code: this.generateTotpAtStep(step),
      secondsRemaining,
    };
  }

  verifyTotpCode(candidateCode: string, nowMs = Date.now()): boolean {
    const clean = candidateCode.replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(clean)) return false;
    const currentStep = Math.floor(nowMs / 1000 / 30);
    for (const offset of [-1, 0, 1]) {
      const step = currentStep + offset;
      const expected = this.generateTotpAtStep(step);
      if (expected === clean) {
        const replayKey = `${step}:${clean}`;
        if (this.consumedTotpCodes.has(replayKey)) {
          return false; // Replay protection: each 6-digit TOTP code can only be used once
        }
        this.consumedTotpCodes.add(replayKey);
        if (this.consumedTotpCodes.size > 100) {
          const first = this.consumedTotpCodes.values().next().value;
          if (first) this.consumedTotpCodes.delete(first);
        }
        return true;
      }
    }
    return false;
  }

  isPrivateLanOrLocalIp(ip: string): boolean {
    const clean = ip.replace(/^::ffff:/i, "").trim().toLowerCase();
    return (
      clean === "::1" ||
      /^127\./.test(clean) ||
      /^10\./.test(clean) ||
      /^192\.168\./.test(clean) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean) ||
      // Tailscale and carrier-grade NAT use 100.64.0.0/10, not all of 100.0.0.0/8.
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(clean) ||
      /^f[cd][0-9a-f]{2}:/.test(clean) ||
      /^fe[89ab][0-9a-f]:/.test(clean)
    );
  }

  isIpBlocked(clientIp: string): boolean {
    // Never IP-block local LAN / Hairpin NAT router IPs shared by home devices
    if (this.isPrivateLanOrLocalIp(clientIp)) {
      return false;
    }
    const rate = this.failedAttempts.get(clientIp);
    if (!rate) return false;
    if (rate.lockedUntil > Date.now()) {
      return true;
    }
    if (rate.lockedUntil > 0 && rate.lockedUntil <= Date.now()) {
      this.failedAttempts.delete(clientIp);
    }
    return false;
  }

  recordFailedAttempt(clientIp: string, weight = 1, banMinutes = 15): void {
    if (this.isPrivateLanOrLocalIp(clientIp)) {
      return;
    }
    const current = this.failedAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
    current.count += weight;
    if (current.count >= 8) {
      current.lockedUntil = Date.now() + banMinutes * 60 * 1000;
    }
    this.failedAttempts.set(clientIp, current);
  }

  clearFailedAttempts(clientIp: string): void {
    this.failedAttempts.delete(clientIp);
  }

  canRequestPhoneApproval(clientIp: string): boolean {
    if (this.isIpBlocked(clientIp)) return false;
    const now = Date.now();
    const entry = this.approvalRateLimits.get(clientIp);
    if (!entry || entry.resetAt <= now) {
      this.approvalRateLimits.set(clientIp, { count: 1, resetAt: now + 10 * 60_000 });
      return true;
    }
    if (entry.count >= 2) {
      return false; // Max 2 push approval requests per 10 minutes per IP
    }
    entry.count += 1;
    return true;
  }

  getOtpAuthUri(hostname = os.hostname()): string {
    const label = encodeURIComponent(`CopilotRemote:${hostname}`);
    return `otpauth://totp/${label}?secret=${this.config.totpSecret}&issuer=CopilotRemote&algorithm=SHA1&digits=6&period=30`;
  }

  async generateTotpQrDataUrl(hostname = os.hostname()): Promise<string> {
    const uri = this.getOtpAuthUri(hostname);
    return QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 220,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
  }

  issueTempSession(params: { label?: string; clientIp: string; durationHours?: number }): TempSessionGrant {
    this.pruneExpiredTempSessions();
    const hours = Math.max(0.25, Math.min(24 * 3650, Number(params.durationHours || 8)));
    const now = Date.now();
    const grant: TempSessionGrant = {
      id: `sess-${crypto.randomBytes(6).toString("hex")}`,
      token: `tmp_${crypto.randomBytes(20).toString("base64url")}`,
      label: (params.label || "Temporary Desktop").slice(0, 80),
      clientIp: params.clientIp,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + hours * 3600_000).toISOString(),
    };
    this.tempSessions.set(grant.token, grant);
    this.saveConfig();
    return grant;
  }

  listTempSessions(): Array<Omit<TempSessionGrant, "token">> {
    this.pruneExpiredTempSessions();
    return [...this.tempSessions.values()].map(({ token: _t, ...rest }) => rest);
  }

  revokeTempSession(id: string): boolean {
    for (const [tok, grant] of this.tempSessions.entries()) {
      if (grant.id === id) {
        this.tempSessions.delete(tok);
        this.saveConfig();
        return true;
      }
    }
    return false;
  }

  private pruneExpiredTempSessions(): void {
    const now = Date.now();
    let removed = false;
    for (const [tok, grant] of this.tempSessions.entries()) {
      if (new Date(grant.expiresAt).getTime() <= now) {
        this.tempSessions.delete(tok);
        removed = true;
      }
    }
    if (removed) {
      this.saveConfig();
    }
    for (const [reqId, req] of this.pendingApprovals.entries()) {
      if (now - req.createdAt > 5 * 60_000) {
        this.pendingApprovals.delete(reqId);
      }
    }
  }

  createLoginApprovalRequest(params: { label?: string; clientIp: string; durationHours?: number }): PendingLoginApproval {
    this.pruneExpiredTempSessions();
    const requestId = crypto.randomBytes(12).toString("hex");
    const matchCode = String(crypto.randomInt(10, 99));
    const item: PendingLoginApproval = {
      requestId,
      matchCode,
      label: (params.label || "New Desktop Browser").slice(0, 80),
      clientIp: params.clientIp,
      durationHours: Math.max(1, Math.min(24 * 30, Number(params.durationHours || 8))),
      createdAt: Date.now(),
      status: "pending",
    };
    this.pendingApprovals.set(requestId, item);
    return item;
  }

  resolveLoginApprovalRequest(requestId: string, approved: boolean, overrideHours?: number): PendingLoginApproval | null {
    this.pruneExpiredTempSessions();
    const item = this.pendingApprovals.get(requestId);
    if (!item || item.status !== "pending") return null;
    if (!approved) {
      item.status = "denied";
      return item;
    }
    const grant = this.issueTempSession({
      label: item.label,
      clientIp: item.clientIp,
      durationHours: overrideHours || item.durationHours,
    });
    item.status = "approved";
    item.issuedToken = grant.token;
    item.expiresAt = grant.expiresAt;
    return item;
  }

  getLoginApprovalRequest(requestId: string): PendingLoginApproval | null {
    this.pruneExpiredTempSessions();
    return this.pendingApprovals.get(requestId) || null;
  }

  getClientIp(req: IncomingMessage): string {
    const socketIp = req.socket?.remoteAddress || "unknown";
    // Proxy headers are client-controlled; only trust them from a local reverse proxy/tunnel daemon.
    if (!this.isLoopbackAddress(socketIp)) {
      return socketIp;
    }
    const cfIp = req.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim()) return cfIp.trim();
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
    return socketIp;
  }

  private isLoopbackAddress(ip: string): boolean {
    const clean = ip.replace(/^::ffff:/i, "").trim();
    return clean === "::1" || /^127\./.test(clean);
  }

  isLoopbackRequest(req: IncomingMessage): boolean {
    // Never treat proxied/tunneled WAN requests as loopback even if local tunnel daemon connects via 127.0.0.1
    if (
      req.headers["cf-connecting-ip"] ||
      req.headers["cf-ray"] ||
      req.headers["x-forwarded-for"] ||
      req.headers["x-forwarded-host"]
    ) {
      return false;
    }
    const hostHeader = String(req.headers.host || "").toLowerCase();
    if (
      hostHeader &&
      !hostHeader.startsWith("localhost") &&
      !hostHeader.startsWith("127.0.0.1") &&
      !hostHeader.startsWith("[::1]")
    ) {
      return false;
    }
    const addr = req.socket?.remoteAddress || "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  extractToken(req: IncomingMessage): string | null {
    // 1. Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      return authHeader.slice(7).trim();
    }

    // 2. X-Remote-Token header
    const customHeader = req.headers["x-remote-token"];
    if (typeof customHeader === "string" && customHeader.trim()) {
      return customHeader.trim();
    }

    // 3. Query string ?token=...
    if (req.url) {
      try {
        const parsed = new URL(req.url, "http://localhost");
        const queryToken = parsed.searchParams.get("token");
        if (queryToken) {
          return queryToken.trim();
        }
      } catch {
        // Ignore malformed URL
      }
    }

    // 4. Cookie ra_token=...
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      for (const part of cookieHeader.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === "ra_token" && v.length > 0) {
          return decodeURIComponent(v.join("="));
        }
      }
    }

    return null;
  }

  isTokenStringAuthorized(candidate: string): boolean {
    if (!candidate) return false;
    this.pruneExpiredTempSessions();
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.config.pairingToken);
    const isMasterMatch = a.length === b.length && crypto.timingSafeEqual(a, b);
    return isMasterMatch || this.tempSessions.has(candidate);
  }

  isAuthorized(req: IncomingMessage, allowLocalhostBypass = true): boolean {
    if (allowLocalhostBypass && this.isLoopbackRequest(req)) {
      return true;
    }

    const candidate = this.extractToken(req);
    if (!candidate) {
      return false;
    }

    if (this.isTokenStringAuthorized(candidate)) {
      this.clearFailedAttempts(this.getClientIp(req));
      return true;
    }

    return false;
  }

  static getNetworkUrls(port: number): { lanUrls: string[]; tailscaleUrls: string[] } {
    const lanUrls: string[] = [];
    const tailscaleUrls: string[] = [];
    const nets = os.networkInterfaces();

    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs || []) {
        if (addr.family !== "IPv4" || addr.internal) continue;
        const lowerName = name.toLowerCase();
        const isVirtualSwitch =
          lowerName.includes("wsl") ||
          lowerName.includes("hyper-v") ||
          lowerName.includes("vethernet") ||
          lowerName.includes("docker");

        const url = `http://${addr.address}:${port}`;
        if (addr.address.startsWith("100.") || lowerName.includes("tailscale")) {
          tailscaleUrls.push(url);
        } else if (!isVirtualSwitch) {
          lanUrls.push(url);
        }
      }
    }

    if (lanUrls.length === 0) {
      for (const addrs of Object.values(nets)) {
        for (const addr of addrs || []) {
          if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("100.")) {
            lanUrls.push(`http://${addr.address}:${port}`);
          }
        }
      }
    }

    return { lanUrls, tailscaleUrls };
  }

  async generatePairingQrDataUrl(baseUrl: string): Promise<string> {
    const pairUrl = `${baseUrl.replace(/\/$/, "")}/?token=${encodeURIComponent(this.config.pairingToken)}`;
    return QRCode.toDataURL(pairUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
  }

  async generateTerminalQr(baseUrl: string): Promise<string> {
    const pairUrl = `${baseUrl.replace(/\/$/, "")}/?token=${encodeURIComponent(this.config.pairingToken)}`;
    return QRCode.toString(pairUrl, { type: "terminal", small: true });
  }
}
