import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".copilot", "logs");
const LOG_FILE = path.join(LOG_DIR, "remote-agent-server.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED_FILES = 3;

let fileLoggingEnabled = false;
let currentSize = 0;

export type LogLevel = "info" | "warn" | "error";

export function getLogFilePath(): string {
  return LOG_FILE;
}

export function enableFileLogging(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    currentSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    fileLoggingEnabled = true;
  } catch {
    fileLoggingEnabled = false;
  }
}

function rotateIfNeeded(nextBytes: number): void {
  if (currentSize + nextBytes <= MAX_LOG_BYTES) return;
  try {
    for (let i = KEEP_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    currentSize = 0;
  } catch {
    // Keep appending to the current file if rotation is temporarily blocked
  }
}

export function logEvent(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${
    details && Object.keys(details).length > 0 ? ` ${safeStringify(details)}` : ""
  }\n`;
  if (level === "error") {
    console.error(line.trimEnd());
  } else if (level === "warn") {
    console.warn(line.trimEnd());
  }
  if (!fileLoggingEnabled) return;
  try {
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    fs.appendFileSync(LOG_FILE, line, "utf8");
    currentSize += bytes;
  } catch {
    // Logging must never take down the server
  }
}

export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack?.split("\n").slice(0, 8).join(" | ") };
  }
  return { error: String(err) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
