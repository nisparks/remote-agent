import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEAD_BYTES = 64;

/** Event types that the conversation parser understands; everything else is skipped before JSON.parse. */
export const DETAIL_EVENT_TYPES = new Set([
  "session.start",
  "assistant.turn_start",
  "assistant.turn_end",
  "user.message",
  "assistant.message",
  "subagent.started",
  "subagent.completed",
  "system.notification",
  "tool.execution_start",
  "tool.execution_complete",
]);

/** Small, rare events that must survive even when they are older than the bounded detail window. */
export const META_EVENT_TYPES = new Set([
  "session.start",
  "subagent.started",
  "subagent.completed",
  "system.notification",
]);

export function extractEventType(head: Buffer): string {
  const text = head.toString("latin1");
  const match = /^\s*\{"type":"([^"]{1,60})"/.exec(text);
  return match ? match[1] : "";
}

/**
 * Streams JSONL bytes without decoding skipped lines. Copilot event logs contain multi-MB
 * base64 binary assets, so deciding from the first bytes of each line keeps memory and CPU bounded.
 */
export class JsonlLineScanner {
  private lineStart: number;
  private readonly head = Buffer.alloc(HEAD_BYTES);
  private headLen = 0;
  private decided = false;
  private keep = false;
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private firstLineBoundary = -1;

  constructor(
    startOffset: number,
    private readonly accept: (type: string) => boolean,
    private readonly onLine: (line: string, offset: number, type: string) => void,
    private readonly maxLineBytes: number,
    startsMidLine = false
  ) {
    this.lineStart = startOffset;
    if (startsMidLine) {
      // The bytes before the first newline belong to a line that started before this region.
      this.decided = true;
      this.keep = false;
    }
  }

  /** Offset of the first byte that has not been consumed as part of a complete line. */
  get completedOffset(): number {
    return this.lineStart;
  }

  /** Offset immediately after the first newline seen, or -1 when the scanned bytes contain no newline. */
  get firstBoundary(): number {
    return this.firstLineBoundary;
  }

  push(chunk: Buffer, chunkOffset: number): void {
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf(10, i);
      const segEnd = nl === -1 ? chunk.length : nl;
      this.consume(chunk.subarray(i, segEnd), nl !== -1);
      if (nl === -1) break;
      this.finishLine();
      this.lineStart = chunkOffset + nl + 1;
      if (this.firstLineBoundary < 0) this.firstLineBoundary = this.lineStart;
      i = nl + 1;
    }
  }

  private consume(seg: Buffer, lineEndsHere: boolean): void {
    if (!this.decided) {
      const need = HEAD_BYTES - this.headLen;
      if (need > 0 && seg.length > 0) {
        const n = Math.min(need, seg.length);
        seg.copy(this.head, this.headLen, 0, n);
        this.headLen += n;
      }
      if (this.headLen >= HEAD_BYTES || lineEndsHere) {
        this.decided = true;
        this.keep = this.accept(extractEventType(this.head.subarray(0, this.headLen)));
        if (!this.keep) {
          this.parts = [];
          this.partsBytes = 0;
          return;
        }
      } else {
        this.parts.push(Buffer.from(seg));
        this.partsBytes += seg.length;
        return;
      }
    }
    if (!this.keep || seg.length === 0) return;
    if (this.partsBytes + seg.length > this.maxLineBytes) {
      this.keep = false;
      this.parts = [];
      this.partsBytes = 0;
      return;
    }
    // Segments that continue into the next chunk must be copied because read buffers may be reused.
    this.parts.push(lineEndsHere ? seg : Buffer.from(seg));
    this.partsBytes += seg.length;
  }

  private finishLine(): void {
    if (this.keep && this.partsBytes > 0) {
      const buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partsBytes);
      let line = buf.toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) {
        this.onLine(line, this.lineStart, extractEventType(this.head.subarray(0, this.headLen)));
      }
    }
    this.headLen = 0;
    this.decided = false;
    this.keep = false;
    this.parts = [];
    this.partsBytes = 0;
  }
}

export function fileIdentity(stat: fs.Stats): string {
  return `${Math.round(stat.birthtimeMs)}:${stat.ino || 0}`;
}

export interface IndexedMetaLine {
  offset: number;
  line: string;
}

export interface SessionEventIndex {
  fileId: string;
  scannedOffset: number;
  fileSize: number;
  subAgentsStarted: number;
  subAgentsCompleted: number;
  metaLines: IndexedMetaLine[];
}

const INDEX_FILE_PATH = path.join(os.homedir(), ".copilot", "remote-agent-cache", "event-index-v1.json");
const INDEX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_META_LINE_BYTES = 256 * 1024;
const MAX_META_LINES_PER_SESSION = 500;

/**
 * Background, persisted index of sub-agent metadata. It scans event logs asynchronously and
 * incrementally so multi-GB logs never block HTTP or WebSocket traffic.
 */
