import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const DEFAULT_SDK_PATHS = [
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Programs",
    "GitHub Copilot",
    "copilot-sdk",
    "index.js"
  ),
];

export interface SdkStatus {
  available: boolean;
  sdkPath: string | null;
  cliVersion: string | null;
}

export class CopilotSdkEngine {
  private sdkModule: Record<string, unknown> | null = null;
  private sdkPath: string | null = null;
  private cliVersion: string | null = null;
  private clientInstance: any = null;

  async initialize(): Promise<SdkStatus> {
    for (const candidate of DEFAULT_SDK_PATHS) {
      if (fs.existsSync(candidate)) {
        try {
          const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
          if (mod && typeof mod.CopilotClient === "function") {
            this.sdkModule = mod;
            this.sdkPath = candidate;
            break;
          }
        } catch {
          // Try next
        }
      }
    }

    try {
      const { stdout } = await execFileAsync("copilot", ["--version"], { timeout: 5000 });
      const firstLine = stdout.trim().split(/\r?\n/)[0] || "";
      this.cliVersion = firstLine.replace(/^GitHub Copilot CLI\s*/i, "").replace(/\.$/, "") || firstLine;
    } catch {
      this.cliVersion = null;
    }

    return {
      available: Boolean(this.sdkModule),
      sdkPath: this.sdkPath,
      cliVersion: this.cliVersion,
    };
  }

  getStatus(): SdkStatus {
    return {
      available: Boolean(this.sdkModule),
      sdkPath: this.sdkPath,
      cliVersion: this.cliVersion,
    };
  }

  private loadMcpConfig(): Record<string, unknown> | undefined {
    try {
      const mcpConfigPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
      if (fs.existsSync(mcpConfigPath)) {
        const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
        return parsed.mcpServers || undefined;
      }
    } catch {
      // Ignore
    }
    return undefined;
  }

  private async ensureClient(): Promise<any> {
    if (!this.sdkModule) {
      await this.initialize();
    }
    if (!this.sdkModule || typeof this.sdkModule.CopilotClient !== "function") {
      throw new Error("@github/copilot-sdk is not available on this host");
    }
    if (!this.clientInstance) {
      const CopilotClientCtor = this.sdkModule.CopilotClient as new (opts?: unknown) => any;
      this.clientInstance = new CopilotClientCtor();
      await this.clientInstance.start();
    }
    return this.clientInstance;
  }

  async resumeAndSend(params: {
    sessionId: string;
    prompt: string;
    cwd?: string;
    attachmentPaths?: string[];
    onEvent?: (event: Record<string, unknown>) => void;
  }): Promise<{ messageId?: string; method: "copilot-sdk" }> {
    const client = await this.ensureClient();
    const approveAll = this.sdkModule?.approveAll as unknown;
    const mcpServers = this.loadMcpConfig();

    const session = await client.resumeSession(params.sessionId, {
      workingDirectory: params.cwd,
      mcpServers,
      onPermissionRequest: typeof approveAll === "function" ? approveAll : undefined,
    });

    if (params.onEvent && typeof session.on === "function") {
      session.on((ev: Record<string, unknown>) => {
        params.onEvent!(ev);
      });
    }

    const attachments = (params.attachmentPaths || []).map((p) => ({
      type: "file",
      path: p,
    }));

    const messageId = await session.send({
      prompt: params.prompt,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    return { messageId, method: "copilot-sdk" };
  }

  async stop(): Promise<void> {
    if (this.clientInstance && typeof this.clientInstance.stop === "function") {
      try {
        await this.clientInstance.stop();
      } catch {
        // Ignore
      }
      this.clientInstance = null;
    }
  }
}
