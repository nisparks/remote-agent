import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { DETAIL_EVENT_TYPES, EventLogIndexer, JsonlLineScanner, fileIdentity } from "./event-log.js";
import type {
  ArtifactCategory,
  ArtifactItem,
  ConversationTurn,
  CopilotQuotaStatus,
  DetachedShellItem,
  GitHubAccountInfo,
  McpServerSummary,
  MobileReviewComment,
  PeerDesktopHost,
  PendingPermissionRequest,
  PendingPlanApproval,
  PendingUserInput,
  RemoteSessionSummary,
  SessionMode,
  SessionTodoItem,
  SubAgentItem,
  ToolCallItem,
  UiPreferences,
  WorkspaceDiffFile,
  WorkspaceDiffSummary,
} from "./types.js";

const execFileAsync = promisify(execFile);

const COPILOT_HOME = path.join(os.homedir(), ".copilot");
const SESSION_STATE_DIR = path.join(COPILOT_HOME, "session-state");
const DATA_DB_PATH = path.join(COPILOT_HOME, "data.db");
const MCP_CONFIG_PATH = path.join(COPILOT_HOME, "mcp-config.json");
const REVIEWS_FILE_PATH = path.join(COPILOT_HOME, "remote-agent-reviews.json");
const PEERS_FILE_PATH = path.join(COPILOT_HOME, "remote-agent-peers.json");
const UI_PREFS_FILE_PATH = path.join(COPILOT_HOME, "remote-agent-ui-prefs.json");

// Bounded event-log windows keep request latency predictable even when a session log grows to many GB.
const DETAIL_REGION_BYTES = 32 * 1024 * 1024;
const DETAIL_MAX_RAW_SCAN_BYTES = 160 * 1024 * 1024;
const DETAIL_TARGET_CHARS = 12 * 1024 * 1024;
const DETAIL_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DETAIL_READ_CHUNK_BYTES = 8 * 1024 * 1024;
const DETAIL_MAX_WINDOWS = 4;
const DETAIL_MAX_PARSED_SESSIONS = 6;
const DETAIL_REPARSE_MIN_INTERVAL_MS = 1500;

interface DetailEventWindow {
  fileId: string;
  startOffset: number;
  endOffset: number;
  lines: string[];
  offsets: number[];
  keptChars: number;
}

const EXTENSION_MIME_MAP: Record<string, { category: ArtifactCategory; mime: string }> = {
  ".png": { category: "image", mime: "image/png" },
  ".jpg": { category: "image", mime: "image/jpeg" },
  ".jpeg": { category: "image", mime: "image/jpeg" },
  ".webp": { category: "image", mime: "image/webp" },
  ".gif": { category: "image", mime: "image/gif" },
  ".svg": { category: "image", mime: "image/svg+xml" },
  ".bmp": { category: "image", mime: "image/bmp" },
  ".stl": { category: "3d", mime: "model/stl" },
  ".obj": { category: "3d", mime: "model/obj" },
  ".step": { category: "3d", mime: "application/step" },
  ".stp": { category: "3d", mime: "application/step" },
  ".f3d": { category: "3d", mime: "application/octet-stream" },
  ".3mf": { category: "3d", mime: "model/3mf" },
  ".apk": { category: "other", mime: "application/vnd.android.package-archive" },
  ".aab": { category: "other", mime: "application/octet-stream" },
  ".exe": { category: "other", mime: "application/vnd.microsoft.portable-executable" },
  ".zip": { category: "other", mime: "application/zip" },
  ".md": { category: "document", mime: "text/markdown; charset=utf-8" },
  ".txt": { category: "document", mime: "text/plain; charset=utf-8" },
  ".pdf": { category: "document", mime: "application/pdf" },
  ".html": { category: "document", mime: "text/html; charset=utf-8" },
  ".json": { category: "data", mime: "application/json; charset=utf-8" },
  ".yaml": { category: "data", mime: "text/yaml; charset=utf-8" },
  ".yml": { category: "data", mime: "text/yaml; charset=utf-8" },
  ".csv": { category: "data", mime: "text/csv; charset=utf-8" },
  ".xml": { category: "data", mime: "application/xml; charset=utf-8" },
  ".log": { category: "data", mime: "text/plain; charset=utf-8" },
  ".py": { category: "code", mime: "text/x-python; charset=utf-8" },
  ".ts": { category: "code", mime: "text/typescript; charset=utf-8" },
  ".tsx": { category: "code", mime: "text/typescript; charset=utf-8" },
  ".js": { category: "code", mime: "text/javascript; charset=utf-8" },
  ".rs": { category: "code", mime: "text/x-rust; charset=utf-8" },
  ".cpp": { category: "code", mime: "text/x-c++src; charset=utf-8" },
  ".c": { category: "code", mime: "text/x-csrc; charset=utf-8" },
  ".h": { category: "code", mime: "text/x-chdr; charset=utf-8" },
  ".patch": { category: "code", mime: "text/x-diff; charset=utf-8" },
  ".diff": { category: "code", mime: "text/x-diff; charset=utf-8" },
  ".sh": { category: "code", mime: "text/x-shellscript; charset=utf-8" },
  ".ps1": { category: "code", mime: "text/plain; charset=utf-8" },
};

const IGNORED_ARTIFACT_DIRS = new Set([
  "node_modules",
  ".git",
  "playwright-core",
  "__pycache__",
  ".venv",
  "dist",
  "target",
  "desktop-app",
]);

const IGNORED_ARTIFACT_SUFFIXES = [
  ".pdb",
  ".dll",
  ".idsig",
  ".deps.json",
  ".runtimeconfig.json",
];

export function classifyFile(filePath: string): { category: ArtifactCategory; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  const entry = EXTENSION_MIME_MAP[ext];
  if (entry) {
    return { category: entry.category, mimeType: entry.mime };
  }
  return { category: "other", mimeType: "application/octet-stream" };
}