export class EventLogIndexer {
  private readonly indexes = new Map<string, SessionEventIndex>();
  private readonly queue: Array<{ sessionId: string; eventsPath: string }> = [];
  private readonly queued = new Set<string>();
  private readonly listeners = new Set<(sessionId: string) => void>();
  private draining = false;
  private stopped = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly persist: boolean, private readonly indexFile = INDEX_FILE_PATH) {
    if (persist) this.load();
  }

  get(sessionId: string): SessionEventIndex | undefined {
    return this.indexes.get(sessionId);
  }

  onIndexed(listener: (sessionId: string) => void): void {
    this.listeners.add(listener);
  }

  requestScan(sessionId: string, eventsPath: string, priority = false): void {
    if (this.stopped) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      return;
    }
    const existing = this.indexes.get(sessionId);
    if (existing && existing.fileId === fileIdentity(stat) && existing.fileSize === stat.size) {
      return;
    }
    if (this.queued.has(sessionId)) {
      if (priority) {
        const idx = this.queue.findIndex((q) => q.sessionId === sessionId);
        if (idx > 0) this.queue.unshift(...this.queue.splice(idx, 1));
      }
      return;
    }
    this.queued.add(sessionId);
    if (priority) {
      this.queue.unshift({ sessionId, eventsPath });
    } else {
      this.queue.push({ sessionId, eventsPath });
    }
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.queued.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) this.save();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.queued.delete(item.sessionId);
        try {
          const changed = await this.scan(item.sessionId, item.eventsPath);
          if (changed) {
            this.schedulePersist();
            for (const listener of this.listeners) listener(item.sessionId);
          }
        } catch {
          // A locked/rotated log is retried on the next request
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async scan(sessionId: string, eventsPath: string): Promise<boolean> {
    const stat = await fs.promises.stat(eventsPath);
    const fileId = fileIdentity(stat);
    let idx = this.indexes.get(sessionId);
    if (!idx || idx.fileId !== fileId || stat.size < idx.scannedOffset) {
      idx = {
        fileId,
        scannedOffset: 0,
        fileSize: 0,
        subAgentsStarted: 0,
        subAgentsCompleted: 0,
        metaLines: [],
      };
    }
    if (stat.size === idx.fileSize && idx.scannedOffset > 0) return false;

    const working: SessionEventIndex = { ...idx, metaLines: [...idx.metaLines] };
    const scanner = new JsonlLineScanner(
      working.scannedOffset,
      (type) => META_EVENT_TYPES.has(type),
      (line, offset, type) => {
        if (type === "system.notification" && !line.includes('"agent_completed"')) return;
        if (type === "subagent.started") working.subAgentsStarted++;
        if (type === "subagent.completed") working.subAgentsCompleted++;
        working.metaLines.push({ offset, line });
        if (working.metaLines.length > MAX_META_LINES_PER_SESSION) {
          // Keep session.start plus the newest sub-agent metadata
          const first = working.metaLines[0];
          working.metaLines = [first, ...working.metaLines.slice(-(MAX_META_LINES_PER_SESSION - 1))];
        }
      },
      MAX_META_LINE_BYTES
    );

    const handle = await fs.promises.open(eventsPath, "r");
    try {
      let pos = working.scannedOffset;
      while (pos < stat.size && !this.stopped) {
        const len = Math.min(INDEX_CHUNK_BYTES, stat.size - pos);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await handle.read(buf, 0, len, pos);
        if (bytesRead <= 0) break;
        scanner.push(bytesRead === len ? buf : buf.subarray(0, bytesRead), pos);
        pos += bytesRead;
        // Yield and cap background I/O so the server stays responsive while indexing large logs.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await handle.close();
    }
    if (this.stopped) return false;

    working.scannedOffset = scanner.completedOffset;
    working.fileSize = stat.size;
    this.indexes.set(sessionId, working);
    return true;
  }

  private schedulePersist(): void {
    if (!this.persist) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.save();
    }, 3000);
    this.persistTimer.unref();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.indexFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as {
        version?: number;
        sessions?: Record<string, SessionEventIndex>;
      };
      if (raw.version !== 1 || !raw.sessions) return;
      for (const [id, idx] of Object.entries(raw.sessions)) {
        if (idx && typeof idx.fileId === "string" && Array.isArray(idx.metaLines)) {
          this.indexes.set(id, idx);
        }
      }
    } catch {
      // Corrupt cache is rebuilt in the background
    }
  }

  private save(): void {
    if (!this.persist) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
      const tmp = `${this.indexFile}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: 1, sessions: Object.fromEntries(this.indexes) }),
        "utf8"
      );
      fs.renameSync(tmp, this.indexFile);
    } catch {
      // Cache persistence is best-effort
    }
  }
}
