import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { AuthManager } from "../src/auth.js";
import { EventLogIndexer, JsonlLineScanner } from "../src/event-log.js";
import { SessionStateStore } from "../src/session-store.js";

function fakeRequest(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe("connection reliability and auth hardening", () => {
  it("rejects arbitrary token-shaped strings instead of auto-trusting them", () => {
    const auth = new AuthManager("reliability-test-master-token-123456");
    assert.equal(auth.isTokenStringAuthorized("a".repeat(32)), false);
    assert.equal(auth.isTokenStringAuthorized(`tmp_${"b".repeat(27)}`), false);
    assert.equal(auth.isTokenStringAuthorized("reliability-test-master-token-123456"), true);
  });

  it("honors temporary session expiry", () => {
    const auth = new AuthManager("reliability-test-master-token-123456");
    const grant = auth.issueTempSession({ clientIp: "192.168.1.20", durationHours: 1 });
    assert.equal(auth.isTokenStringAuthorized(grant.token), true);
    grant.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(auth.isTokenStringAuthorized(grant.token), false);
  });

  it("drops expired, public, and auto-healed device grants when loading the auth file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-agent-auth-"));
    const authFilePath = path.join(dir, "auth.json");
    const master = "persisted-master-token-abcdefghijklmnop";
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const grant = (id: string, token: string, expiresAt = future) => ({
      id,
      token,
      label: id,
      clientIp: "192.168.0.10",
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    fs.writeFileSync(
      authFilePath,
      JSON.stringify({
        pairingToken: master,
        totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        createdAt: new Date().toISOString(),
        tempSessions: [
          grant("sess-good", "tmp_valid-device-token-1234567890"),
          grant("sess-expired", "tmp_expired-device-token-123456", new Date(Date.now() - 1000).toISOString()),
          grant("sess-public", "test-secret-pairing-token-1234567890"),
          grant("sess-duplicate-master", master),
          grant("sess-recovered-0123456789", "a".repeat(32)),
        ],
      })
    );
    try {
      const auth = new AuthManager(undefined, { authFilePath });
      assert.equal(auth.isTokenStringAuthorized("tmp_valid-device-token-1234567890"), true);
      assert.equal(auth.isTokenStringAuthorized(master), true);
      assert.equal(auth.isTokenStringAuthorized("test-secret-pairing-token-1234567890"), false);
      assert.equal(auth.isTokenStringAuthorized("a".repeat(32)), false);
      assert.equal(auth.isTokenStringAuthorized("tmp_expired-device-token-123456"), false);
      const saved = JSON.parse(fs.readFileSync(authFilePath, "utf8"));
      assert.deepEqual(
        saved.tempSessions.map((g: { id: string }) => g.id),
        ["sess-good"]
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only trusts proxy client-IP headers from a local reverse proxy", () => {
    const auth = new AuthManager("reliability-test-master-token-123456");
    assert.equal(
      auth.getClientIp(fakeRequest("203.0.113.9", { "x-forwarded-for": "192.168.0.5" })),
      "203.0.113.9"
    );
    assert.equal(
      auth.getClientIp(fakeRequest("127.0.0.1", { "cf-connecting-ip": "198.51.100.4" })),
      "198.51.100.4"
    );
  });

  it("treats only real private, loopback, and CGNAT ranges as LAN", () => {
    const auth = new AuthManager("reliability-test-master-token-123456");
    for (const ip of ["192.168.0.1", "10.2.3.4", "172.20.1.1", "100.64.0.1", "100.127.255.255", "::ffff:127.0.0.1"]) {
      assert.equal(auth.isPrivateLanOrLocalIp(ip), true, ip);
    }
    for (const ip of ["100.12.1.1", "100.128.0.1", "172.32.0.1", "8.8.8.8"]) {
      assert.equal(auth.isPrivateLanOrLocalIp(ip), false, ip);
    }
  });

  it("loads history older than a single event-log line larger than a read region", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-agent-tail-"));
    const file = path.join(dir, "events.jsonl");
    const store = new SessionStateStore({ persistEventIndex: false });
    try {
      const fd = fs.openSync(file, "w");
      for (let i = 0; i < 50; i++) {
        fs.writeSync(fd, `${JSON.stringify({ type: "user.message", data: { content: `old ${i}` } })}\n`);
      }
      // A 40 MB snapshot line spans more than one 32 MB tail region.
      fs.writeSync(fd, '{"type":"model.messages_snapshot","data":{"blob":"');
      const chunk = Buffer.alloc(4 * 1024 * 1024, 0x41);
      for (let i = 0; i < 10; i++) fs.writeSync(fd, chunk);
      fs.writeSync(fd, '"}}\n');
      for (let i = 0; i < 5; i++) {
        fs.writeSync(fd, `${JSON.stringify({ type: "assistant.message", data: { content: `new ${i}` } })}\n`);
      }
      fs.closeSync(fd);

      const readFd = fs.openSync(file, "r");
      try {
        const reader = store as unknown as {
          readTailWindow(fd: number, size: number, fileId: string): { lines: string[] };
        };
        const win = reader.readTailWindow(readFd, fs.fstatSync(readFd).size, "test");
        assert.equal(win.lines.length, 55);
        assert.match(win.lines[0], /old 0/);
        assert.match(win.lines[54], /new 4/);
      } finally {
        fs.closeSync(readFd);
      }
    } finally {
      store.stopBackgroundWork();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams JSONL across chunk boundaries and skips binary events without decoding them", () => {
    const lines = [
      JSON.stringify({ type: "session.start", data: { cwd: "C:/x" } }),
      JSON.stringify({ type: "session.binary_asset", data: { b64: "A".repeat(5000) } }),
      JSON.stringify({ type: "user.message", data: { content: "hello" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "world" } }),
    ];
    const text = `${lines.join("\n")}\n{"type":"user.message","data":{"content":"partial`;
    const bytes = Buffer.from(text, "utf8");
    const seen: Array<{ type: string; offset: number }> = [];
    const scanner = new JsonlLineScanner(
      0,
      (type) => type !== "session.binary_asset",
      (line, offset, type) => {
        JSON.parse(line);
        seen.push({ type, offset });
      },
      1024 * 1024
    );
    for (let i = 0; i < bytes.length; i += 7) {
      scanner.push(bytes.subarray(i, Math.min(bytes.length, i + 7)), i);
    }
    assert.deepEqual(
      seen.map((s) => s.type),
      ["session.start", "user.message", "assistant.message"]
    );
    const completeBytes = Buffer.byteLength(`${lines.join("\n")}\n`);
    assert.equal(scanner.completedOffset, completeBytes, "partial trailing line must not be consumed");
    assert.equal(seen[1].offset, Buffer.byteLength(`${lines.slice(0, 2).join("\n")}\n`));
  });

  it("indexes sub-agent metadata incrementally in the background", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-index-"));
    const eventsPath = path.join(dir, "events.jsonl");
    try {
      fs.writeFileSync(
        eventsPath,
        [
          JSON.stringify({ type: "session.start", data: {} }),
          JSON.stringify({ type: "subagent.started", data: { toolCallId: "a" }, agentId: "x" }),
          JSON.stringify({ type: "session.binary_asset", data: { b64: "Q".repeat(20000) } }),
          "",
        ].join("\n")
      );
      const indexer = new EventLogIndexer(false, path.join(dir, "index.json"));
      const waitForIndex = () =>
        new Promise<void>((resolve) => indexer.onIndexed(() => resolve()));

      let done = waitForIndex();
      indexer.requestScan("s1", eventsPath);
      await done;
      assert.equal(indexer.get("s1")?.subAgentsStarted, 1);
      assert.equal(indexer.get("s1")?.metaLines.length, 2);

      fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({ type: "subagent.completed", data: { toolCallId: "a" }, agentId: "x" })}\n`
      );
      done = waitForIndex();
      indexer.requestScan("s1", eventsPath);
      await done;
      assert.equal(indexer.get("s1")?.subAgentsCompleted, 1);
      assert.equal(indexer.get("s1")?.subAgentsStarted, 1, "previously indexed events must not be double counted");
      indexer.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
