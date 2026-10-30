import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { RemoteAgentServer } from "../src/server.js";
import { classifyFile, stripPromptBoilerplate } from "../src/session-store.js";

describe("RemoteAgentServer & Desktop Copilot Bridge", () => {
  let server: RemoteAgentServer;
  let baseUrl = "";
  const testToken = "test-secret-pairing-token-1234567890";

  before(async () => {
    server = new RemoteAgentServer({
      port: 0,
      host: "127.0.0.1",
      customToken: testToken,
      allowLocalhostBypass: false,
      enableWanAutoStart: false,
    });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  after(async () => {
    await server.stop();
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      fs.rmSync(
        path.join(os.homedir(), ".copilot", "attachments", "remote-agent", "test-review-session"),
        { recursive: true, force: true }
      );
    } catch {
      // Ignore
    }
  });

  it("strips workspace XML boilerplate from user prompts cleanly", () => {
    const raw = `<current_datetime>2026-10-18</current_datetime>\n<copilot_tauri_workspace>\nproject_name: test\n</copilot_tauri_workspace>\nHello from mobile!`;
    assert.equal(stripPromptBoilerplate(raw), "Hello from mobile!");
  });

  it("classifies image, 3D STL, markdown, and code artifacts accurately", () => {
    assert.equal(classifyFile("render.png").category, "image");
    assert.equal(classifyFile("part.stl").category, "3d");
    assert.equal(classifyFile("ARCHITECTURE.md").category, "document");
    assert.equal(classifyFile("report.json").category, "data");
  });

  it("enforces token authentication on /api/* when localhost bypass is disabled", async () => {
    const unauthRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(unauthRes.status, 401);

    const authRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(authRes.status, 200);
    const status = (await authRes.json()) as Record<string, unknown>;
    assert.equal(typeof status.hostname, "string");
    assert.equal(status.sdkAvailable, true);
    assert.equal(status.apkAvailable, true);
    assert.equal(status.desktopSetupAvailable, true);
    assert.ok(Array.isArray(status.mcpServers));
    const serverNames = (status.mcpServers as Array<{ name: string }>).map((s) => s.name);
    assert.ok(serverNames.includes("github-mcp-server"));
  });

  it("never bypasses auth when WAN proxy headers (CF-Connecting-IP / X-Forwarded-For) are present", async () => {
    const srvWithLocalBypass = new RemoteAgentServer({
      port: 0,
      host: "127.0.0.1",
      customToken: testToken,
      allowLocalhostBypass: true,
      enableWanAutoStart: false,
    });
    const info = await srvWithLocalBypass.start();
    const url = `http://127.0.0.1:${info.port}`;

    try {
      // Direct loopback works
      const localRes = await fetch(`${url}/api/status`);
      assert.equal(localRes.status, 200);

      // Tunneled WAN request via cloudflared (has CF-Connecting-IP) must require token!
      const wanUnauthRes = await fetch(`${url}/api/status`, {
        headers: { "CF-Connecting-IP": "203.0.113.50" },
      });
      assert.equal(wanUnauthRes.status, 401);

      const wanAuthRes = await fetch(`${url}/api/status`, {
        headers: {
          "CF-Connecting-IP": "203.0.113.50",
          Authorization: `Bearer ${testToken}`,
        },
      });
      assert.equal(wanAuthRes.status, 200);
    } finally {
      await srvWithLocalBypass.stop();
    }
  });

  it("serves the signed Android APK and Windows Desktop Installer via /download/*", async () => {
    const unauthApk = await fetch(`${baseUrl}/apk`);
    assert.equal(unauthApk.status, 401, "pre-paired APK must not be public");
    const unauthDownload = await fetch(`${baseUrl}/download/RemoteAgent-android.apk`);
    assert.equal(unauthDownload.status, 401);

    const apkRes = await fetch(`${baseUrl}/download/RemoteAgent-android.apk?token=${testToken}`);
    assert.equal(apkRes.status, 200);
    assert.equal(apkRes.headers.get("content-type"), "application/vnd.android.package-archive");
    const apkBytes = await apkRes.arrayBuffer();
    assert.ok(apkBytes.byteLength > 10_000, "APK should be a valid non-empty archive");

    const exeRes = await fetch(`${baseUrl}/download/RemoteAgent-Desktop-Setup.exe?token=${testToken}`);
    assert.equal(exeRes.status, 200);
    const exeBytes = await exeRes.arrayBuffer();
    assert.ok(exeBytes.byteLength > 50_000, "Setup EXE should be a valid Windows executable");
  });

  it("supports configuring and querying WAN endpoints via /api/wan/*", async () => {
    const beforeRes = await fetch(`${baseUrl}/api/wan/status?token=${testToken}`);
    const beforeData = (await beforeRes.json()) as { wan: { customWanUrl: string | null } };
    const prevCustomUrl = beforeData.wan?.customWanUrl || null;

    const customRes = await fetch(`${baseUrl}/api/wan/custom-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://demo-wan.trycloudflare.com" }),
    });
    assert.equal(customRes.status, 200);
    const customData = (await customRes.json()) as { wan: { publicUrl: string; status: string } };
    assert.equal(customData.wan.publicUrl, "https://demo-wan.trycloudflare.com");
    assert.equal(customData.wan.status, "online");

    // Restore previous WAN URL config
    await fetch(`${baseUrl}/api/wan/custom-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: prevCustomUrl }),
    });
  });

  it("multiplexes both HTTP and HTTPS (TLS) on the same port", async () => {
    const https = await import("node:https");
    const port = server.getPort();
    const tlsStatus = await new Promise<number>((resolve, reject) => {
      const req = https.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/health",
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
      req.on("error", reject);
    });
    assert.equal(tlsStatus, 200);
  });

  it("keeps answering malformed and oversized requests with 400/431 despite the clientError listener", async () => {
    const net = await import("node:net");
    const port = server.getPort();
    const rawExchange = (payload: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1", () => sock.write(payload));
        let data = "";
        sock.on("data", (d) => (data += d.toString("latin1")));
        sock.on("end", () => resolve(data));
        sock.on("error", (err) => (data ? resolve(data) : reject(err)));
        sock.setTimeout(5000, () => sock.destroy(new Error("timed out")));
      });
    const malformed = await rawExchange("BOGUS\r\n\r\n");
    assert.match(malformed, /^HTTP\/1\.1 400 /);
    const oversized = await rawExchange(`GET /api/health HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`);
    assert.match(oversized, /^HTTP\/1\.1 431 /);
  });

  it("lists real desktop sessions and parses turns, todos, and artifacts", async () => {
    const res = await fetch(`${baseUrl}/api/sessions?token=${testToken}`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      sessions: Array<{ id: string; title: string; isRunning: boolean; sessionType: string }>;
    };
    assert.ok(Array.isArray(data.sessions));
    assert.ok(data.sessions.length > 0, "Should discover active desktop sessions");

    // Inspect the first available session and verify turns, todos, and artifacts parse cleanly
    const targetId = data.sessions[0].id;

    const detailRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(targetId)}`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as {
      session: { id: string };
      turns: unknown[];
      artifacts: unknown[];
      subAgents: unknown[];
      todos: unknown[];
    };
    assert.equal(detail.session.id, targetId);
    assert.ok(Array.isArray(detail.turns));
    assert.ok(Array.isArray(detail.artifacts));
    assert.ok(Array.isArray(detail.subAgents));
    assert.ok(Array.isArray(detail.todos));

    // Verify UI session pinning & custom arrangement preferences (/api/ui-prefs)
    const prefsRes = await fetch(`${baseUrl}/api/ui-prefs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinnedSessionIds: [targetId],
        sessionOrderIds: [targetId],
        groupBy: "project",
        sortBy: "custom",
      }),
    });
    assert.equal(prefsRes.status, 200);
    const prefsData = (await prefsRes.json()) as {
      ok: boolean;
      uiPrefs: { pinnedSessionIds: string[]; groupBy: string };
    };
    assert.equal(prefsData.ok, true);
    assert.deepEqual(prefsData.uiPrefs.pinnedSessionIds, [targetId]);
  });

  it("blocks access to sensitive token files and paths outside allowed roots", async () => {
    const blockedRes = await fetch(
      `${baseUrl}/api/sessions/test/artifact?token=${testToken}&path=${encodeURIComponent(
        "C:\\Windows\\System32\\drivers\\etc\\hosts"
      )}`
    );
    assert.equal(blockedRes.status, 404);
  });

  it("creates, lists, and deletes mobile review comments with annotated images", async () => {
    const sessionId = "test-review-session";
    // 1x1 transparent PNG base64
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const createRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/reviews`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetType: "artifact",
        targetPath: "assembly_context.png",
        comment: "Increase clearance on upper cam arm by 0.4mm",
        annotatedImageBase64: tinyPng,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { review: { id: string; annotatedImageUrl?: string } };
    assert.ok(created.review.id);
    assert.ok(created.review.annotatedImageUrl);

    const listRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/reviews`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    const listed = (await listRes.json()) as { reviews: Array<{ id: string }> };
    assert.ok(listed.reviews.some((r) => r.id === created.review.id));

    const delRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/reviews/${created.review.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${testToken}` },
      }
    );
    assert.equal(delRes.status, 200);
  });

  it("never sends an Auto level a session hasn't confirmed, and offers plain Auto when it can't ask", async () => {
    // An unknown session can't list its own models. Any Auto levels shown for it are the account's, flagged
    // unverified; confirming them means loading the session, which fails, so no level is ever sent.
    const sessionId = "test-model-session-does-not-exist";
    const modelsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/models?token=${testToken}`);
    assert.equal(modelsRes.status, 200);
    const catalog = (await modelsRes.json()) as {
      models: unknown[];
      autoTiers: unknown[];
      autoTiersUnverified?: boolean;
      sessionId: string;
    };
    assert.ok(Array.isArray(catalog.models));
    assert.equal(catalog.sessionId, sessionId);
    assert.ok(catalog.autoTiers.length === 0 || catalog.autoTiersUnverified === true);

    const switchRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/config?token=${testToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", autoTier: "hydrafusion" }),
    });
    // 503 without a desktop app, 404 for a session it doesn't know; never sent either way.
    assert.ok([400, 404, 503].includes(switchRes.status), `unexpected status ${switchRes.status}`);
    const body = (await switchRes.json()) as { error?: string };
    assert.ok(body.error);
  });

  it("accepts authenticated WebSocket connections on /ws and sends initial state", async () => {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?token=${testToken}`;
    const firstMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on("message", (raw) => {
        const parsed = JSON.parse(String(raw));
        ws.close();
        resolve(parsed);
      });
      ws.on("error", reject);
    });
    assert.equal(firstMsg.type, "connected");
    assert.equal(typeof firstMsg.desktopAppConnected, "boolean");
  });

  it("discovers GitHub accounts and manages multi-desktop peer hosts via /api/peers", async () => {
    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      accounts: Array<{ login: string }>;
      peerHosts: Array<{ id: string }>;
    };
    assert.ok(Array.isArray(status.accounts), "Should return GitHub accounts array");
    assert.ok(Array.isArray(status.peerHosts), "Should return peerHosts array");

    const addPeerRes = await fetch(`${baseUrl}/api/peers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Secondary-Workstation",
        lanUrl: "http://192.168.1.50:4321",
        wanUrl: "https://workstation2.example.com:4321",
        token: "peer-token-xyz",
        accountLogin: "octocat",
      }),
    });
    assert.equal(addPeerRes.status, 200);
    const added = (await addPeerRes.json()) as {
      peers: Array<{ id: string; name: string; accountLogin?: string }>;
    };
    const found = added.peers.find((p) => p.name === "Secondary-Workstation");
    assert.ok(found, "Should include newly added peer host");
    assert.equal(found.accountLogin, "octocat");

    const delPeerRes = await fetch(`${baseUrl}/api/peers/${encodeURIComponent(found.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(delPeerRes.status, 200);
  });

  it("supports RFC 6238 Rolling 6-Digit TOTP MFA, 1-Tap Phone Approval, and Temporary Session Revocation", async () => {
    // 1. Fetch live TOTP code from /api/pair-info
    const pairRes = await fetch(`${baseUrl}/api/pair-info`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(pairRes.status, 200);
    const pairInfo = (await pairRes.json()) as {
      mfa: {
        code: string;
        secondsRemaining: number;
        otpauthUri: string;
        tempSessions: Array<{ id: string }>;
      };
    };
    assert.match(pairInfo.mfa.code, /^\d{6}$/, "Should generate a 6-digit TOTP code");
    assert.ok(pairInfo.mfa.otpauthUri.startsWith("otpauth://totp/"));

    // 2. Authenticate a new machine using the 6-digit MFA code
    const verifyRes = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: pairInfo.mfa.code,
        durationHours: 1,
        label: "Temp-Laptop",
      }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = (await verifyRes.json()) as {
      ok: boolean;
      token: string;
      isTempSession: boolean;
    };
    assert.equal(verifyData.ok, true);
    assert.equal(verifyData.isTempSession, true);
    assert.ok(verifyData.token.startsWith("tmp_"));

    // 3. Use the issued temporary token to access /api/status
    const tempStatusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${verifyData.token}` },
    });
    assert.equal(tempStatusRes.status, 200);

    // 4. Test 1-Tap Phone Push Login Approval flow
    const reqApprovalRes = await fetch(`${baseUrl}/api/auth/request-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Remote-Workstation", durationHours: 8 }),
    });
    assert.equal(reqApprovalRes.status, 200);
    const reqApproval = (await reqApprovalRes.json()) as { requestId: string; matchCode: string };
    assert.ok(reqApproval.requestId);
    assert.match(reqApproval.matchCode, /^\d{2}$/);

    // Approve from the already-paired phone
    const resolveRes = await fetch(`${baseUrl}/api/auth/resolve-approval`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: reqApproval.requestId,
        approved: true,
        durationHours: 8,
      }),
    });
    assert.equal(resolveRes.status, 200);

    const pollRes = await fetch(
      `${baseUrl}/api/auth/poll-approval?requestId=${encodeURIComponent(reqApproval.requestId)}`
    );
    assert.equal(pollRes.status, 200);
    const pollData = (await pollRes.json()) as { status: string; token: string };
    assert.equal(pollData.status, "approved");
    assert.ok(pollData.token.startsWith("tmp_"));

    // 5. Verify TOTP Replay Protection (re-using the same 6-digit code in the same 30s window is rejected)
    const replayRes = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.25",
      },
      body: JSON.stringify({ token: pairInfo.mfa.code }),
    });
    assert.equal(replayRes.status, 401, "Replayed 6-digit TOTP code must be rejected");
  });

  it("blocks internet vulnerability scanners and brute-force bots with automatic IP bans", async () => {
    // 1. Probing /.env from a WAN IP triggers an immediate 60-minute IP ban
    const scannerIp = "203.0.113.199";
    const envProbe = await fetch(`${baseUrl}/.env`, {
      headers: { "X-Forwarded-For": scannerIp },
    });
    assert.equal(envProbe.status, 404);

    // Subsequent API request from that banned scanner IP receives 429 Too Many Requests
    const afterProbe = await fetch(`${baseUrl}/api/status`, {
      headers: { "X-Forwarded-For": scannerIp },
    });
    assert.equal(afterProbe.status, 429, "Scanner IP should be banned after probing /.env");

    // 2. Brute-forcing /api/auth/verify 8 times locks out the attacker IP with 429
    const bruteIp = "198.51.100.88";
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${baseUrl}/api/auth/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": bruteIp,
        },
        body: JSON.stringify({ token: "000000" }),
      });
      assert.equal(r.status, 401);
    }

    const lockedRes = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": bruteIp,
      },
      body: JSON.stringify({ token: testToken }),
    });
    assert.equal(lockedRes.status, 429, "Brute-force IP must be locked out with HTTP 429");
  });
});