export function stripPromptBoilerplate(raw: string): string {
  if (!raw) return "";
  let cleaned = raw;
  const tagsToRemove = [
    "current_datetime",
    "copilot_tauri_workspace",
    "copilot_working_context",
    "copilot_artifacts",
    "branch_rename_request",
    "system_reminder",
    "mode_changed_notice",
    "autopilot_mode",
    "canvas-context",
  ];
  for (const tag of tagsToRemove) {
    const regex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>\\s*`, "gi");
    cleaned = cleaned.replace(regex, "");
  }
  cleaned = cleaned
    .replace(
      /You have not yet marked the task as complete using the task_complete tool\.[\s\S]*?then call task_complete\./gi,
      ""
    )
    .trim();
  return cleaned;
}

function parseSimpleYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (match) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[match[1]] = val;
    }
  }
  return result;
}

export class SessionStateStore {
  private allowedRootsCache: string[] = [];
  private artifactPathCache = new Map<
    string,
    { resolved: string | null; size: number; mtimeMs: number; checkedAt: number }
  >();
  private allowedRootsLastUpdated = 0;
  private quotaCache: { data: CopilotQuotaStatus | null; cachedAt: number } | null = null;
  private sessionsListCache: { list: RemoteSessionSummary[]; cachedAt: number } | null = null;
  private quickCountsCache = new Map<
    string,
    { counts: RemoteSessionSummary["counts"]; cachedAt: number }
  >();
  private readonly indexer: EventLogIndexer;
  private detailWindows = new Map<string, DetailEventWindow>();
  private sessionDetailCache = new Map<
    string,
    {
      eventsSize: number;
      eventsMtimeMs: number;
      indexStamp: string;
      cachedAt: number;
      data: {
        turns: ConversationTurn[];
        artifacts: ArtifactItem[];
        subAgents: SubAgentItem[];
        detachedShells: DetachedShellItem[];
        awaitingUserInput: PendingUserInput | null;
        awaitingPlanApproval: PendingPlanApproval | null;
        awaitingPermission: PendingPermissionRequest | null;
        selectedModel?: string;
        reasoningEffort?: string;
        sessionCwd?: string;
      };
    }
  >();

  constructor(options: { persistEventIndex?: boolean } = {}) {
    this.indexer = new EventLogIndexer(options.persistEventIndex !== false);
    this.indexer.onIndexed((sessionId) => {
      this.quickCountsCache.delete(sessionId);
    });
  }

  /** Called when coalescing served detail data older than the latest event log; retry after retryInMs. */
  onStaleDetailServed: ((sessionId: string, retryInMs: number) => void) | null = null;

  stopBackgroundWork(): void {
    this.indexer.stop();
  }

  invalidateSessionCache(sessionId?: string): void {
    this.sessionsListCache = null;
    if (sessionId) {
      // Detail data is validated by log size/mtime, so frequent file events do not force full reparses.
      this.quickCountsCache.delete(sessionId);
    } else {
      this.quickCountsCache.clear();
      this.sessionDetailCache.clear();
    }
  }

  private loadDetailWindow(sessionId: string, eventsPath: string): DetailEventWindow | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      return null;
    }
    const fileId = fileIdentity(stat);
    let win = this.detailWindows.get(sessionId);
    if (
      win &&
      (win.fileId !== fileId ||
        stat.size < win.endOffset ||
        stat.size - win.endOffset > DETAIL_MAX_RAW_SCAN_BYTES)
    ) {
      win = undefined;
    }

    const fd = fs.openSync(eventsPath, "r");
    try {
      if (!win) {
        win = this.readTailWindow(fd, stat.size, fileId);
      } else if (stat.size > win.endOffset) {
        const delta = this.readDetailRegion(fd, win.endOffset, stat.size, false);
        for (let i = 0; i < delta.lines.length; i++) {
          win.lines.push(delta.lines[i]);
          win.offsets.push(delta.offsets[i]);
          win.keptChars += delta.lines[i].length;
        }
        win.endOffset = delta.completedOffset;
      }
    } finally {
      fs.closeSync(fd);
    }

    if (win.keptChars > DETAIL_TARGET_CHARS * 1.25) {
      let drop = 0;
      while (drop < win.lines.length - 1 && win.keptChars > DETAIL_TARGET_CHARS) {
        win.keptChars -= win.lines[drop].length;
        drop++;
      }
      win.lines.splice(0, drop);
      win.offsets.splice(0, drop);
    }
    win.startOffset = win.offsets.length > 0 ? win.offsets[0] : win.endOffset;

    this.detailWindows.delete(sessionId);
    this.detailWindows.set(sessionId, win);
    while (this.detailWindows.size > DETAIL_MAX_WINDOWS) {
      const oldest = this.detailWindows.keys().next().value;
      if (oldest === undefined) break;
      this.detailWindows.delete(oldest);
    }
    return win;
  }

  private readTailWindow(fd: number, size: number, fileId: string): DetailEventWindow {
    const regions: Array<{ lines: string[]; offsets: number[] }> = [];
    let regionEnd = size;
    let endOffset = -1;
    let keptChars = 0;
    let rawRead = 0;

    while (regionEnd > 0) {
      const regionStart = Math.max(0, regionEnd - DETAIL_REGION_BYTES);
      const region = this.readDetailRegion(fd, regionStart, regionEnd, regionStart > 0);
      rawRead += regionEnd - regionStart;
      if (endOffset < 0) endOffset = region.completedOffset;
      regions.unshift({ lines: region.lines, offsets: region.offsets });
      for (const line of region.lines) keptChars += line.length;
      if (regionStart === 0 || keptChars >= DETAIL_TARGET_CHARS || rawRead >= DETAIL_MAX_RAW_SCAN_BYTES) {
        break;
      }
      // The line crossing regionStart is read in full as the last line of the next older region.
      // When no complete line starts inside this region, that line is longer than the region (and
      // DETAIL_MAX_LINE_BYTES), so skip past it instead of rereading the same region.
      regionEnd =
        region.firstLineStart >= 0 && region.firstLineStart < regionEnd ? region.firstLineStart : regionStart;
    }

    const lines: string[] = [];
    const offsets: number[] = [];
    for (const region of regions) {
      for (let i = 0; i < region.lines.length; i++) {
        lines.push(region.lines[i]);
        offsets.push(region.offsets[i]);
      }
    }
    const finalEnd = Math.max(0, endOffset);
    return {
      fileId,
      startOffset: offsets.length > 0 ? offsets[0] : finalEnd,
      endOffset: finalEnd,
      lines,
      offsets,
      keptChars,
    };
  }

  private readDetailRegion(
    fd: number,
    start: number,
    end: number,
    startsMidLine: boolean
  ): { lines: string[]; offsets: number[]; completedOffset: number; firstLineStart: number } {
    const lines: string[] = [];
    const offsets: number[] = [];
    const scanner = new JsonlLineScanner(
      start,
      (type) => DETAIL_EVENT_TYPES.has(type),
      (line, offset) => {
        lines.push(line);
        offsets.push(offset);
      },
      DETAIL_MAX_LINE_BYTES,
      startsMidLine
    );
    let pos = start;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(DETAIL_READ_CHUNK_BYTES, end - start)));
    while (pos < end) {
      const len = Math.min(buf.length, end - pos);
      const bytesRead = fs.readSync(fd, buf, 0, len, pos);
      if (bytesRead <= 0) break;
      scanner.push(buf.subarray(0, bytesRead), pos);
      pos += bytesRead;
    }
    return {
      lines,
      offsets,
      completedOffset: scanner.completedOffset,
      firstLineStart: scanner.firstBoundary,
    };
  }

  private readSessionStartFromHead(eventsPath: string): string | null {
    let found: string | null = null;
    let fd: number | null = null;
    try {
      fd = fs.openSync(eventsPath, "r");
      const len = Math.min(256 * 1024, fs.fstatSync(fd).size);
      if (len <= 0) return null;
      const buf = Buffer.allocUnsafe(len);
      const bytesRead = fs.readSync(fd, buf, 0, len, 0);
      const scanner = new JsonlLineScanner(
        0,
        (type) => type === "session.start",
        (line) => {
          if (!found) found = line;
        },
        64 * 1024
      );
      scanner.push(buf.subarray(0, bytesRead), 0);
    } catch {
      // Ignore unreadable heads
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    return found;
  }

  private getDetailEventLines(sessionId: string, eventsPath: string): string[] {
    const win = this.loadDetailWindow(sessionId, eventsPath);
    this.indexer.requestScan(sessionId, eventsPath, true);
    if (!win) return [];
    if (win.startOffset === 0) return win.lines;

    const prefix: string[] = [];
    const idx = this.indexer.get(sessionId);
    if (idx && idx.fileId === win.fileId) {
      for (const meta of idx.metaLines) {
        if (meta.offset < win.startOffset) prefix.push(meta.line);
      }
    }
    if (!prefix.some((line) => line.startsWith('{"type":"session.start"'))) {
      const head = this.readSessionStartFromHead(eventsPath);
      if (head) prefix.unshift(head);
    }
    return prefix.length > 0 ? prefix.concat(win.lines) : win.lines;
  }

  private getIndexStamp(sessionId: string): string {
    const idx = this.indexer.get(sessionId);
    return idx ? `${idx.fileId}:${idx.metaLines.length}` : "";
  }

  getGitHubAccounts(): GitHubAccountInfo[] {
    try {
      if (!fs.existsSync(DATA_DB_PATH)) return [];
      const db = new DatabaseSync(DATA_DB_PATH, { open: true, readOnly: true });
      try {
        const rows = db
          .prepare("SELECT id, login, name, host, is_default FROM accounts ORDER BY is_default DESC")
          .all() as Array<Record<string, unknown>>;
        return rows
          .filter((r) => Boolean(r.login))
          .map((r) => ({
            id: String(r.id || r.login),
            login: String(r.login),
            name: r.name ? String(r.name) : undefined,
            host: String(r.host || "github.com"),
            isDefault: Boolean(r.is_default),
          }));
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  getAvailableModels(): Array<{ id: string; name: string }> {
    const fallback = [
      { id: "auto", name: "Auto" },
      { id: "gemini-4-argon", name: "Gemini 4 Argon" },
      { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
      { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-6-sol", name: "GPT-6 Sol" },
      { id: "gpt-6-luna", name: "GPT-6 Luna" },
      { id: "gpt-6-astra", name: "GPT-6 Astra" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { id: "grok-4.7", name: "Grok 4.7" },
    ];
    try {
      if (!fs.existsSync(DATA_DB_PATH)) return fallback;
      const db = new DatabaseSync(DATA_DB_PATH, { open: true, readOnly: true });
      try {
        const row = db
          .prepare("SELECT value FROM app_state WHERE key = 'copilot-available-models-v2'")
          .get() as { value?: string } | undefined;
        if (row?.value) {
          const parsed = JSON.parse(row.value) as Array<{ id?: string; name?: string }>;
          const list = parsed
            .filter((m) => Boolean(m.id))
            .map((m) => ({ id: String(m.id), name: String(m.name || m.id) }));
          if (list.length > 0) return list;
        }
      } finally {
        db.close();
      }
    } catch {
      // Ignore
    }
    return fallback;
  }

  updateSessionConfigInDb(
    sessionId: string,
    cfg: {
      model?: string;
      reasoningEffort?: string;
      contextTier?: string;
      mode?: SessionMode;
    }
  ): boolean {
    try {
      if (!fs.existsSync(DATA_DB_PATH)) return false;
      const db = new DatabaseSync(DATA_DB_PATH, { open: true });
      try {
        if (cfg.model) {
          db.prepare("UPDATE sessions SET model = ? WHERE id = ?").run(cfg.model, sessionId);
        }
        if (cfg.reasoningEffort) {
          db.prepare("UPDATE sessions SET reasoning_effort = ? WHERE id = ?").run(
            cfg.reasoningEffort,
            sessionId
          );
        }
        if (cfg.contextTier) {
          db.prepare("UPDATE sessions SET context_tier = ? WHERE id = ?").run(
            cfg.contextTier,
            sessionId
          );
        }
        if (cfg.mode) {
          db.prepare("UPDATE sessions SET mode = ? WHERE id = ?").run(cfg.mode, sessionId);
        }
      } finally {
        db.close();
      }
      this.invalidateSessionCache(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async getCopilotQuota(forceRefresh = false): Promise<CopilotQuotaStatus | null> {
    if (
      !forceRefresh &&
      this.quotaCache &&
      Date.now() - this.quotaCache.cachedAt < 60_000
    ) {
      return this.quotaCache.data;
    }

    try {
      const { stdout } = await execFileAsync("gh", ["api", "/copilot_internal/user"], {
        timeout: 6000,
      });
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const snapshots = (parsed.quota_snapshots as Record<string, Record<string, unknown>>) || {};
      const prem = snapshots.premium_interactions || {};
      const chat = snapshots.chat || {};
      const comp = snapshots.completions || {};

      const entitlement = Number(prem.entitlement || 0);
      const used = Number(prem.credits_used || 0);
      const remaining = Number(prem.remaining ?? prem.quota_remaining ?? Math.max(0, entitlement - used));
      const percentRemaining =
        typeof prem.percent_remaining === "number"
          ? Number(prem.percent_remaining.toFixed(1))
          : entitlement > 0
          ? Number(((remaining / entitlement) * 100).toFixed(1))
          : 100;
      const percentUsed = Number(Math.max(0, Math.min(100, 100 - percentRemaining)).toFixed(1));

      const data: CopilotQuotaStatus = {
        plan: String(parsed.copilot_plan || "enterprise"),
        sku: parsed.access_type_sku ? String(parsed.access_type_sku) : undefined,
        resetDate: parsed.quota_reset_date ? String(parsed.quota_reset_date) : undefined,
        premium: {
          entitlement,
          used,
          remaining,
          percentUsed,
          percentRemaining,
          overagePermitted: Boolean(prem.overage_permitted),
          overageCount: Number(prem.overage_count || 0),
          unlimited: Boolean(prem.unlimited),
        },
        chatUnlimited: chat.unlimited !== false,
        completionsUnlimited: comp.unlimited !== false,
        updatedAt: new Date().toISOString(),
      };
      this.quotaCache = { data, cachedAt: Date.now() };
      return data;
    } catch {
      return this.quotaCache?.data || null;
    }
  }

  listPeerHosts(): PeerDesktopHost[] {
    try {
      if (fs.existsSync(PEERS_FILE_PATH)) {
        return JSON.parse(fs.readFileSync(PEERS_FILE_PATH, "utf8")) as PeerDesktopHost[];
      }
    } catch {
      // Ignore
    }
    return [];
  }

  upsertPeerHost(peer: {
    id?: string;
    name: string;
    lanUrl: string;
    wanUrl?: string;
    token?: string;
    accountLogin?: string;
  }): PeerDesktopHost[] {
    const peers = this.listPeerHosts();
    const id = peer.id || crypto.randomUUID();
    const entry: PeerDesktopHost = {
      id,
      name: peer.name.trim() || "Desktop Host",
      lanUrl: peer.lanUrl.trim().replace(/\/+$/, ""),
      wanUrl: peer.wanUrl ? peer.wanUrl.trim().replace(/\/+$/, "") : undefined,
      token: peer.token ? peer.token.trim() : undefined,
      accountLogin: peer.accountLogin ? peer.accountLogin.trim() : undefined,
      addedAt: new Date().toISOString(),
    };
    const existingIdx = peers.findIndex(
      (p) => p.id === id || p.lanUrl.toLowerCase() === entry.lanUrl.toLowerCase()
    );
    if (existingIdx >= 0) {
      peers[existingIdx] = { ...peers[existingIdx], ...entry, id: peers[existingIdx].id };
    } else {
      peers.push(entry);
    }
    try {
      fs.writeFileSync(PEERS_FILE_PATH, JSON.stringify(peers, null, 2), "utf8");
    } catch {}
    return peers;
  }

  removePeerHost(id: string): PeerDesktopHost[] {
    const peers = this.listPeerHosts().filter((p) => p.id !== id);
    try {
      fs.writeFileSync(PEERS_FILE_PATH, JSON.stringify(peers, null, 2), "utf8");
    } catch {}
    return peers;
  }

  getUiPreferences(): UiPreferences {
    const defaults: UiPreferences = {
      pinnedSessionIds: [],
      sessionOrderIds: [],
      groupBy: "project",
      sortBy: "custom",
    };
    try {
      if (fs.existsSync(UI_PREFS_FILE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(UI_PREFS_FILE_PATH, "utf8")) as Partial<UiPreferences>;
        return {
          pinnedSessionIds: Array.isArray(raw.pinnedSessionIds) ? raw.pinnedSessionIds.map(String) : [],
          sessionOrderIds: Array.isArray(raw.sessionOrderIds) ? raw.sessionOrderIds.map(String) : [],
          groupBy: raw.groupBy === "flat" || raw.groupBy === "status" ? raw.groupBy : "project",
          sortBy: raw.sortBy === "recent" || raw.sortBy === "title" ? raw.sortBy : "custom",
        };
      }
    } catch {}
    return defaults;
  }

  saveUiPreferences(patch: Partial<UiPreferences>): UiPreferences {
    const current = this.getUiPreferences();
    const updated: UiPreferences = {
      pinnedSessionIds: Array.isArray(patch.pinnedSessionIds)
        ? patch.pinnedSessionIds.map(String)
        : current.pinnedSessionIds,
      sessionOrderIds: Array.isArray(patch.sessionOrderIds)
        ? patch.sessionOrderIds.map(String)
        : current.sessionOrderIds,
      groupBy:
        patch.groupBy === "project" || patch.groupBy === "flat" || patch.groupBy === "status"
          ? patch.groupBy
          : current.groupBy,
      sortBy:
        patch.sortBy === "custom" || patch.sortBy === "recent" || patch.sortBy === "title"
          ? patch.sortBy
          : current.sortBy,
    };
    try {
      fs.mkdirSync(path.dirname(UI_PREFS_FILE_PATH), { recursive: true });
      fs.writeFileSync(UI_PREFS_FILE_PATH, JSON.stringify(updated, null, 2), "utf8");
    } catch {}
    return updated;
  }

  getCopilotHome(): string {
    return COPILOT_HOME;
  }

  getMcpServers(): McpServerSummary[] {
    const servers: McpServerSummary[] = [
      {
        name: "github-mcp-server",
        type: "builtin",
        tools: ["web_search", "get_file_contents", "search_code", "search_users"],
        enabled: true,
        source: "builtin",
      },
    ];

    try {
      if (fs.existsSync(MCP_CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8")) as {
          mcpServers?: Record<
            string,
            {
              command?: string;
              url?: string;
              tools?: string[];
              disabled?: boolean;
            }
          >;
        };
        for (const [name, cfg] of Object.entries(raw.mcpServers || {})) {
          servers.push({
            name,
            type: cfg.url ? "http" : "stdio",
            tools: Array.isArray(cfg.tools) ? cfg.tools : ["*"],
            enabled: !cfg.disabled,
            source: "~/.copilot/mcp-config.json",
          });
        }
      }
    } catch {
      // Ignore malformed MCP config
    }

    return servers;
  }

  launchDesktopApp(appId: string): { ok: boolean; appId: string; executablePath?: string; message: string } {
    const clean = appId.toLowerCase().trim();
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

    let exePath: string | null = null;
    if (clean === "copilot" || clean === "github") {
      const p = path.join(localAppData, "Programs", "GitHub Copilot", "github.exe");
      if (fs.existsSync(p)) exePath = p;
    } else {
      // Look up user-configured companion apps in ~/.copilot/remote-agent-startup-apps.json
      const appsConfigPath = path.join(COPILOT_HOME, "remote-agent-startup-apps.json");
      try {
        if (fs.existsSync(appsConfigPath)) {
          const entries = JSON.parse(fs.readFileSync(appsConfigPath, "utf8")) as Array<
            string | { id?: string; name?: string; executablePath?: string }
          >;
          for (const entry of entries) {
            if (typeof entry === "string") {
              if (path.basename(entry, path.extname(entry)).toLowerCase() === clean) {
                exePath = entry;
                break;
              }
            } else if (
              entry.id?.toLowerCase() === clean ||
              entry.name?.toLowerCase() === clean
            ) {
              exePath = entry.executablePath || null;
              break;
            }
          }
        }
      } catch {
        // Ignore malformed startup apps config
      }
    }

    if (!exePath || !fs.existsSync(exePath)) {
      return {
        ok: false,
        appId: clean,
        message: `No configured executable found for '${clean}' in ~/.copilot/remote-agent-startup-apps.json`,
      };
    }

    const child = spawn(exePath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();

    return {
      ok: true,
      appId: clean,
      executablePath: exePath,
      message: `Launched ${path.basename(exePath)} on Desktop`,
    };
  }

  private getAllowedRoots(): string[] {
    const now = Date.now();
    if (now - this.allowedRootsLastUpdated < 15_000 && this.allowedRootsCache.length > 0) {
      return this.allowedRootsCache;
    }

    const roots = new Set<string>([
      path.resolve(COPILOT_HOME),
      path.resolve(os.homedir(), "Dev"),
      path.resolve(os.homedir(), "Repos"),
      path.resolve(os.tmpdir()),
    ]);

    try {
      if (fs.existsSync(DATA_DB_PATH)) {
        const db = new DatabaseSync(DATA_DB_PATH, { open: true, readOnly: true });
        try {
          const projects = db.prepare("SELECT main_repo_path FROM projects WHERE main_repo_path IS NOT NULL").all() as Array<{
            main_repo_path: string;
          }>;
          for (const p of projects) {
            if (p.main_repo_path) roots.add(path.resolve(p.main_repo_path));
          }
          const worktrees = db.prepare("SELECT path FROM worktrees WHERE path IS NOT NULL").all() as Array<{ path: string }>;
          for (const w of worktrees) {
            if (w.path) roots.add(path.resolve(w.path));
          }
          const workspaces = db.prepare("SELECT source_path FROM workspaces WHERE source_path IS NOT NULL").all() as Array<{
            source_path: string;
          }>;
          for (const ws of workspaces) {
            if (ws.source_path) roots.add(path.resolve(ws.source_path));
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // Ignore SQLite errors
    }

    this.allowedRootsCache = [...roots];
    this.allowedRootsLastUpdated = now;
    return this.allowedRootsCache;
  }

  resolveAllowedArtifactPath(sessionId: string, targetPath: string): string | null {
    return this.resolveAllowedArtifactFile(sessionId, targetPath)?.resolved ?? null;
  }

  private resolveAllowedArtifactFile(
    sessionId: string,
    targetPath: string
  ): { resolved: string; size: number; mtimeMs: number } | null {
    if (!targetPath) return null;

    let candidate = targetPath;
    if (!path.isAbsolute(candidate)) {
      candidate = path.join(SESSION_STATE_DIR, sessionId, "files", candidate);
    }

    // Artifact references repeat on every refresh of an active session; cache validated results briefly.
    const cacheKey = path.resolve(candidate).toLowerCase();
    const now = Date.now();
    const hit = this.artifactPathCache.get(cacheKey);
    if (hit && now - hit.checkedAt < (hit.resolved ? 30_000 : 10_000)) {
      return hit.resolved ? { resolved: hit.resolved, size: hit.size, mtimeMs: hit.mtimeMs } : null;
    }

    let result: { resolved: string; size: number; mtimeMs: number } | null = null;
    try {
      const resolved = fs.realpathSync.native(candidate);
      const stat = fs.statSync(resolved);
      if (stat.isFile() && this.isAllowedResolvedPath(resolved)) {
        result = { resolved, size: stat.size, mtimeMs: stat.mtimeMs };
      }
    } catch {
      result = null;
    }

    if (this.artifactPathCache.size > 5000) this.artifactPathCache.clear();
    this.artifactPathCache.set(
      cacheKey,
      result ? { ...result, checkedAt: now } : { resolved: null, size: 0, mtimeMs: 0, checkedAt: now }
    );
    return result;
  }

  private isAllowedResolvedPath(resolved: string): boolean {
    const lowerResolved = resolved.toLowerCase();
    // Never expose secret token or auth files
    if (
      lowerResolved.includes("\\run\\ws.token") ||
      lowerResolved.includes("\\run\\ws.release.token") ||
      lowerResolved.endsWith("remote-agent-auth.json")
    ) {
      return false;
    }

    const allowedRoots = this.getAllowedRoots();
    return allowedRoots.some((root) => {
      const normRoot = root.toLowerCase();
      return lowerResolved === normRoot || lowerResolved.startsWith(normRoot + path.sep);
    });
  }

  private hasActiveLockFile(sessionFolder: string): boolean {
    try {
      const entries = fs.readdirSync(sessionFolder);
      for (const name of entries) {
        const m = name.match(/^inuse\.(\d+)\.lock$/i);
        if (m) {
          const pid = Number(m[1]);
          if (pid > 0) {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              // Stale lock file from dead process
            }
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  listSessions(liveWorkspaces?: Map<string, Record<string, unknown>>): RemoteSessionSummary[] {
    if (
      this.sessionsListCache &&
      Date.now() - this.sessionsListCache.cachedAt < 4_000
    ) {
      return this.sessionsListCache.list;
    }

    const summariesById = new Map<string, RemoteSessionSummary>();
    const accounts = this.getGitHubAccounts();
    const defaultAccountLogin = accounts.find((a) => a.isDefault)?.login || accounts[0]?.login;
    const accountById = new Map<string, string>();
    for (const a of accounts) {
      accountById.set(a.id, a.login);
    }
    const hostName = os.hostname();
    let loadedFromDataDb = false;

    // 1. Read from ~/.copilot/data.db for Desktop App sessions + workspaces + projects
    try {
      if (fs.existsSync(DATA_DB_PATH)) {
        const db = new DatabaseSync(DATA_DB_PATH, { open: true, readOnly: true });
        try {
          const rows = db
            .prepare(
              `
              SELECT
                s.id AS session_id,
                s.title AS session_title,
                s.session_type AS session_type,
                s.mode AS mode,
                s.model AS model,
                s.reasoning_effort AS reasoning_effort,
                s.context_tier AS context_tier,
                s.is_running AS is_running,
                s.was_interrupted AS was_interrupted,
                s.created_at AS created_at,
                CASE
                  WHEN w.updated_at IS NOT NULL AND w.updated_at > s.updated_at THEN w.updated_at
                  ELSE s.updated_at
                END AS updated_at,
                s.total_input_tokens AS total_input_tokens,
                s.total_output_tokens AS total_output_tokens,
                s.total_cached_tokens AS total_cached_tokens,
                s.total_reasoning_tokens AS total_reasoning_tokens,
                s.total_nano_aiu AS total_nano_aiu,
                s.context_current_tokens AS context_current_tokens,
                s.context_input_token_limit AS context_input_token_limit,
                s.archived_at AS session_archived_at,
                s.forked_from_session_id AS forked_from_session_id,
                w.id AS workspace_id,
                w.name AS workspace_name,
                w.branch AS workspace_branch,
                w.project_id AS project_id,
                w.archived_at AS workspace_archived_at,
                w.source_path AS workspace_source_path,
                w.creator_session_id AS creator_session_id,
                w.coordinating_creator_session_id AS coordinating_creator_session_id,
                w.last_diff_files_changed AS last_diff_files_changed,
                w.last_diff_insertions AS last_diff_insertions,
                w.last_diff_deletions AS last_diff_deletions,
                wt.path AS worktree_path,
                wt.base_branch AS origin_branch,
                p.name AS project_name,
                p.github_owner AS github_owner,
                p.github_repo AS github_repo,
                p.main_repo_path AS main_repo_path,
                p.github_account_id AS github_account_id,
                p.copilot_account_id AS copilot_account_id
              FROM sessions s
              LEFT JOIN workspaces w ON w.session_id = s.id OR w.id = s.id
              LEFT JOIN worktrees wt ON wt.id = w.worktree_id
              LEFT JOIN projects p ON p.id = w.project_id
              WHERE s.archived_at IS NULL AND (w.archived_at IS NULL OR w.id IS NULL)
              ORDER BY updated_at DESC
              LIMIT 80
            `
            )
            .all() as Array<Record<string, unknown>>;

          loadedFromDataDb = rows.length > 0;

          for (const row of rows) {
            const id = String(row.session_id || "");
            if (!id) continue;

            const sessionFolder = path.join(SESSION_STATE_DIR, id);
            const dbRunning = Boolean(row.is_running);
            const liveWs = liveWorkspaces?.get(id);
            const liveSession = (liveWs?.session as Record<string, unknown> | undefined) || undefined;
            const hasLock = this.hasActiveLockFile(sessionFolder);
            let recentEventsWrite = false;
            if (hasLock) {
              try {
                const evStat = fs.statSync(path.join(sessionFolder, "events.jsonl"));
                recentEventsWrite = Date.now() - evStat.mtimeMs < 90_000;
              } catch {}
            }
            const rawRunning =
              typeof liveSession?.isRunning === "boolean"
                ? liveSession.isRunning
                : dbRunning || recentEventsWrite;
            const isRunning = rawRunning && hasLock;

            const repo =
              row.github_owner && row.github_repo
                ? `${row.github_owner}/${row.github_repo}`
                : undefined;

            const cwd =
              (typeof liveWs?.displayPath === "string" && liveWs.displayPath) ||
              (typeof row.worktree_path === "string" && row.worktree_path) ||
              (typeof row.workspace_source_path === "string" && row.workspace_source_path) ||
              (typeof row.main_repo_path === "string" && row.main_repo_path) ||
              undefined;

            const quickStats = this.getQuickSessionCounts(id);

            const acctId = String(row.copilot_account_id || row.github_account_id || "");
            const accountLogin = accountById.get(acctId) || defaultAccountLogin;

            const parentSessionId =
              (typeof row.coordinating_creator_session_id === "string" && row.coordinating_creator_session_id) ||
              (typeof row.creator_session_id === "string" && row.creator_session_id) ||
              (typeof row.forked_from_session_id === "string" && row.forked_from_session_id) ||
              undefined;

            const filesChanged = Number(row.last_diff_files_changed || 0);
            const insertions = Number(row.last_diff_insertions || 0);
            const deletions = Number(row.last_diff_deletions || 0);

            summariesById.set(id, {
              id,
              workspaceId: row.workspace_id ? String(row.workspace_id) : id,
              title: String(row.workspace_name || row.session_title || "Untitled session"),
              sessionType:
                row.session_type === "general_chat" ? "general_chat" : "project",
              isRunning,
              activityStatus: isRunning ? "busy" : "idle",
              mode: (["interactive", "plan", "autopilot"].includes(String(row.mode))
                ? String(row.mode)
                : "interactive") as SessionMode,
              model: String(liveSession?.model || row.model || "auto"),
              reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : undefined,
              contextTier: row.context_tier ? String(row.context_tier) : "default",
              projectId: row.project_id ? String(row.project_id) : undefined,
              projectName: row.project_name ? String(row.project_name) : undefined,
              repository: repo,
              branch: row.workspace_branch ? String(row.workspace_branch) : undefined,
              originBranch: row.origin_branch ? String(row.origin_branch) : undefined,
              cwd,
              parentSessionId,
              accountLogin,
              hostName,
              createdAt: String(row.created_at || new Date().toISOString()),
              updatedAt: String(row.updated_at || row.created_at || new Date().toISOString()),
              wasInterrupted: Boolean(row.was_interrupted),
              diffStats:
                filesChanged > 0 || insertions > 0 || deletions > 0
                  ? { filesChanged, insertions, deletions }
                  : undefined,
              tokenUsage: {
                totalInputTokens: Number(row.total_input_tokens || 0),
                totalOutputTokens: Number(row.total_output_tokens || 0),
                totalCachedTokens: Number(row.total_cached_tokens || 0),
                totalReasoningTokens: Number(row.total_reasoning_tokens || 0),
                aiuUsed: Number((Number(row.total_nano_aiu || 0) / 1e9).toFixed(1)),
              },
              contextWindow: row.context_input_token_limit
                ? {
                    currentTokens: Number(row.context_current_tokens || 0),
                    tokenLimit: Number(row.context_input_token_limit || 0),
                  }
                : undefined,
              awaitingUserInput: null,
              awaitingPlanApproval: null,
              awaitingPermission: null,
              counts: quickStats,
            });
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // Fallback to session-state directory scan below
    }

    // 2. Enrich known sessions from workspace.yaml (or fallback to CLI scan only if data.db is unavailable)
    try {
      if (fs.existsSync(SESSION_STATE_DIR)) {
        const entries = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const id = entry.name;
          const folder = path.join(SESSION_STATE_DIR, id);
          const yamlPath = path.join(folder, "workspace.yaml");

          if (summariesById.has(id)) {
            const existing = summariesById.get(id)!;
            if (!existing.cwd && fs.existsSync(yamlPath)) {
              const meta = parseSimpleYaml(fs.readFileSync(yamlPath, "utf8"));
              if (meta.cwd) existing.cwd = meta.cwd;
              if (meta.repository && !existing.repository) existing.repository = meta.repository;
              if (meta.branch && !existing.branch) existing.branch = meta.branch;
            }
            continue;
          }

          // When data.db is present, do not pollute the Desktop session list with old/deleted CLI state folders
          if (loadedFromDataDb) continue;

          if (!fs.existsSync(yamlPath)) continue;
          const meta = parseSimpleYaml(fs.readFileSync(yamlPath, "utf8"));
          const isRunning = this.hasActiveLockFile(folder);
          const quickStats = this.getQuickSessionCounts(id);

          if (!isRunning && quickStats.artifacts === 0 && summariesById.size >= 25) {
            continue;
          }

          summariesById.set(id, {
            id,
            workspaceId: id,
            title: meta.name || meta.repository || `Session ${id.slice(0, 8)}`,
            sessionType: "cli",
            isRunning,
            activityStatus: isRunning ? "busy" : "idle",
            mode: "interactive",
            model: "auto",
            repository: meta.repository,
            branch: meta.branch,
            cwd: meta.cwd,
            createdAt: meta.created_at || new Date().toISOString(),
            updatedAt: meta.updated_at || meta.created_at || new Date().toISOString(),
            counts: quickStats,
          });
        }
      }
    } catch {
      // Ignore directory scan errors
    }

    const list = [...summariesById.values()];
    list.sort((a, b) => {
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    this.sessionsListCache = { list, cachedAt: Date.now() };
    return list;
  }

  private getQuickSessionCounts(sessionId: string): RemoteSessionSummary["counts"] {
    const cached = this.quickCountsCache.get(sessionId);
    if (cached && Date.now() - cached.cachedAt < 20_000) {
      return cached.counts;
    }

    const folder = path.join(SESSION_STATE_DIR, sessionId);
    const filesDir = path.join(folder, "files");
    let artifacts = 0;
    let images = 0;
    let models3d = 0;

    const scanDir = (dir: string, depth = 0) => {
      if (depth > 3 || artifacts >= 500 || !fs.existsSync(dir)) return;
      try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          if (artifacts >= 500) break;
          if (d.name.startsWith(".") || IGNORED_ARTIFACT_DIRS.has(d.name)) continue;
          const full = path.join(dir, d.name);
          if (d.isDirectory()) {
            scanDir(full, depth + 1);
          } else if (d.isFile()) {
            artifacts++;
            const { category } = classifyFile(full);
            if (category === "image") images++;
            if (category === "3d") models3d++;
          }
        }
      } catch {
        // Ignore
      }
    };

    scanDir(filesDir, 0);

    let todos = 0;
    let todosDone = 0;
    const sessionDbPath = path.join(folder, "session.db");
    if (fs.existsSync(sessionDbPath)) {
      try {
        const db = new DatabaseSync(sessionDbPath, { open: true, readOnly: true });
        try {
          const rows = db.prepare("SELECT status, count(*) AS cnt FROM todos GROUP BY status").all() as Array<{
            status: string;
            cnt: number;
          }>;
          for (const r of rows) {
            const c = Number(r.cnt || 0);
            todos += c;
            if (r.status === "done") todosDone += c;
          }
        } finally {
          db.close();
        }
      } catch {
        // Ignore if todos table not initialized
      }
    }

    let subAgents = 0;
    let runningSubAgents = 0;
    const eventsPath = path.join(folder, "events.jsonl");
    this.indexer.requestScan(sessionId, eventsPath);
    const eventIndex = this.indexer.get(sessionId);
    if (eventIndex) {
      subAgents = eventIndex.subAgentsStarted;
      if (this.hasActiveLockFile(folder) && eventIndex.subAgentsStarted > eventIndex.subAgentsCompleted) {
        runningSubAgents = eventIndex.subAgentsStarted - eventIndex.subAgentsCompleted;
      }
    }
    const dsDir = path.join(folder, "detached-shells");
    if (fs.existsSync(dsDir)) {
      try {
        const leases = fs.readdirSync(dsDir).filter((f) => f.endsWith(".lease.json"));
        subAgents += leases.length;
      } catch {}
    }

    const counts = {
      turns: 0,
      artifacts,
      images,
      models3d,
      todos,
      todosDone,
      subAgents,
      runningSubAgents,
    };
    this.quickCountsCache.set(sessionId, { counts, cachedAt: Date.now() });
    return counts;
  }

  getSessionTodos(sessionId: string): SessionTodoItem[] {
    const sessionDbPath = path.join(SESSION_STATE_DIR, sessionId, "session.db");
    if (!fs.existsSync(sessionDbPath)) return [];
    try {
      const db = new DatabaseSync(sessionDbPath, { open: true, readOnly: true });
      try {
        const todos = db
          .prepare("SELECT id, title, description, status FROM todos ORDER BY created_at ASC")
          .all() as Array<{
          id: string;
          title: string;
          description?: string;
          status: SessionTodoItem["status"];
        }>;
        const deps = db.prepare("SELECT todo_id, depends_on FROM todo_deps").all() as Array<{
          todo_id: string;
          depends_on: string;
        }>;
        const depMap = new Map<string, string[]>();
        for (const d of deps) {
          const list = depMap.get(d.todo_id) || [];
          list.push(d.depends_on);
          depMap.set(d.todo_id, list);
        }
        return todos.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description || undefined,
          status: t.status,
          dependsOn: depMap.get(t.id) || [],
        }));
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  private buildArtifactItem(
    sessionId: string,
    fullPath: string,
    source: ArtifactItem["source"],
    baseDir: string | undefined,
    fileInfo: { size: number; mtimeMs: number }
  ): ArtifactItem | null {
    try {
      const { category, mimeType } = classifyFile(fullPath);
      const relativePath = baseDir
        ? path.relative(baseDir, fullPath).replace(/\\/g, "/")
        : path.basename(fullPath);
      const id = crypto.createHash("sha1").update(fullPath.toLowerCase()).digest("hex").slice(0, 16);
      return {
        id,
        name: path.basename(fullPath),
        relativePath,
        fullPath,
        category,
        mimeType,
        sizeBytes: fileInfo.size,
        updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
        source,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/artifact?path=${encodeURIComponent(fullPath)}`,
      };
    } catch {
      return null;
    }
  }

  getSessionConversationAndArtifacts(sessionId: string, cwd?: string): {
    turns: ConversationTurn[];
    artifacts: ArtifactItem[];
    subAgents: SubAgentItem[];
    detachedShells: DetachedShellItem[];
    awaitingUserInput: PendingUserInput | null;
    awaitingPlanApproval: PendingPlanApproval | null;
    awaitingPermission: PendingPermissionRequest | null;
    selectedModel?: string;
    reasoningEffort?: string;
    sessionCwd?: string;
  } {
    const folder = path.join(SESSION_STATE_DIR, sessionId);
    const eventsPath = path.join(folder, "events.jsonl");
    const filesDir = path.join(folder, "files");
    const checkpointsDir = path.join(folder, "checkpoints");
    const yamlPath = path.join(folder, "workspace.yaml");

    let eventsSize = 0;
    let eventsMtimeMs = 0;
    if (fs.existsSync(eventsPath)) {
      try {
        const st = fs.statSync(eventsPath);
        eventsSize = st.size;
        eventsMtimeMs = st.mtimeMs;
      } catch {
        // Ignore
      }
    }

    const existingCache = this.sessionDetailCache.get(sessionId);
    const indexStamp = this.getIndexStamp(sessionId);
    if (existingCache) {
      const age = Date.now() - existingCache.cachedAt;
      const unchanged =
        existingCache.eventsSize === eventsSize &&
        existingCache.eventsMtimeMs === eventsMtimeMs &&
        existingCache.indexStamp === indexStamp;
      if (unchanged && age < 180_000) {
        return existingCache.data;
      }
      // Coalesce bursts of refreshes while an agent is writing events continuously, and request a
      // trailing refresh so the newest events still reach clients after the burst ends.
      if (age < DETAIL_REPARSE_MIN_INTERVAL_MS) {
        this.onStaleDetailServed?.(sessionId, DETAIL_REPARSE_MIN_INTERVAL_MS - age + 50);
        return existingCache.data;
      }
    }

    let sessionCwd = cwd;
    if (!sessionCwd && fs.existsSync(yamlPath)) {
      try {
        const meta = parseSimpleYaml(fs.readFileSync(yamlPath, "utf8"));
        if (meta.cwd) sessionCwd = meta.cwd;
      } catch {
        // Ignore
      }
    }

    const sessionFolderNorm = path.resolve(folder).toLowerCase();
    const sessionAttachNorm = path
      .resolve(COPILOT_HOME, "attachments", "remote-agent", sessionId)
      .toLowerCase();

    const isPathOwnedBySession = (candidatePath: string): boolean => {
      const resolved = path.resolve(candidatePath).toLowerCase();
      // 1. Always allow files inside THIS session's ~/.copilot/session-state/<sessionId>
      if (resolved === sessionFolderNorm || resolved.startsWith(sessionFolderNorm + path.sep)) {
        return true;
      }
      // 2. Always allow files inside THIS session's attachments folder (~/.copilot/attachments/<project>/<sessionId>/...)
      const attachRootNorm = path.resolve(COPILOT_HOME, "attachments").toLowerCase() + path.sep;
      if (resolved.startsWith(attachRootNorm)) {
        return (
          resolved === sessionAttachNorm ||
          resolved.startsWith(sessionAttachNorm + path.sep) ||
          resolved.includes(`${path.sep}${sessionId.toLowerCase()}${path.sep}`)
        );
      }
      // 3. Never allow files from ANY OTHER session's state folder
      const stateRootNorm = path.resolve(SESSION_STATE_DIR).toLowerCase() + path.sep;
      if (resolved.startsWith(stateRootNorm)) {
        return false;
      }
      // 4. Allow referenced screenshots/artifacts written into %TEMP% by sub-agents (e.g. headless browser verification)
      const tempRootNorm = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
      if (
        resolved.startsWith(tempRootNorm) &&
        !path.basename(resolved).startsWith("copilot-tool-output-")
      ) {
        return true;
      }
      // 5. If this session has a workspace/worktree cwd, only allow files inside THIS session's cwd!
      if (sessionCwd) {
        const cwdNorm = path.resolve(sessionCwd).toLowerCase();
        return resolved === cwdNorm || resolved.startsWith(cwdNorm + path.sep);
      }
      // 6. For general_chat sessions (no project cwd), allow ~/.copilot/chats/ artifacts referenced by this chat
      const chatsRootNorm = path.resolve(COPILOT_HOME, "chats").toLowerCase() + path.sep;
      return resolved.startsWith(chatsRootNorm);
    };

    const artifactsByPath = new Map<string, ArtifactItem>();
    const addArtifact = (fullPath: string, source: ArtifactItem["source"], baseDir?: string): ArtifactItem | null => {
      const lowerName = path.basename(fullPath).toLowerCase();
      if (IGNORED_ARTIFACT_SUFFIXES.some((sfx) => lowerName.endsWith(sfx))) {
        return null;
      }
      if (!isPathOwnedBySession(fullPath)) {
        return null;
      }
      const normalizedKey = path.resolve(fullPath).toLowerCase();
      if (artifactsByPath.has(normalizedKey)) {
        return artifactsByPath.get(normalizedKey)!;
      }
      const allowed = this.resolveAllowedArtifactFile(sessionId, fullPath);
      if (!allowed) return null;
      const item = this.buildArtifactItem(sessionId, allowed.resolved, source, baseDir, allowed);
      if (item) {
        artifactsByPath.set(normalizedKey, item);
      }
      return item;
    };

    // 1. Scan session files/ directory recursively
    const walkSessionFiles = (dir: string, source: ArtifactItem["source"], baseDir: string, depth = 0) => {
      if (depth > 4 || artifactsByPath.size >= 600 || !fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (artifactsByPath.size >= 600) break;
          if (entry.name.startsWith(".") || IGNORED_ARTIFACT_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkSessionFiles(full, source, baseDir, depth + 1);
          } else if (entry.isFile()) {
            addArtifact(full, source, baseDir);
          }
        }
      } catch {
        // Ignore
      }
    };

    walkSessionFiles(filesDir, "session-files", filesDir);
    walkSessionFiles(checkpointsDir, "checkpoint", checkpointsDir);

    const planMdPath = path.join(folder, "plan.md");
    if (fs.existsSync(planMdPath)) {
      addArtifact(planMdPath, "checkpoint", folder);
    }

    // Also scan workspace releases/ or build output folders for built APKs, EXEs, STLs, and images
    if (cwd && fs.existsSync(cwd)) {
      for (const sub of ["releases", "app/build/outputs/apk", "build/outputs/apk"]) {
        const subDir = path.join(cwd, sub);
        if (fs.existsSync(subDir)) {
          walkSessionFiles(subDir, "workspace", cwd, 1);
        }
      }
    }

    const turns: ConversationTurn[] = [];
    const toolCallsById = new Map<string, ToolCallItem>();
    const toolCallOwnerTurn = new Map<string, ConversationTurn>();
    const subAgentsByCallId = new Map<string, SubAgentItem>();
    const subAgentsByAgentId = new Map<string, SubAgentItem>();
    const subAgentsByName = new Map<string, SubAgentItem>();
    const parentByTurnKey = new Map<string, string>();
    let currentTurnParentCallId: string | undefined;
    let awaitingUserInput: PendingUserInput | null = null;
    let awaitingPlanApproval: PendingPlanApproval | null = null;
    let awaitingPermission: PendingPermissionRequest | null = null;
    let selectedModel: string | undefined;
    let reasoningEffort: string | undefined;

    const extractReferencedArtifacts = (textOrJson: string): ArtifactItem[] => {
      if (!textOrJson) return [];
      const found: ArtifactItem[] = [];
      const seen = new Set<string>();
      const regex = /([A-Za-z]:\\(?:\\\\|[^"'\s<>|?*])+?\.(?:png|jpg|jpeg|webp|gif|svg|stl|obj|step|stp|f3d|3mf|apk|aab|exe|zip|pdf|md|json|csv|patch))/gi;
      for (const match of textOrJson.matchAll(regex)) {
        const rawPath = match[1].replace(/\\\\/g, "\\");
        const key = rawPath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const item = addArtifact(rawPath, "referenced", sessionCwd);
        if (item) {
          found.push(item);
        }
      }
      return found;
    };

    if (fs.existsSync(eventsPath)) {
      try {
        const lines = this.getDetailEventLines(sessionId, eventsPath);

        for (const line of lines) {
          let ev: {
            id?: string;
            type?: string;
            agentId?: string;
            timestamp?: string;
            data?: Record<string, unknown>;
          };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }

          const type = ev.type || "";
          const evAgentId = typeof ev.agentId === "string" ? ev.agentId : undefined;
          const data = ev.data || {};
          const timestamp = ev.timestamp || new Date().toISOString();

          if (type === "session.start") {
            if (typeof data.selectedModel === "string") selectedModel = data.selectedModel;
            if (typeof data.reasoningEffort === "string") reasoningEffort = data.reasoningEffort;
            const ctx = data.context as Record<string, unknown> | undefined;
            if (ctx && typeof ctx.cwd === "string" && !sessionCwd) {
              sessionCwd = ctx.cwd;
            }
          } else if (type === "assistant.turn_start") {
            const pCallId =
              (typeof data.parentToolCallId === "string" && data.parentToolCallId) ||
              (evAgentId ? subAgentsByAgentId.get(evAgentId)?.toolCallId || evAgentId : undefined);
            currentTurnParentCallId = pCallId;
            if (pCallId) {
              if (data.turnId !== undefined) {
                parentByTurnKey.set(`${data.interactionId || ""}:${data.turnId}`, pCallId);
              }
              const sa = subAgentsByCallId.get(pCallId) || (evAgentId ? subAgentsByAgentId.get(evAgentId) : undefined);
              if (sa) {
                sa.status = "running";
              }
            }
          } else if (type === "assistant.turn_end") {
            currentTurnParentCallId = undefined;
          } else if (type === "user.message") {
            awaitingUserInput = null;
            const rawContent = String(data.content || "");
            const cleanContent = stripPromptBoilerplate(rawContent);
            const refs = extractReferencedArtifacts(rawContent);
            if (Array.isArray(data.attachments)) {
              for (const att of data.attachments as Array<Record<string, unknown>>) {
                const attPath = typeof att?.path === "string" ? att.path : "";
                if (attPath) {
                  const item = addArtifact(attPath, "referenced", sessionCwd);
                  if (item && !refs.some((r) => r.id === item.id)) {
                    refs.push(item);
                  }
                }
              }
            }
            if (!cleanContent && refs.length === 0) {
              continue;
            }
            const userParentCallId =
              (typeof data.parentToolCallId === "string" && data.parentToolCallId) ||
              (evAgentId ? subAgentsByAgentId.get(evAgentId)?.toolCallId || evAgentId : undefined);
            turns.push({
              id: String(data.messageId || ev.id || crypto.randomUUID()),
              role: "user",
              content: cleanContent,
              rawContent: rawContent !== cleanContent ? rawContent : undefined,
              timestamp,
              turnId: data.turnId ? String(data.turnId) : undefined,
              parentToolCallId: userParentCallId,
              toolCalls: [],
              artifacts: refs,
            });
          } else if (type === "assistant.message") {
            const msgContent = String(data.content || "").trim();
            const reasoning = typeof data.reasoningText === "string" ? data.reasoningText.trim() : undefined;
            const model = typeof data.model === "string" ? data.model : selectedModel;
            const toolReqs = Array.isArray(data.toolRequests)
              ? (data.toolRequests as Array<Record<string, unknown>>)
              : [];

            const turnKey = `${data.interactionId || ""}:${data.turnId ?? ""}`;
            const turnParentCallId =
              (typeof data.parentToolCallId === "string" && data.parentToolCallId) ||
              (evAgentId ? subAgentsByAgentId.get(evAgentId)?.toolCallId || evAgentId : undefined) ||
              parentByTurnKey.get(turnKey) ||
              currentTurnParentCallId ||
              undefined;

            // Preserve each assistant step chronologically so thoughts, tool calls, and messages appear in exact native order
            const turn: ConversationTurn = {
              id: String(data.messageId || ev.id || crypto.randomUUID()),
              role: "assistant",
              content: "",
              reasoningText: reasoning || undefined,
              model,
              timestamp,
              turnId: data.turnId ? String(data.turnId) : undefined,
              parentToolCallId: turnParentCallId,
              toolCalls: [],
              artifacts: [],
            };

            let taskCompleteSummary = "";

            for (const req of toolReqs) {
              const callId = String(req.toolCallId || "");
              const toolName = String(req.name || "tool");
              const args = (req.arguments as Record<string, unknown>) || {};
              const argArtifacts = extractReferencedArtifacts(JSON.stringify(args));

              if (toolName === "task_complete" && typeof args.summary === "string" && args.summary.trim()) {
                taskCompleteSummary = args.summary.trim();
              }

              const tc: ToolCallItem = {
                toolCallId: callId,
                toolName,
                toolTitle: typeof req.toolTitle === "string" ? req.toolTitle : undefined,
                intentionSummary:
                  typeof req.intentionSummary === "string" ? req.intentionSummary : undefined,
                mcpServerName:
                  typeof req.mcpServerName === "string" ? req.mcpServerName : undefined,
                mcpToolName: typeof req.mcpToolName === "string" ? req.mcpToolName : undefined,
                arguments: args,
                status: "running",
                startedAt: timestamp,
                artifacts: argArtifacts,
              };

              turn.toolCalls.push(tc);
              for (const a of argArtifacts) {
                if (!turn.artifacts.some((x) => x.id === a.id)) {
                  turn.artifacts.push(a);
                }
              }

              if (callId) {
                toolCallsById.set(callId, tc);
                toolCallOwnerTurn.set(callId, turn);
              }

              if (toolName === "task") {
                const agentName = String(args.name || args.agent_id || callId.slice(0, 8));
                const agentType = String(args.agent_type || "task");
                const desc = String(args.description || tc.toolTitle || tc.intentionSummary || agentName);
                const mode = args.mode === "background" ? "background" : "sync";
                const promptPreview =
                  typeof args.prompt === "string" ? args.prompt.slice(0, 600) : undefined;
                const sa: SubAgentItem = {
                  id: agentName,
                  toolCallId: callId,
                  name: agentName,
                  agentType,
                  displayName: agentType,
                  description: desc,
                  mode,
                  status: "running",
                  startedAt: timestamp,
                  promptPreview,
                };
                tc.subAgent = sa;
                subAgentsByCallId.set(callId, sa);
                subAgentsByName.set(agentName, sa);
              } else if (toolName === "read_agent" || toolName === "write_agent") {
                const targetId = String(
                  args.agent_id || (Array.isArray(args.agent_ids) ? args.agent_ids[0] : "") || ""
                );
                const targetSa = subAgentsByAgentId.get(targetId) || subAgentsByName.get(targetId);
                if (targetSa) {
                  tc.subAgent = targetSa;
                }
              }

              if (toolName === "ask_user") {
                awaitingUserInput = {
                  requestId: callId,
                  question: String(args.question || "Agent is requesting your input"),
                  choices: Array.isArray(args.choices) ? args.choices.map(String) : undefined,
                  allowFreeform: args.allow_freeform !== false,
                  timestamp,
                };
              } else if (toolName === "exit_plan_mode") {
                awaitingPlanApproval = {
                  requestId: callId,
                  summary: typeof args.summary === "string" ? args.summary : "Plan ready for approval",
                  recommendedAction:
                    typeof args.recommended_action === "string"
                      ? args.recommended_action
                      : undefined,
                  timestamp,
                };
              }
            }

            if (msgContent || taskCompleteSummary) {
              const combinedText = `${msgContent}\n${taskCompleteSummary}`;
              const turnArtifacts = extractReferencedArtifacts(combinedText);
              for (const a of turnArtifacts) {
                if (!turn.artifacts.some((x) => x.id === a.id)) {
                  turn.artifacts.push(a);
                }
              }

              if (msgContent && taskCompleteSummary && msgContent !== taskCompleteSummary) {
                turn.content = `${msgContent}\n\n${taskCompleteSummary}`;
              } else {
                turn.content = taskCompleteSummary || msgContent;
              }
            }

            if (turn.content || turn.reasoningText || turn.toolCalls.length > 0) {
              turns.push(turn);
            }
          } else if (type === "subagent.started") {
            const callId = String(data.toolCallId || "");
            let sa = subAgentsByCallId.get(callId);
            if (!sa && callId) {
              const dispName = String(data.agentDisplayName || data.agentName || callId.slice(0, 8));
              sa = {
                id: dispName,
                agentId: evAgentId,
                toolCallId: callId,
                name: dispName,
                agentType: String(data.agentType || data.agentName || "sub-agent"),
                displayName: dispName,
                description: String(data.agentDescription || dispName),
                mode: data.executionMode === "background" ? "background" : "sync",
                status: "running",
                model: typeof data.model === "string" ? data.model : undefined,
                startedAt: timestamp,
              };
              subAgentsByCallId.set(callId, sa);
              subAgentsByName.set(dispName, sa);
            } else if (sa) {
              if (typeof data.agentDisplayName === "string") sa.displayName = data.agentDisplayName;
              if (typeof data.agentName === "string") sa.agentType = data.agentName;
              if (typeof data.model === "string" && !sa.model) sa.model = data.model;
            }
            if (sa && evAgentId) {
              sa.agentId = evAgentId;
              subAgentsByAgentId.set(evAgentId, sa);
              subAgentsByName.set(evAgentId, sa);
            }
          } else if (type === "subagent.completed") {
            const callId = String(data.toolCallId || "");
            const sa =
              subAgentsByCallId.get(callId) || (evAgentId ? subAgentsByAgentId.get(evAgentId) : undefined);
            if (sa) {
              sa.status = "completed";
              sa.completedAt = timestamp;
              if (typeof data.model === "string") sa.model = data.model;
              if (typeof data.totalToolCalls === "number") sa.totalToolCalls = data.totalToolCalls;
              if (typeof data.totalTokens === "number") sa.totalTokens = data.totalTokens;
              if (typeof data.durationMs === "number") sa.durationMs = data.durationMs;
            }
          } else if (type === "system.notification") {
            const kind = (data.kind as Record<string, unknown>) || {};
            if (kind.type === "agent_completed" && typeof kind.agentId === "string") {
              const sa = subAgentsByAgentId.get(kind.agentId) || subAgentsByName.get(kind.agentId);
              if (sa) {
                sa.status = kind.status === "failed" ? "failed" : "completed";
                sa.completedAt = timestamp;
              }
            }
          } else if (type === "tool.execution_start") {
            const callId = String(data.toolCallId || "");
            const tc = toolCallsById.get(callId);
            const ownerTurn = toolCallOwnerTurn.get(callId);
            if (ownerTurn && !ownerTurn.parentToolCallId) {
              const resolvedParent =
                (typeof data.parentToolCallId === "string" && data.parentToolCallId) ||
                (evAgentId ? subAgentsByAgentId.get(evAgentId)?.toolCallId || evAgentId : undefined);
              if (resolvedParent) ownerTurn.parentToolCallId = resolvedParent;
            }
            if (tc) {
              if (typeof data.mcpServerName === "string") tc.mcpServerName = data.mcpServerName;
              if (typeof data.mcpToolName === "string") tc.mcpToolName = data.mcpToolName;
              if (typeof data.toolTitle === "string" && !tc.toolTitle) tc.toolTitle = data.toolTitle;
              const startArgs = (data.arguments as Record<string, unknown>) || {};
              if (Object.keys(startArgs).length > 0 && (!tc.arguments || Object.keys(tc.arguments).length === 0)) {
                tc.arguments = startArgs;
              }
              if (data.toolName === "task" && !tc.subAgent) {
                const agentName = String(startArgs.name || startArgs.agent_id || callId.slice(0, 8));
                const agentType = String(startArgs.agent_type || "task");
                const desc = String(startArgs.description || tc.toolTitle || agentName);
                const mode = startArgs.mode === "background" ? "background" : "sync";
                const promptPreview = typeof startArgs.prompt === "string" ? startArgs.prompt.slice(0, 600) : undefined;
                const sa: SubAgentItem = {
                  id: agentName,
                  toolCallId: callId,
                  name: agentName,
                  agentType,
                  displayName: agentType,
                  description: desc,
                  mode,
                  status: "running",
                  startedAt: timestamp,
                  promptPreview,
                };
                tc.subAgent = sa;
                subAgentsByCallId.set(callId, sa);
                subAgentsByName.set(agentName, sa);
              } else if ((data.toolName === "read_agent" || data.toolName === "write_agent") && !tc.subAgent) {
                const targetId = String(
                  startArgs.agent_id || (Array.isArray(startArgs.agent_ids) ? startArgs.agent_ids[0] : "") || ""
                );
                const targetSa = subAgentsByAgentId.get(targetId) || subAgentsByName.get(targetId);
                if (targetSa) tc.subAgent = targetSa;
              }
            }
          } else if (type === "tool.execution_complete") {
            const callId = String(data.toolCallId || "");
            const tc = toolCallsById.get(callId);
            const ownerTurn = toolCallOwnerTurn.get(callId);
            const success = data.success !== false;
            const resultObj = (data.result as Record<string, unknown>) || {};
            const resultContent = String(resultObj.content || "");

            if (tc) {
              tc.status = success ? "completed" : "failed";
              tc.completedAt = timestamp;
              tc.resultPreview = resultContent.slice(0, 600);
              const resArtifacts = extractReferencedArtifacts(resultContent);
              for (const a of resArtifacts) {
                if (!tc.artifacts.some((x) => x.id === a.id)) {
                  tc.artifacts.push(a);
                }
                if (ownerTurn && !ownerTurn.artifacts.some((x) => x.id === a.id)) {
                  ownerTurn.artifacts.push(a);
                }
              }

              if (tc.toolName === "task" && tc.subAgent) {
                const bgMatch = resultContent.match(/agent_id:\s*([a-zA-Z0-9_-]+)/i);
                if (bgMatch) {
                  tc.subAgent.agentId = bgMatch[1];
                  subAgentsByAgentId.set(bgMatch[1], tc.subAgent);
                  subAgentsByName.set(bgMatch[1], tc.subAgent);
                } else {
                  tc.subAgent.status = success ? "completed" : "failed";
                  tc.subAgent.completedAt = timestamp;
                  tc.subAgent.resultPreview = resultContent.slice(0, 800);
                }
              } else if (tc.toolName === "read_agent" || tc.toolName === "write_agent") {
                const targetAgentId = String(
                  tc.arguments?.agent_id ||
                    (Array.isArray(tc.arguments?.agent_ids) ? tc.arguments?.agent_ids[0] : "") ||
                    ""
                );
                const sa = subAgentsByAgentId.get(targetAgentId) || subAgentsByName.get(targetAgentId);
                if (sa) {
                  tc.subAgent = sa;
                  if (tc.toolName === "read_agent" && resultContent) {
                    sa.resultPreview = resultContent.slice(0, 1000);
                    sa.status = "completed";
                    if (!sa.completedAt) sa.completedAt = timestamp;
                  }
                }
              }

              if (tc.toolName === "ask_user" && awaitingUserInput?.requestId === callId) {
                awaitingUserInput = null;
              }
              if (tc.toolName === "exit_plan_mode" && awaitingPlanApproval?.requestId === callId) {
                awaitingPlanApproval = null;
              }
            }
          }
        }
      } catch {
        // Ignore read error
      }
    }

    const sessionStillRunning = this.hasActiveLockFile(folder);
    const subAgents = [...subAgentsByCallId.values()].map((sa) => {
      if (!sessionStillRunning && sa.status === "running") {
        sa.status = "completed";
      }
      const saTurns = turns.filter(
        (t) =>
          t.parentToolCallId === sa.toolCallId ||
          (sa.agentId && t.parentToolCallId === sa.agentId)
      );
      if (!sa.totalToolCalls && saTurns.length > 0) {
        sa.totalToolCalls = saTurns.reduce((sum, t) => sum + (t.toolCalls?.length || 0), 0);
      }
      return {
        ...sa,
        turns: saTurns.slice(-180),
      };
    });

    // Keep Main Lead Agent turns separate from sub-agent turns so sub-agent activity never pushes out the main conversation!
    const mainTurns = turns.filter((t) => !t.parentToolCallId);

    // Discover background detached shells in ~/.copilot/session-state/<id>/detached-shells/*.lease.json
    const detachedShells: DetachedShellItem[] = [];
    const dsDir = path.join(folder, "detached-shells");
    if (fs.existsSync(dsDir)) {
      try {
        for (const f of fs.readdirSync(dsDir)) {
          if (!f.endsWith(".lease.json")) continue;
          const rawLease = JSON.parse(fs.readFileSync(path.join(dsDir, f), "utf8")) as Record<string, any>;
          const pid = Number(rawLease.supervisor?.pid || rawLease.owner?.pid || 0) || null;
          let alive = false;
          if (pid && pid > 0) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch {}
          }
          let logPreview = "";
          if (typeof rawLease.logPath === "string" && fs.existsSync(rawLease.logPath)) {
            try {
              const logStat = fs.statSync(rawLease.logPath);
              const readLen = Math.min(8192, logStat.size);
              if (readLen > 0) {
                const fd = fs.openSync(rawLease.logPath, "r");
                const buf = Buffer.allocUnsafe(readLen);
                fs.readSync(fd, buf, 0, readLen, logStat.size - readLen);
                fs.closeSync(fd);
                logPreview = buf.toString("utf8");
              }
            } catch {}
          }
          detachedShells.push({
            shellId: String(rawLease.shellId || f.replace(/\.lease\.json$/, "")),
            pid,
            state: alive && rawLease.state !== "stopped" ? "active" : "stopped",
            logPath: typeof rawLease.logPath === "string" ? rawLease.logPath : undefined,
            logPreview,
            startedAt: rawLease.heartbeatUnixMs
              ? new Date(Number(rawLease.heartbeatUnixMs)).toISOString()
              : undefined,
          });
        }
      } catch {}
    }

    const allArtifacts = [...artifactsByPath.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    const artifacts = allArtifacts.slice(0, 300);

    const resultData = {
      turns: (mainTurns.length > 0 ? mainTurns : turns).slice(-250),
      artifacts,
      subAgents,
      detachedShells,
      awaitingUserInput,
      awaitingPlanApproval,
      awaitingPermission,
      selectedModel,
      reasoningEffort,
      sessionCwd,
    };
    this.sessionDetailCache.delete(sessionId);
    this.sessionDetailCache.set(sessionId, {
      eventsSize,
      eventsMtimeMs,
      indexStamp,
      cachedAt: Date.now(),
      data: resultData,
    });
    while (this.sessionDetailCache.size > DETAIL_MAX_PARSED_SESSIONS) {
      const oldest = this.sessionDetailCache.keys().next().value;
      if (oldest === undefined) break;
      this.sessionDetailCache.delete(oldest);
    }
    return resultData;
  }

  async getWorkspaceGitDiff(cwd?: string): Promise<WorkspaceDiffSummary> {
    const empty: WorkspaceDiffSummary = {
      baseBranch: "main",
      branch: "HEAD",
      isClean: true,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    };
    if (!cwd || !fs.existsSync(cwd)) return empty;

    try {
      const { stdout: branchOut } = await execFileAsync(
        "git",
        ["--no-pager", "rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 5000 }
      );
      const branch = branchOut.trim() || "HEAD";

      const { stdout: statusOut } = await execFileAsync(
        "git",
        ["--no-pager", "status", "--porcelain"],
        { cwd, timeout: 5000 }
      );

      const { stdout: diffOut } = await execFileAsync(
        "git",
        ["--no-pager", "diff", "HEAD", "--unified=3"],
        { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }
      );

      const patchesByFile = new Map<string, { patch: string; ins: number; del: number }>();
      const rawChunks = diffOut.split(/^diff --git /m).filter(Boolean);
      for (const chunk of rawChunks) {
        const firstLine = chunk.split(/\r?\n/, 1)[0] || "";
        const m = firstLine.match(/a\/(.+?) b\/(.+)$/);
        if (!m) continue;
        const filePath = m[2].trim();
        let ins = 0;
        let del = 0;
        for (const dl of chunk.split(/\r?\n/)) {
          if (dl.startsWith("+") && !dl.startsWith("+++")) ins++;
          else if (dl.startsWith("-") && !dl.startsWith("---")) del++;
        }
        patchesByFile.set(filePath, {
          patch: `diff --git ${chunk}`.slice(0, 25_000),
          ins,
          del,
        });
      }

      const files: WorkspaceDiffFile[] = [];
      const seenFiles = new Set<string>();

      for (const line of statusOut.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const code = line.slice(0, 2);
        const filePath = line.slice(3).trim().replace(/^"|"$/g, "");
        seenFiles.add(filePath);
        const patchInfo = patchesByFile.get(filePath);
        let status: WorkspaceDiffFile["status"] = "modified";
        if (code.includes("?")) status = "untracked";
        else if (code.includes("A")) status = "added";
        else if (code.includes("D")) status = "deleted";
        else if (code.includes("R")) status = "renamed";

        files.push({
          path: filePath,
          status,
          insertions: patchInfo?.ins || 0,
          deletions: patchInfo?.del || 0,
          patch: patchInfo?.patch,
        });
      }

      for (const [filePath, patchInfo] of patchesByFile.entries()) {
        if (seenFiles.has(filePath)) continue;
        files.push({
          path: filePath,
          status: "modified",
          insertions: patchInfo.ins,
          deletions: patchInfo.del,
          patch: patchInfo.patch,
        });
      }

      const totalIns = files.reduce((acc, f) => acc + f.insertions, 0);
      const totalDel = files.reduce((acc, f) => acc + f.deletions, 0);

      return {
        baseBranch: "main",
        branch,
        isClean: files.length === 0,
        filesChanged: files.length,
        insertions: totalIns,
        deletions: totalDel,
        files,
      };
    } catch {
      return empty;
    }
  }

  // Mobile Review Comments queue management
  private loadAllReviews(): MobileReviewComment[] {
    try {
      if (fs.existsSync(REVIEWS_FILE_PATH)) {
        return JSON.parse(fs.readFileSync(REVIEWS_FILE_PATH, "utf8")) as MobileReviewComment[];
      }
    } catch {
      // Ignore
    }
    return [];
  }

  private saveAllReviews(reviews: MobileReviewComment[]): void {
    try {
      fs.mkdirSync(path.dirname(REVIEWS_FILE_PATH), { recursive: true });
      fs.writeFileSync(REVIEWS_FILE_PATH, JSON.stringify(reviews, null, 2), "utf8");
    } catch {
      // Ignore
    }
  }

  listReviewComments(sessionId: string): MobileReviewComment[] {
    return this.loadAllReviews().filter((r) => r.sessionId === sessionId);
  }

  addReviewComment(input: {
    sessionId: string;
    targetType: MobileReviewComment["targetType"];
    targetPath?: string;
    lineStart?: number;
    lineEnd?: number;
    comment: string;
    annotatedImageBase64?: string;
  }): MobileReviewComment {
    const all = this.loadAllReviews();
    let annotatedImageLocalPath: string | undefined;
    let annotatedImageUrl: string | undefined;

    if (input.annotatedImageBase64) {
      const savedPath = this.saveUploadedAttachment(
        input.sessionId,
        `annotated-${Date.now()}.png`,
        input.annotatedImageBase64
      );
      annotatedImageLocalPath = savedPath;
      annotatedImageUrl = `/api/sessions/${encodeURIComponent(input.sessionId)}/artifact?path=${encodeURIComponent(savedPath)}`;
    }

    const item: MobileReviewComment = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      targetType: input.targetType,
      targetPath: input.targetPath,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      comment: input.comment,
      annotatedImageUrl,
      annotatedImageLocalPath,
      createdAt: new Date().toISOString(),
      status: "queued",
    };

    all.push(item);
    this.saveAllReviews(all);
    return item;
  }

  deleteReviewComment(sessionId: string, commentId: string): boolean {
    const all = this.loadAllReviews();
    const filtered = all.filter((r) => !(r.sessionId === sessionId && r.id === commentId));
    if (filtered.length === all.length) return false;
    this.saveAllReviews(filtered);
    return true;
  }

  markReviewsSent(sessionId: string, commentIds: string[]): void {
    const idSet = new Set(commentIds);
    const all = this.loadAllReviews().map((r) =>
      r.sessionId === sessionId && idSet.has(r.id) ? { ...r, status: "sent" as const } : r
    );
    this.saveAllReviews(all);
  }

  saveUploadedAttachment(sessionId: string, fileName: string, base64Data: string): string {
    const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_") || `upload-${Date.now()}.png`;
    const attachDir = path.join(COPILOT_HOME, "attachments", "remote-agent", sessionId);
    fs.mkdirSync(attachDir, { recursive: true });
    const destPath = path.join(attachDir, `${Date.now()}-${safeName}`);
    const cleaned = base64Data.replace(/^data:[^;]+;base64,/, "");
    fs.writeFileSync(destPath, Buffer.from(cleaned, "base64"));
    // Also copy into session's files/ directory so it immediately shows up in the session's artifact gallery!
    try {
      const sessionFilesDir = path.join(SESSION_STATE_DIR, sessionId, "files", "mobile-feedback");
      fs.mkdirSync(sessionFilesDir, { recursive: true });
      fs.copyFileSync(destPath, path.join(sessionFilesDir, path.basename(destPath)));
    } catch {
      // Ignore if session folder doesn't exist yet
    }
    return destPath;
  }
}
