import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const COPILOT_HOME = path.join(os.homedir(), ".copilot");
const BIN_DIR = path.join(COPILOT_HOME, "bin");
const CLOUDFLARED_EXE = path.join(
  BIN_DIR,
  process.platform === "win32" ? "cloudflared.exe" : "cloudflared"
);
const WAN_CONFIG_PATH = path.join(COPILOT_HOME, "remote-agent-wan.json");

const CLOUDFLARED_DOWNLOAD_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

export interface WanStatus {
  enabled: boolean;
  status: "stopped" | "installing" | "starting" | "online" | "error";
  provider: "cloudflare-quick" | "cloudflare-named" | "custom" | "tailscale" | "none";
  publicUrl: string | null;
  customWanUrl: string | null;
  tailscaleUrls: string[];
  error: string | null;
  startedAt: string | null;
}

interface PersistedWanConfig {
  autoStart?: boolean;
  customWanUrl?: string | null;
  lastPublicUrl?: string | null;
  cloudflareTunnelToken?: string | null;
}

export class WanTunnelManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private status: WanStatus["status"] = "stopped";
  private provider: WanStatus["provider"] = "none";
  private publicUrl: string | null = null;
  private error: string | null = null;
  private startedAt: string | null = null;
  private config: PersistedWanConfig;
  private localPort = 4321;

  constructor() {
    super();
    this.config = this.loadConfig();
    const initialWan = this.config.customWanUrl || process.env.CUSTOM_WAN_URL || null;
    if (initialWan) {
      this.publicUrl = initialWan;
      this.provider = "custom";
      this.status = "online";
    }
  }

  private loadConfig(): PersistedWanConfig {
    try {
      if (fs.existsSync(WAN_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(WAN_CONFIG_PATH, "utf8")) as PersistedWanConfig;
      }
    } catch {
      // Ignore
    }
    return {};
  }

  private saveConfig(): void {
    try {
      fs.mkdirSync(path.dirname(WAN_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(WAN_CONFIG_PATH, JSON.stringify(this.config, null, 2), "utf8");
    } catch {
      // Ignore
    }
  }

  setLocalPort(port: number): void {
    this.localPort = port;
  }

  shouldAutoStart(): boolean {
    if (process.env.ENABLE_WAN === "0" || process.argv.includes("--no-wan")) {
      return false;
    }
    // If a static/DDNS customWanUrl is already online, no need to spawn cloudflared unless requested
    if (this.publicUrl && this.provider === "custom") {
      return false;
    }
    return this.config.autoStart !== false;
  }

  getStatus(tailscaleUrls: string[] = []): WanStatus {
    const activeUrl =
      this.publicUrl ||
      this.config.customWanUrl ||
      (tailscaleUrls.length > 0 ? tailscaleUrls[0] : null);

    let effectiveProvider = this.provider;
    if (effectiveProvider === "none" && tailscaleUrls.length > 0) {
      effectiveProvider = "tailscale";
    }

    return {
      enabled: this.status === "online" || this.status === "starting" || Boolean(activeUrl),
      status: this.status === "stopped" && activeUrl ? "online" : this.status,
      provider: effectiveProvider,
      publicUrl: activeUrl,
      customWanUrl: this.config.customWanUrl || null,
      tailscaleUrls,
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  setCustomWanUrl(url: string | null, persist = true): WanStatus {
    const cleaned = url ? url.trim().replace(/\/+$/, "") : null;
    this.config.customWanUrl = cleaned;
    if (persist) {
      this.saveConfig();
    }
    if (cleaned && !this.proc) {
      this.publicUrl = cleaned;
      this.provider = "custom";
      this.status = "online";
      this.error = null;
    } else if (!cleaned && this.provider === "custom") {
      this.publicUrl = null;
      this.provider = "none";
      this.status = "stopped";
    }
    const st = this.getStatus();
    this.emit("status", st);
    return st;
  }

  private async ensureCloudflaredBinary(): Promise<string> {
    if (fs.existsSync(CLOUDFLARED_EXE) && fs.statSync(CLOUDFLARED_EXE).size > 5 * 1024 * 1024) {
      return CLOUDFLARED_EXE;
    }

    this.status = "installing";
    this.error = null;
    this.emit("status", this.getStatus());

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tempFile = `${CLOUDFLARED_EXE}.download`;

    await new Promise<void>((resolve, reject) => {
      const download = (url: string, redirectsLeft = 5) => {
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects downloading cloudflared"));
          return;
        }
        https
          .get(
            url,
            {
              headers: { "User-Agent": "Copilot-Remote-Agent/1.0" },
            },
            (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                res.resume();
                download(res.headers.location, redirectsLeft - 1);
                return;
              }
              if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Failed to download cloudflared: HTTP ${res.statusCode}`));
                return;
              }
              const fileStream = fs.createWriteStream(tempFile);
              res.pipe(fileStream);
              fileStream.on("finish", () => {
                fileStream.close(() => resolve());
              });
              fileStream.on("error", (err) => {
                try {
                  fs.unlinkSync(tempFile);
                } catch {}
                reject(err);
              });
            }
          )
          .on("error", reject);
      };

      download(CLOUDFLARED_DOWNLOAD_URL);
    });

    fs.renameSync(tempFile, CLOUDFLARED_EXE);
    return CLOUDFLARED_EXE;
  }

  async startTunnel(options?: { persistAutoStart?: boolean }): Promise<WanStatus> {
    if (this.proc && (this.status === "online" || this.status === "starting")) {
      return this.getStatus();
    }

    if (options?.persistAutoStart !== undefined) {
      this.config.autoStart = options.persistAutoStart;
      this.saveConfig();
    }

    try {
      const binPath = await this.ensureCloudflaredBinary();
      this.status = "starting";
      this.provider = "cloudflare-quick";
      this.error = null;
      this.publicUrl = null;
      this.emit("status", this.getStatus());

      return await new Promise<WanStatus>((resolve, reject) => {
        const args = [
          "tunnel",
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${this.localPort}`,
        ];

        const child = spawn(binPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.proc = child;

        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.error = "Timed out waiting for Cloudflare WAN tunnel URL";
            this.status = "error";
            this.emit("status", this.getStatus());
            reject(new Error(this.error));
          }
        }, 25_000);

        const handleOutput = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
          if (match && !this.publicUrl) {
            this.publicUrl = match[0];
            this.status = "online";
            this.startedAt = new Date().toISOString();
            this.error = null;
            this.config.lastPublicUrl = this.publicUrl;
            this.saveConfig();
            const st = this.getStatus();
            this.emit("status", st);
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve(st);
            }
          }
        };

        child.stdout?.on("data", handleOutput);
        child.stderr?.on("data", handleOutput);

        child.on("error", (err) => {
          this.proc = null;
          this.status = "error";
          this.error = err.message;
          const st = this.getStatus();
          this.emit("status", st);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(err);
          }
        });

        child.on("exit", (code) => {
          this.proc = null;
          if (this.status !== "stopped") {
            this.status = code === 0 ? "stopped" : "error";
            if (code !== 0 && !this.error) {
              this.error = `Tunnel exited with code ${code}`;
            }
          }
          this.publicUrl = this.config.customWanUrl || null;
          const st = this.getStatus();
          this.emit("status", st);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(this.error || "Tunnel process exited unexpectedly"));
          }
        });
      });
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      const st = this.getStatus();
      this.emit("status", st);
      throw err;
    }
  }

  stopTunnel(disableAutoStart = false): WanStatus {
    if (disableAutoStart) {
      this.config.autoStart = false;
      this.saveConfig();
    }
    if (this.proc) {
      this.status = "stopped";
      try {
        this.proc.kill();
      } catch {
        // Ignore
      }
      this.proc = null;
    }
    this.publicUrl = this.config.customWanUrl || null;
    this.provider = this.publicUrl ? "custom" : "none";
    this.status = this.publicUrl ? "online" : "stopped";
    this.error = null;
    this.startedAt = null;
    const st = this.getStatus();
    this.emit("status", st);
    return st;
  }
}
