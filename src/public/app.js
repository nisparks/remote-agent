// Copilot Remote Agent — Android Mobile Companion PWA Client

const state = {
  token: "",
  activePeerId: null,
  hubHostname: null,
  hubPeerHosts: [],
  hostStatus: null,
  sessions: [],
  activeSessionId: null,
  activeSession: null,
  turns: [],
  artifacts: [],
  subAgents: [],
  detachedShells: [],
  activeSubAgentId: null,
  activeDetachedShellId: null,
  todos: [],
  reviews: [],
  diff: null,
  streaming: null,
  pendingSteering: [],
  revealedTimestampTurnIds: new Set(),
  sessionCache: new Map(),
  uiPrefs: (() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ra_ui_prefs_v1") || "null");
      if (saved && typeof saved === "object") {
        return {
          pinnedSessionIds: Array.isArray(saved.pinnedSessionIds) ? saved.pinnedSessionIds : [],
          sessionOrderIds: Array.isArray(saved.sessionOrderIds) ? saved.sessionOrderIds : [],
          groupBy: saved.groupBy || "project",
          sortBy: saved.sortBy || "custom",
        };
      }
    } catch {}
    return {
      pinnedSessionIds: [],
      sessionOrderIds: [],
      groupBy: "project",
      sortBy: "custom",
    };
  })(),
  overlayDepth: 0,
  stickToBottom: true,
  expandAllTrace: localStorage.getItem("ra_expand_all_trace") === "1",
  uiVersion: null,
  activeTab: "stream",
  artifactFilter: "all",
  stagedAttachments: [],
  ws: null,
  // Image viewer & annotation state
  currentImageArtifact: null,
  baseImageObj: null,
  imageMode: "view",
  imgZoom: 1.0,
  imgPanX: 0,
  imgPanY: 0,
  imgBaseW: 320,
  imgBaseH: 240,
  imgFillWidthZoom: 1.0,
  strokes: [],
  currentStroke: null,
  // 3D STL state
  stlTriangles: [],
  stlRotationX: -0.65,
  stlRotationZ: 0.6,
  stlZoom: 1.0,
  stlPanX: 0,
  stlPanY: 0,
  stlWireframe: false,
  currentStlArtifact: null,
  currentDocArtifact: null,
};

// --- Token & API Helpers ---
async function initTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = (params.get("token") || "").trim();
  if (urlToken) {
    params.delete("token");
    const cleanUrl =
      window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl);

    // If user entered a 6-digit MFA code in the Android app or URL, exchange it for a 30-day session token
    if (/^\d{6}$/.test(urlToken.replace(/[\s-]/g, ""))) {
      try {
        const r = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: urlToken, durationHours: 720, label: "Paired Device" }),
        });
        const d = await r.json();
        if (r.ok && d.token) {
          localStorage.setItem("ra_token", d.token);
          state.token = d.token;
          return;
        }
      } catch {}
    }

    localStorage.setItem("ra_token", urlToken);
    state.token = urlToken;
  } else {
    state.token = localStorage.getItem("ra_token") || "";
  }
}

function resolvePeerPath(url) {
  if (
    state.activePeerId &&
    url.startsWith("/api/") &&
    !url.startsWith("/api/peers") &&
    !url.startsWith("/api/pair-info") &&
    !url.startsWith("/api/wan/") &&
    !url.startsWith("/api/auth/") &&
    !url.startsWith("/api/peer-proxy/")
  ) {
    return `/api/peer-proxy/${encodeURIComponent(state.activePeerId)}${url}`;
  }
  return url;
}

function withTokenUrl(url) {
  const routed = resolvePeerPath(url);
  if (!state.token) return routed;
  const sep = routed.includes("?") ? "&" : "?";
  return `${routed}${sep}token=${encodeURIComponent(state.token)}`;
}

async function apiFetch(path, options = {}) {
  const routedPath = resolvePeerPath(path);
  const headers = {
    ...(options.headers || {}),
  };
  if (state.token) {
    headers["Authorization"] = `Bearer ${state.token}`;
  }
  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(routedPath, { ...options, headers });
  if (res.status === 401) {
    openQrModal();
    throw new Error("Unauthorized — please scan the pairing QR code or enter your token.");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(rawText) {
  if (!rawText) return "";
  const codeBlocks = [];
  let text = String(rawText).replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const cleanLang = escapeHtml(lang || "code");
    const escapedCode = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(
      `<div class="code-block-wrap"><div class="code-block-header"><span>${cleanLang}</span></div><pre><code>${escapedCode}</code></pre></div>`
    );
    return `@@CODE_BLOCK_${idx}@@`;
  });

  text = escapeHtml(text);

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Bold & Italic
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  // Markdown links [text](url)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Process lines for headings, tables & lists
  const lines = text.split(/\r?\n/);
  const out = [];
  let inList = false;
  let tableRows = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    if (tableRows.length >= 2 && /^[\s|:-]+$/.test(tableRows[1].replace(/\|/g, ""))) {
      const parseCells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const headers = parseCells(tableRows[0]);
      const bodyRows = tableRows.slice(2).map(parseCells);
      out.push(
        `<div class="table-wrap"><table><thead><tr>${headers
          .map((h) => `<th>${h}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`
      );
    } else {
      for (const r of tableRows) out.push(`<p>${r}</p>`);
    }
    tableRows = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      tableRows.push(trimmed);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    if (/^@@CODE_BLOCK_\d+@@$/.test(trimmed)) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(trimmed);
      continue;
    }
    const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = hMatch[1].length;
      out.push(`<h${level}>${hMatch[2]}</h${level}>`);
      continue;
    }
    const liMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (liMatch) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${liMatch[1]}</li>`);
      continue;
    }
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (!trimmed) {
      out.push("<div style='height:6px'></div>");
    } else {
      out.push(`<p>${line}</p>`);
    }
  }
  if (tableRows.length > 0) flushTable();
  if (inList) out.push("</ul>");

  let result = out.join("");
  result = result.replace(/@@CODE_BLOCK_(\d+)@@/g, (_m, i) => codeBlocks[Number(i)] || "");
  return result;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimeAgo(iso) {
  if (!iso) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatShortClockTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isToday) return timeStr;
  const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr}, ${timeStr}`;
}

function formatFullMessageTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const timeStr = d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const datePart = isToday
    ? "Today"
    : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const rel = formatTimeAgo(iso);
  return `${datePart} at ${timeStr}${rel ? ` · ${rel}` : ""}`;
}

// --- WebSocket Live Connection & Persistent Heartbeat ---
let wsHeartbeatTimer = null;

function connectWebSocket() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
  }
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = withTokenUrl(`${proto}//${window.location.host}/ws`);
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    updateHostBanner();
    wsHeartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }
    }, 15000);
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleLiveWsMessage(msg);
    } catch {}
  };

  ws.onclose = () => {
    if (wsHeartbeatTimer) {
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = null;
    }
    setTimeout(async () => {
      // If we were on a LAN IP and Wi-Fi was turned off (switched to 5G/WAN), auto-failover to WAN URL!
      const isPrivateLanHost = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(
        window.location.hostname
      );
      const savedWanUrl =
        state.hostStatus?.wan?.publicUrl || localStorage.getItem("ra_wan_url") || "";

      if (isPrivateLanHost && savedWanUrl) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 1800);
          const r = await fetch("/api/health", { signal: ctrl.signal });
          clearTimeout(timer);
          if (r.ok) {
            connectWebSocket();
            return;
          }
        } catch {
          // LAN is unreachable — fail over to WAN URL!
          const tok = state.token || localStorage.getItem("ra_token") || "";
          if (window.AndroidNative && typeof window.AndroidNative.connectTo === "function") {
            window.AndroidNative.connectTo(savedWanUrl.replace(/\/+$/, ""), tok);
            return;
          }
          const targetWan = `${savedWanUrl.replace(/\/+$/, "")}/?token=${encodeURIComponent(tok)}`;
          window.location.href = targetWan;
          return;
        }
      }
      connectWebSocket();
    }, 2500);
  };
}

let refreshDebounce = null;
function scheduleActiveSessionRefresh(delay = 300) {
  if (refreshDebounce) clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => {
    loadSessionsList(false);
    if (state.activeSessionId) {
      loadSessionDetail(state.activeSessionId, false);
    }
  }, delay);
}

function handleLiveWsMessage(msg) {
  if (msg.type === "connected" || msg.type === "ui_reload") {
    if (msg.uiVersion) {
      if (state.uiVersion && state.uiVersion !== msg.uiVersion) {
        // Server UI assets changed — immediately hot-reload with cache-busting query!
        const url = new URL(window.location.href);
        url.searchParams.set("_v", msg.uiVersion);
        window.location.replace(url.toString());
        return;
      }
      state.uiVersion = msg.uiVersion;
    }
  }

  if (msg.type === "desktop_status") {
    if (state.hostStatus) {
      state.hostStatus.desktopAppConnected = msg.connected;
      updateHostBanner();
    }
  } else if (msg.type === "wan_status") {
    if (state.hostStatus && msg.wan) {
      state.hostStatus.wan = msg.wan;
      updateHostBanner();
    }
    if (document.getElementById("qrModal")?.classList.contains("open")) {
      refreshQrModalInfo();
    }
  } else if (msg.type === "login_approval_request" && msg.request) {
    renderLoginApprovalBanner(msg.request);
  } else if (msg.type === "login_approval_resolved") {
    const banner = document.getElementById("loginApprovalBanner");
    if (banner) {
      banner.style.display = "none";
      banner.innerHTML = "";
    }
  } else if (msg.type === "ui_prefs_updated" && msg.uiPrefs) {
    state.uiPrefs = msg.uiPrefs;
    localStorage.setItem("ra_ui_prefs_v1", JSON.stringify(state.uiPrefs));
    syncArrangeSelects();
    renderSessionsList();
  } else if (msg.type === "sessions_updated") {
    loadSessionsList(false);
  } else if (msg.type === "steering_queued") {
    if (msg.sessionId === state.activeSessionId && msg.steeringItem) {
      const exists = state.pendingSteering.some((x) => x.id === msg.steeringItem.id || x.prompt === msg.steeringItem.prompt);
      if (!exists) {
        state.pendingSteering.push(msg.steeringItem);
        renderTurns(true);
      }
    }
  } else if (msg.type === "session_file_updated") {
    if (msg.sessionId === state.activeSessionId) {
      scheduleActiveSessionRefresh(250);
    } else {
      loadSessionsList(false);
    }
  } else if (msg.type === "session_event") {
    const { sessionId, event } = msg;
    if (sessionId !== state.activeSessionId || !event) return;
    const evType = event.type || "";
    const evData = event.data || {};

    if (evType === "assistant.message_delta") {
      if (!state.streaming) state.streaming = { content: "", reasoning: "" };
      state.streaming.content += String(evData.deltaContent || "");
      renderStreamingTurn();
    } else if (evType === "assistant.reasoning_delta") {
      if (!state.streaming) state.streaming = { content: "", reasoning: "" };
      state.streaming.reasoning += String(evData.deltaContent || evData.delta || "");
      renderStreamingTurn();
    } else if (
      evType === "assistant.message" ||
      evType === "user.message" ||
      evType === "tool.execution_complete" ||
      evType === "assistant.turn_end"
    ) {
      state.streaming = null;
      scheduleActiveSessionRefresh(200);
    }
  }
}

// --- Back Gesture / History Overlay Management ---
function pushOverlayHistory(name) {
  state.overlayDepth += 1;
  window.history.pushState({ overlay: name, depth: state.overlayDepth }, "");
}

function closeAnyOpenOverlay() {
  for (const id of ["imageModal", "stlModal", "docModal", "qrModal"]) {
    const el = document.getElementById(id);
    if (el && el.classList.contains("open")) {
      el.classList.remove("open");
      return true;
    }
  }
  const drawer = document.getElementById("sessionsPanel");
  if (drawer && drawer.classList.contains("mobile-open")) {
    drawer.classList.remove("mobile-open");
    return true;
  }
  if (state.activeSubAgentId || state.activeDetachedShellId) {
    state.activeSubAgentId = null;
    state.activeDetachedShellId = null;
    renderAgentHierarchyBar();
    renderTurns(false);
    return true;
  }
  if (state.activeTab !== "stream") {
    document.querySelector('.view-tab[data-tab="stream"]')?.click();
    return true;
  }
  return false;
}

function closeModalWithHistory(modalId) {
  const el = document.getElementById(modalId);
  if (el && el.classList.contains("open")) {
    el.classList.remove("open");
    if (state.overlayDepth > 0 && window.history.state?.overlay) {
      state.overlayDepth = Math.max(0, state.overlayDepth - 1);
      window.history.back();
    }
  }
}

window.addEventListener("popstate", () => {
  if (state.overlayDepth > 0) {
    state.overlayDepth = Math.max(0, state.overlayDepth - 1);
  }
  closeAnyOpenOverlay();
});

window.__handleAndroidBack = () => {
  return closeAnyOpenOverlay();
};

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    for (const id of ["imageModal", "stlModal", "docModal", "qrModal"]) {
      const el = document.getElementById(id);
      if (el && el.classList.contains("open")) {
        e.preventDefault();
        closeModalWithHistory(id);
        return;
      }
    }
    const drawer = document.getElementById("sessionsPanel");
    if (drawer && drawer.classList.contains("mobile-open")) {
      e.preventDefault();
      drawer.classList.remove("mobile-open");
    }
  }
});

// Instant resume when phone wakes up or switches back to the app
function ensureLiveConnectionOnWake() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }
  loadHostStatus();
  if (state.activeSessionId) {
    loadSessionDetail(state.activeSessionId, false);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    ensureLiveConnectionOnWake();
  }
});
window.addEventListener("online", ensureLiveConnectionOnWake);
window.__onAppResume = ensureLiveConnectionOnWake;

// --- Data Loading & Instant Client Cache ---
let prefetchScheduled = false;
function schedulePrefetchTopSessions() {
  if (prefetchScheduled) return;
  prefetchScheduled = true;
  setTimeout(async () => {
    const candidates = state.sessions
      .filter((s) => s.id !== state.activeSessionId && !state.sessionCache.has(s.id))
      .slice(0, 6);
    for (const s of candidates) {
      try {
        const data = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}`);
        state.sessionCache.set(s.id, {
          ...data,
          cachedAt: Date.now(),
        });
      } catch {
        // Ignore background prefetch errors
      }
    }
  }, 600);
}

async function loadHostStatus() {
  try {
    state.hostStatus = await apiFetch("/api/status");
    if (state.hostStatus?.uiPrefs) {
      // Merge server uiPrefs if non-empty or adopt server state
      const sp = state.hostStatus.uiPrefs;
      if (
        (sp.pinnedSessionIds && sp.pinnedSessionIds.length > 0) ||
        (sp.sessionOrderIds && sp.sessionOrderIds.length > 0) ||
        state.uiPrefs.pinnedSessionIds.length === 0
      ) {
        state.uiPrefs = sp;
        localStorage.setItem("ra_ui_prefs_v1", JSON.stringify(state.uiPrefs));
        syncArrangeSelects();
        renderSessionsList();
      }
    }
    if (!state.activePeerId && state.hostStatus) {
      state.hubHostname = state.hostStatus.hostname;
      state.hubPeerHosts = state.hostStatus.peerHosts || [];
    } else if (state.activePeerId && state.hubPeerHosts.length === 0) {
      try {
        const pr = await apiFetch("/api/peers");
        state.hubPeerHosts = pr.peers || [];
      } catch {}
    }
    populateModelSelectOptions();
    updateHostBanner();
    renderMcpStrip();
    renderHostSwitcherStrip();
    renderQuotaDrawerCard();
    renderWorkspaceStatusBar();
    renderTodosAndMcps();
    const lan = (state.hostStatus.lanUrls && state.hostStatus.lanUrls[0]) || "";
    const wan =
      state.hostStatus.wan?.publicUrl ||
      (state.hostStatus.tailscaleUrls && state.hostStatus.tailscaleUrls[0]) ||
      "";
    if (lan) localStorage.setItem("ra_lan_url", lan);
    if (wan) localStorage.setItem("ra_wan_url", wan);
    if (window.AndroidNative && typeof window.AndroidNative.syncEndpoints === "function") {
      window.AndroidNative.syncEndpoints(wan || lan, wan, state.token || "");
    }
  } catch {}
}

function renderHostSwitcherStrip() {
  const strip = document.getElementById("hostSwitcherStrip");
  if (!strip || !state.hostStatus) return;

  const hs = state.hostStatus;
  const hubName = state.hubHostname || hs.hostname;
  const acctBadge = hs.primaryAccount
    ? `<span class="host-pill-acct">@${escapeHtml(hs.primaryAccount)}</span>`
    : "";

  const currentHostHtml = `
    <div class="host-pill ${!state.activePeerId ? "active" : ""} hub-host-btn" title="Primary Hub Desktop">
      <span class="status-dot online"></span>
      <span>🖥️ ${escapeHtml(hubName)}</span>
      ${!state.activePeerId ? acctBadge : ""}
    </div>
  `;

  // Merge server-saved peerHosts + localStorage saved hosts
  let localPeers = [];
  try {
    localPeers = JSON.parse(localStorage.getItem("ra_saved_hosts") || "[]");
  } catch {}
  const basePeers = state.hubPeerHosts.length > 0 ? state.hubPeerHosts : hs.peerHosts || [];
  const allPeers = [...basePeers];
  for (const lp of localPeers) {
    if (!allPeers.some((p) => p.lanUrl === lp.lanUrl)) {
      allPeers.push(lp);
    }
  }

  const peersHtml = allPeers
    .filter((p) => p.name.toLowerCase() !== hubName.toLowerCase())
    .map(
      (p) => `
      <div class="host-pill peer-host-btn ${state.activePeerId === p.id ? "active" : ""}" data-peer-id="${escapeHtml(p.id)}">
        <span>🖥️ ${escapeHtml(p.name)}</span>
        ${p.accountLogin ? `<span class="host-pill-acct">@${escapeHtml(p.accountLogin.replace(/^@/, ""))}</span>` : ""}
      </div>
    `
    )
    .join("");

  const addHostBtnHtml = `
    <button id="addPeerHostBtn" class="host-pill" style="color: var(--accent);" title="Add another Desktop or Server">+ Desktop</button>
  `;

  strip.innerHTML = currentHostHtml + peersHtml + addHostBtnHtml;

  strip.querySelector(".hub-host-btn")?.addEventListener("click", async () => {
    if (!state.activePeerId) return;
    state.activePeerId = null;
    state.activeSessionId = null;
    state.sessionCache.clear();
    await Promise.all([loadHostStatus(), loadSessionsList(true)]);
  });

  strip.querySelectorAll(".peer-host-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const peerId = btn.getAttribute("data-peer-id") || "";
      if (!peerId || state.activePeerId === peerId) return;
      state.activePeerId = peerId;
      state.activeSessionId = null;
      state.sessionCache.clear();
      await Promise.all([loadHostStatus(), loadSessionsList(true)]);
    });
  });

  document.getElementById("addPeerHostBtn")?.addEventListener("click", async () => {
    const pairingUrl = window.prompt(
      "Paste the Pairing URL from your other Desktop/Server (e.g. http://192.168.1.50:4321/?token=... or https://.../?token=...):"
    );
    if (!pairingUrl || !pairingUrl.trim()) return;

    let name = "";
    let token = "";
    if (!pairingUrl.includes("?token=")) {
      token = window.prompt("Pairing Token for that Desktop (optional if already paired):") || "";
      name = window.prompt("Machine Name (optional — auto-detected if reachable):") || "";
    }

    try {
      const res = await apiFetch("/api/peers", {
        method: "POST",
        body: {
          pairingUrl: pairingUrl.trim(),
          name: name.trim() || undefined,
          token: token.trim() || undefined,
        },
      });
      localStorage.setItem("ra_saved_hosts", JSON.stringify(res.peers || []));
      await loadHostStatus();
    } catch (err) {
      alert(`Failed to add desktop host: ${err.message}`);
    }
  });
}

async function loadSessionsList(autoSelectFirst = true) {
  try {
    const data = await apiFetch("/api/sessions");
    state.sessions = data.sessions || [];
    try {
      localStorage.setItem("ra_persisted_sessions_v1", JSON.stringify(state.sessions.slice(0, 25)));
    } catch {}
    renderSessionsList();
    if (autoSelectFirst && !state.activeSessionId && state.sessions.length > 0) {
      const savedId = localStorage.getItem("ra_active_session_id");
      const match = savedId && state.sessions.find((s) => s.id === savedId);
      await selectSession(match ? match.id : state.sessions[0].id);
    }
    schedulePrefetchTopSessions();
  } catch {}
}

function applySessionPayload(data, scrollBottom = false) {
  const switchedSession = state.activeSession?.id !== data.session?.id;
  state.activeSession = data.session;
  state.turns = data.turns || [];
  state.artifacts = data.artifacts || [];
  state.subAgents = data.subAgents || [];
  state.detachedShells = data.detachedShells || [];
  if (switchedSession) {
    state.activeSubAgentId = null;
    state.activeDetachedShellId = null;
  }
  state.todos = data.todos || [];
  state.reviews = data.reviews || [];
  state.pendingSteering = data.pendingSteering || [];
  if (data.streaming) {
    state.streaming = data.streaming;
  }

  try {
    localStorage.setItem(
      "ra_persisted_active_detail_v1",
      JSON.stringify({
        session: data.session,
        turns: (data.turns || []).slice(-60),
        artifacts: (data.artifacts || []).slice(0, 40),
        subAgents: (data.subAgents || []).slice(0, 20),
        detachedShells: data.detachedShells || [],
        todos: data.todos || [],
        reviews: data.reviews || [],
        pendingSteering: data.pendingSteering || [],
      })
    );
  } catch {}

  renderSessionHeader();
  renderAgentHierarchyBar();
  renderActionBanner();
  renderWorkspaceStatusBar();
  renderTurns(scrollBottom);
  renderArtifactsGallery();
  renderReviewsQueue();
  renderTodosAndMcps();
  if (scrollBottom || state.stickToBottom) {
    scrollStreamToBottomIfSticky(scrollBottom);
  }
}

async function selectSession(sessionId) {
  state.activeSessionId = sessionId;
  state.activeSubAgentId = null;
  state.activeDetachedShellId = null;
  state.stickToBottom = true;
  updateJumpToBottomButton();
  localStorage.setItem("ra_active_session_id", sessionId);
  state.streaming = null;
  state.diff = null;
  document.getElementById("sessionsPanel")?.classList.remove("mobile-open");
  renderSessionsList();

  // 1. Instant 0ms render from client cache if available!
  const cached = state.sessionCache.get(sessionId);
  if (cached) {
    applySessionPayload(cached, true);
    // Revalidate in background and ensure we scroll to bottom of fresh turns
    loadSessionDetail(sessionId, true);
  } else {
    // Immediately update header from state.sessions summary so title switches in 0ms
    const summary = state.sessions.find((s) => s.id === sessionId);
    if (summary) {
      state.activeSession = summary;
      renderSessionHeader();
    }
    state.turns = [];
    state.artifacts = [];
    state.subAgents = [];
    state.detachedShells = [];
    state.todos = [];
    state.reviews = [];
    state.pendingSteering = [];
    renderAgentHierarchyBar();
    const container = document.getElementById("turnsContainer");
    if (container) {
      container.innerHTML = `<div style="text-align:center;padding:28px;color:var(--text-secondary);">Loading session...</div>`;
    }
    await loadSessionDetail(sessionId, true);
  }

  if (state.activeTab === "reviews") {
    await loadSessionDiff(sessionId);
  }
}

async function loadSessionDetail(sessionId, scrollBottom = false) {
  try {
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const prevCached = state.sessionCache.get(sessionId);
    state.sessionCache.set(sessionId, { ...data, cachedAt: Date.now() });
    if (state.activeSessionId !== sessionId) return;

    // If we already rendered from cache and nothing changed, skip full DOM rebuild
    if (
      !scrollBottom &&
      prevCached &&
      prevCached.turns?.length === data.turns?.length &&
      prevCached.artifacts?.length === data.artifacts?.length &&
      prevCached.subAgents?.length === data.subAgents?.length &&
      prevCached.detachedShells?.length === data.detachedShells?.length &&
      prevCached.pendingSteering?.length === data.pendingSteering?.length &&
      prevCached.turns?.[prevCached.turns.length - 1]?.content ===
        data.turns?.[data.turns.length - 1]?.content &&
      prevCached.turns?.[prevCached.turns.length - 1]?.toolCalls?.length ===
        data.turns?.[data.turns.length - 1]?.toolCalls?.length
    ) {
      state.activeSession = data.session;
      renderSessionHeader();
      renderActionBanner();
      if (state.stickToBottom) {
        scrollStreamToBottomIfSticky(false);
      }
      return;
    }

    applySessionPayload(data, scrollBottom || state.stickToBottom);
  } catch (err) {
    console.error("Failed to load session detail:", err);
  }
}

async function loadSessionDiff(sessionId) {
  const container = document.getElementById("diffContainer");
  if (!container) return;
  container.innerHTML = `<div style="color: var(--text-secondary);">Loading workspace Git diff...</div>`;
  try {
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/diff`);
    if (state.activeSessionId !== sessionId) return;
    state.diff = data.diff;
    renderDiff();
  } catch (err) {
    if (state.activeSessionId !== sessionId) return;
    container.innerHTML = `<div style="color: var(--danger);">Failed to load diff: ${escapeHtml(err.message)}</div>`;
  }
}

// --- UI Rendering ---
function updateHostBanner() {
  const dot = document.getElementById("hostStatusDot");
  const text = document.getElementById("hostStatusText");
  if (!dot || !text || !state.hostStatus) return;

  const hs = state.hostStatus;
  if (hs.desktopAppConnected) {
    dot.className = "status-dot online";
    text.textContent = `${hs.hostname} • ${hs.activeSessionsCount} active`;
  } else if (hs.sdkAvailable) {
    dot.className = "status-dot warning";
    text.textContent = `${hs.hostname} • SDK (${hs.activeSessionsCount} active)`;
  } else {
    dot.className = "status-dot";
    text.textContent = `${hs.hostname} • Watcher`;
  }
}

function populateModelSelectOptions() {
  const sel = document.getElementById("sessionModelSelect");
  if (!sel || !state.hostStatus?.availableModels) return;
  const models = state.hostStatus.availableModels;
  if (!Array.isArray(models) || models.length === 0) return;

  const currentVal = state.activeSession?.model || sel.value || "auto";
  sel.innerHTML = models
    .map(
      (m) =>
        `<option value="${escapeHtml(m.id)}" ${
          m.id === currentVal ? "selected" : ""
        }>${escapeHtml(m.name)}</option>`
    )
    .join("");
}

function renderMcpStrip() {
  const el = document.getElementById("mcpStrip");
  if (!el || !state.hostStatus) return;
  const servers = state.hostStatus.mcpServers || [];
  el.innerHTML = servers
    .filter((s) => s.enabled)
    .map(
      (s) =>
        `<span class="mcp-pill" title="${escapeHtml(s.tools.join(", "))}">${escapeHtml(
          s.name
        )}</span>`
    )
    .join("");
}

function syncArrangeSelects() {
  const grpSel = document.getElementById("sessionGroupBySelect");
  const srtSel = document.getElementById("sessionSortBySelect");
  if (grpSel && state.uiPrefs?.groupBy) grpSel.value = state.uiPrefs.groupBy;
  if (srtSel && state.uiPrefs?.sortBy) srtSel.value = state.uiPrefs.sortBy;
}

async function saveUiPrefsToServer() {
  try {
    localStorage.setItem("ra_ui_prefs_v1", JSON.stringify(state.uiPrefs));
    await apiFetch("/api/ui-prefs", {
      method: "POST",
      body: state.uiPrefs,
    });
  } catch {}
}

function togglePinSession(sessionId) {
  const pinned = [...(state.uiPrefs.pinnedSessionIds || [])];
  const idx = pinned.indexOf(sessionId);
  if (idx >= 0) {
    pinned.splice(idx, 1);
  } else {
    pinned.unshift(sessionId);
  }
  state.uiPrefs.pinnedSessionIds = pinned;
  renderSessionsList();
  saveUiPrefsToServer();
}

function moveSessionInOrder(sessionId, delta, currentIdsList) {
  const isPinned = (state.uiPrefs.pinnedSessionIds || []).includes(sessionId);
  if (isPinned) {
    const pinned = [...state.uiPrefs.pinnedSessionIds];
    const i = pinned.indexOf(sessionId);
    const nextIdx = i + delta;
    if (i < 0 || nextIdx < 0 || nextIdx >= pinned.length) return;
    const [item] = pinned.splice(i, 1);
    pinned.splice(nextIdx, 0, item);
    state.uiPrefs.pinnedSessionIds = pinned;
  } else {
    const baseOrder =
      state.uiPrefs.sessionOrderIds && state.uiPrefs.sessionOrderIds.length > 0
        ? [...state.uiPrefs.sessionOrderIds]
        : [...currentIdsList];
    // Ensure all current IDs exist in baseOrder
    for (const id of currentIdsList) {
      if (!baseOrder.includes(id)) baseOrder.push(id);
    }
    const i = baseOrder.indexOf(sessionId);
    const nextIdx = i + delta;
    if (i < 0 || nextIdx < 0 || nextIdx >= baseOrder.length) return;
    const [item] = baseOrder.splice(i, 1);
    baseOrder.splice(nextIdx, 0, item);
    state.uiPrefs.sessionOrderIds = baseOrder;
    state.uiPrefs.sortBy = "custom";
    syncArrangeSelects();
  }
  renderSessionsList();
  saveUiPrefsToServer();
}

function renderSessionCardHtml(s, isChild = false) {
  const isActive = s.id === state.activeSessionId;
  const isPinned = (state.uiPrefs?.pinnedSessionIds || []).includes(s.id);
  let badgeClass = s.isRunning ? "badge-busy" : "badge-idle";
  let badgeText = s.isRunning ? "Running" : "";
  if (s.awaitingUserInput) {
    badgeClass = "badge-alert";
    badgeText = "Input";
  } else if (s.awaitingPlanApproval) {
    badgeClass = "badge-alert";
    badgeText = "Plan";
  } else if (s.wasInterrupted && !s.isRunning) {
    badgeClass = "badge-alert";
    badgeText = "Paused";
  }

  const runningAgents = s.counts?.runningSubAgents || 0;
  const totalAgents = s.counts?.subAgents || 0;
  const childCount = state.sessions.filter((x) => x.parentSessionId === s.id).length;
  let subAgentBadgeHtml = "";
  if (runningAgents > 0) {
    subAgentBadgeHtml = `<span class="subagent-badge" title="Active background sub-agents">⚡ ${runningAgents} agent${runningAgents > 1 ? "s" : ""}</span>`;
  } else if (totalAgents > 0 || childCount > 0) {
    const countLabel = totalAgents + childCount;
    subAgentBadgeHtml = `<span class="subagent-badge" title="Sub-agents / child sessions">${countLabel} sub-agent${countLabel > 1 ? "s" : ""}</span>`;
  } else if (s.parentSessionId && !isChild) {
    subAgentBadgeHtml = `<span class="subagent-badge" title="Child / Sub-session">Sub-session</span>`;
  }

  return `
    <div class="session-card ${isActive ? "active" : ""} ${isChild ? "child-session" : ""}" data-session-id="${escapeHtml(s.id)}">
      <div class="session-card-top">
        <div class="session-card-title">${isChild ? "↳ " : ""}${escapeHtml(s.title)}</div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
          ${subAgentBadgeHtml}
          ${badgeText ? `<span class="badge ${badgeClass}">${badgeText}</span>` : ""}
        </div>
      </div>
      <div class="session-card-meta">
        ${s.accountLogin ? `<span style="color:var(--text-secondary);">@${escapeHtml(s.accountLogin)}</span>` : ""}
        ${s.branch ? `<span>#${escapeHtml(s.branch)}</span>` : ""}
        <span>${formatTimeAgo(s.updatedAt)}</span>
        <div class="session-card-actions">
          <button class="session-action-btn move-up-btn" data-session-id="${escapeHtml(s.id)}" title="Move Up">↑</button>
          <button class="session-action-btn move-down-btn" data-session-id="${escapeHtml(s.id)}" title="Move Down">↓</button>
          <button class="session-action-btn pin-btn ${isPinned ? "pinned" : ""}" data-session-id="${escapeHtml(s.id)}" title="${isPinned ? "Unpin session" : "Pin session to top"}">${isPinned ? "★" : "☆"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderSessionsList() {
  const listEl = document.getElementById("sessionsList");
  const searchVal = (document.getElementById("sessionSearchInput")?.value || "")
    .trim()
    .toLowerCase();
  if (!listEl) return;

  const pinnedIds = state.uiPrefs?.pinnedSessionIds || [];
  const orderIds = state.uiPrefs?.sessionOrderIds || [];
  const groupBy = state.uiPrefs?.groupBy || "project";
  const sortBy = state.uiPrefs?.sortBy || "custom";

  const orderIndexMap = new Map(orderIds.map((id, idx) => [id, idx]));

  const sortItems = (arr) => {
    return [...arr].sort((a, b) => {
      if (sortBy === "title") {
        return (a.title || "").localeCompare(b.title || "");
      }
      if (sortBy === "recent") {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      // "custom": respect orderIds first, then running status, then updatedAt
      const ia = orderIndexMap.has(a.id) ? orderIndexMap.get(a.id) : 999999;
      const ib = orderIndexMap.has(b.id) ? orderIndexMap.get(b.id) : 999999;
      if (ia !== ib) return ia - ib;
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  };

  const filtered = sortItems(
    state.sessions.filter((s) => {
      if (!searchVal) return true;
      const hay = `${s.title} ${s.projectName || ""} ${s.repository || ""} ${s.branch || ""}`.toLowerCase();
      return hay.includes(searchVal);
    })
  );

  const visibleOrderIds = filtered.map((s) => s.id);

  if (searchVal) {
    listEl.innerHTML = filtered.map((s) => renderSessionCardHtml(s, false)).join("");
  } else {
    const pinnedSet = new Set(pinnedIds);
    const byId = new Map(filtered.map((s) => [s.id, s]));
    const pinnedSessions = pinnedIds.map((id) => byId.get(id)).filter(Boolean);
    const unpinned = filtered.filter((s) => !pinnedSet.has(s.id));

    const pinSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const folderSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const chatSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

    const sectionsHtml = [];
    if (pinnedSessions.length > 0) {
      sectionsHtml.push(
        `<div class="session-group-label" style="color:#58a6ff;">${pinSvg} <span>Pinned (${pinnedSessions.length})</span></div>` +
          pinnedSessions.map((s) => renderSessionCardHtml(s, false)).join("")
      );
    }

    if (groupBy === "flat") {
      sectionsHtml.push(
        `<div class="session-group-label">${folderSvg} <span>All Sessions (${unpinned.length})</span></div>` +
          unpinned.map((s) => renderSessionCardHtml(s, false)).join("")
      );
    } else if (groupBy === "status") {
      const activeList = unpinned.filter(
        (s) => s.isRunning || s.awaitingUserInput || s.awaitingPlanApproval
      );
      const idleList = unpinned.filter(
        (s) => !(s.isRunning || s.awaitingUserInput || s.awaitingPlanApproval)
      );
      if (activeList.length > 0) {
        sectionsHtml.push(
          `<div class="session-group-label" style="color:var(--success);"><span>● Active &amp; Waiting (${activeList.length})</span></div>` +
            activeList.map((s) => renderSessionCardHtml(s, false)).join("")
        );
      }
      if (idleList.length > 0) {
        sectionsHtml.push(
          `<div class="session-group-label"><span>Idle Sessions (${idleList.length})</span></div>` +
            idleList.map((s) => renderSessionCardHtml(s, false)).join("")
        );
      }
    } else {
      // "project": Group by Project folders with child session nesting under parent
      const unpinnedById = new Map(unpinned.map((s) => [s.id, s]));
      const childrenByParent = new Map();
      for (const s of unpinned) {
        if (s.parentSessionId && unpinnedById.has(s.parentSessionId)) {
          const arr = childrenByParent.get(s.parentSessionId) || [];
          arr.push(s);
          childrenByParent.set(s.parentSessionId, arr);
        }
      }

      const renderWithChildren = (s) => {
        const kids = childrenByParent.get(s.id) || [];
        return (
          renderSessionCardHtml(s, false) +
          kids.map((k) => renderSessionCardHtml(k, true)).join("")
        );
      };

      const topLevel = unpinned.filter((s) => !(s.parentSessionId && unpinnedById.has(s.parentSessionId)));
      const projectGroups = new Map();
      const chats = [];

      for (const s of topLevel) {
        if (s.sessionType === "general_chat" && !s.projectName) {
          chats.push(s);
        } else {
          const key = s.projectName || s.repository || "Workspace";
          const grp = projectGroups.get(key) || [];
          grp.push(s);
          projectGroups.set(key, grp);
        }
      }

      for (const [projName, items] of projectGroups.entries()) {
        sectionsHtml.push(
          `<div class="session-group-label">${folderSvg} <span>${escapeHtml(projName)}</span></div>` +
            items.map(renderWithChildren).join("")
        );
      }
      if (chats.length > 0) {
        sectionsHtml.push(
          `<div class="session-group-label">${chatSvg} <span>Chats</span></div>` +
            chats.map(renderWithChildren).join("")
        );
      }
    }

    listEl.innerHTML = sectionsHtml.join("");
  }

  listEl.querySelectorAll(".pin-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-session-id");
      if (id) togglePinSession(id);
    });
  });

  listEl.querySelectorAll(".move-up-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-session-id");
      if (id) moveSessionInOrder(id, -1, visibleOrderIds);
    });
  });

  listEl.querySelectorAll(".move-down-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-session-id");
      if (id) moveSessionInOrder(id, 1, visibleOrderIds);
    });
  });

  listEl.querySelectorAll(".session-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-session-id");
      if (id) selectSession(id);
    });
  });
}

function renderSessionHeader() {
  const s = state.activeSession;
  if (!s) return;

  const topTitle = document.getElementById("topbarPrimaryTitle");
  if (topTitle) topTitle.textContent = s.title;

  let badgeClass = "badge badge-idle";
  let badgeText = "IDLE";
  if (s.awaitingUserInput) {
    badgeClass = "badge badge-alert";
    badgeText = "INPUT";
  } else if (s.awaitingPlanApproval) {
    badgeClass = "badge badge-alert";
    badgeText = "PLAN";
  } else if (s.isRunning) {
    badgeClass = "badge badge-busy";
    badgeText = "RUNNING";
  }

  const topBadge = document.getElementById("topbarSessionBadge");
  if (topBadge) {
    topBadge.className = badgeClass;
    topBadge.textContent = badgeText;
  }

  const hostText = document.getElementById("hostStatusText");
  if (hostText) {
    const repoShort = s.projectName || (s.repository ? s.repository.split("/").pop() : "");
    const branchShort = s.branch ? `#${s.branch}` : "";
    hostText.textContent =
      [repoShort, branchShort, s.model].filter(Boolean).join(" • ") ||
      `${state.hostStatus?.hostname || "Desktop"} • Live`;
  }

  const modeSelect = document.getElementById("sessionModeSelect");
  if (modeSelect && s.mode) {
    modeSelect.value = s.mode;
  }

  populateModelSelectOptions();
  const modelSelect = document.getElementById("sessionModelSelect");
  if (modelSelect) {
    const targetModel = s.model || "auto";
    if (!Array.from(modelSelect.options).some((o) => o.value === targetModel)) {
      const opt = document.createElement("option");
      opt.value = targetModel;
      opt.textContent = targetModel;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = targetModel;
  }

  const effortSelect = document.getElementById("sessionEffortSelect");
  if (effortSelect) {
    effortSelect.value = s.reasoningEffort || "high";
  }

  const contextTierSelect = document.getElementById("sessionContextTierSelect");
  if (contextTierSelect) {
    contextTierSelect.value = s.contextTier || "default";
  }

  const abortBtn = document.getElementById("abortSessionBtn");
  if (abortBtn) {
    abortBtn.style.display = s.isRunning ? "inline-flex" : "none";
  }

  // Update tab counts (show human-meaningful messages rather than raw tool sub-steps)
  const meaningfulTurns = state.turns.filter((t) => t.role === "user" || Boolean(t.content)).length;
  document.getElementById("streamTabCount").textContent = String(meaningfulTurns || state.turns.length);
  document.getElementById("artifactsTabCount").textContent = String(state.artifacts.length);
  const queuedReviews = state.reviews.filter((r) => r.status === "queued").length;
  document.getElementById("reviewsTabCount").textContent = String(queuedReviews);
  document.getElementById("todosTabCount").textContent = String(state.todos.length);

  const ctxMeter = document.getElementById("contextMeterText");
  if (ctxMeter) {
    if (s.contextWindow && s.contextWindow.tokenLimit > 0) {
      const pct = Math.round((s.contextWindow.currentTokens / s.contextWindow.tokenLimit) * 100);
      ctxMeter.textContent = `${Math.round(
        s.contextWindow.currentTokens / 1000
      )}k/${Math.round(s.contextWindow.tokenLimit / 1000)}k (${pct}%)`;
    } else {
      ctxMeter.textContent = "";
    }
  }
}

function renderInlineArtifactThumb(art) {
  const authedUrl = withTokenUrl(art.url);
  const ext = art.name.split(".").pop()?.toUpperCase() || "FILE";
  if (art.category === "image") {
    return `
      <div class="inline-artifact-card" data-artifact-id="${escapeHtml(art.id)}">
        <img class="inline-artifact-thumb" src="${escapeHtml(authedUrl)}" loading="lazy" alt="${escapeHtml(art.name)}" />
        <div class="inline-artifact-label">${escapeHtml(art.name)}</div>
      </div>
    `;
  }
  if (art.category === "3d") {
    return `
      <div class="inline-artifact-card" data-artifact-id="${escapeHtml(art.id)}">
        <div class="inline-artifact-3d">
          <span style="font-size: 24px;">🧊</span>
          <span>3D ${escapeHtml(ext)}</span>
        </div>
        <div class="inline-artifact-label">${escapeHtml(art.name)}</div>
      </div>
    `;
  }
  if (ext === "APK" || ext === "EXE" || ext === "ZIP") {
    return `
      <div class="inline-artifact-card" data-artifact-id="${escapeHtml(art.id)}" style="border-color: rgba(34, 197, 94, 0.4);">
        <div class="inline-artifact-3d" style="background: radial-gradient(circle at center, rgba(20, 83, 45, 0.55) 0%, #090d16 100%); color: #4ade80;">
          <span style="font-size: 24px;">⬇</span>
          <span>INSTALL ${escapeHtml(ext)}</span>
        </div>
        <div class="inline-artifact-label">${escapeHtml(art.name)}</div>
      </div>
    `;
  }
  return `
    <div class="inline-artifact-card" data-artifact-id="${escapeHtml(art.id)}">
      <div class="inline-artifact-3d" style="background: #111827; color: var(--accent);">
        <span style="font-size: 22px;">📄</span>
        <span>${escapeHtml(ext)}</span>
      </div>
      <div class="inline-artifact-label">${escapeHtml(art.name)}</div>
    </div>
  `;
}

function isStreamNearBottom(pane) {
  if (!pane) return true;
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 95;
}

function updateJumpToBottomButton() {
  const btn = document.getElementById("jumpToBottomBtn");
  if (!btn) return;
  btn.style.display = !state.stickToBottom && state.activeTab === "stream" ? "inline-flex" : "none";
}

let programmaticScrollUntil = 0;

function scrollStreamToBottomIfSticky(force = false) {
  const pane = document.getElementById("tab-stream");
  if (!pane) return;
  if (force || state.stickToBottom) {
    state.stickToBottom = true;
    const snapBottom = () => {
      programmaticScrollUntil = Date.now() + 220;
      pane.scrollTop = pane.scrollHeight + 10000;
      updateJumpToBottomButton();
    };
    snapBottom();
    requestAnimationFrame(() => {
      if (force || state.stickToBottom) {
        snapBottom();
        setTimeout(() => {
          if (force || state.stickToBottom) snapBottom();
        }, 65);
        setTimeout(() => {
          if (force || state.stickToBottom) snapBottom();
        }, 180);
      }
    });
  }
}

function formatNativeToolRow(tc) {
  const name = tc.mcpToolName || tc.toolName || "tool";
  const args = tc.arguments || {};
  let iconClass = "";
  let iconText = "FN";
  let primaryLabel = tc.toolTitle || tc.intentionSummary || name;
  let secondaryText = "";

  const fileLangBadge = (filePath) => {
    const ext = (String(filePath || "").split(".").pop() || "").toLowerCase();
    if (ext === "ts" || ext === "tsx") return { cls: "ts", txt: "TS" };
    if (ext === "js" || ext === "mjs" || ext === "jsx") return { cls: "js", txt: "JS" };
    if (ext === "py") return { cls: "py", txt: "PY" };
    if (ext === "java") return { cls: "py", txt: "JV" };
    if (ext === "cs") return { cls: "mcp", txt: "C#" };
    if (ext === "md") return { cls: "thought", txt: "MD" };
    if (ext === "html" || ext === "css") return { cls: "ts", txt: ext.toUpperCase() };
    return { cls: "thought", txt: "FILE" };
  };

  const baseName = (p) => String(p || "").split(/[\\/]/).pop() || String(p || "");
  const toRelativePath = (p) => {
    const raw = String(p || "");
    const cwd = state.activeSession?.cwd || "";
    if (cwd && raw.toLowerCase().startsWith(cwd.toLowerCase())) {
      return raw.slice(cwd.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    }
    return raw.replace(/\\/g, "/");
  };

  if (tc.mcpServerName) {
    iconClass = "mcp";
    iconText = "MCP";
    primaryLabel = `${tc.mcpServerName} · ${name}`;
    secondaryText = tc.toolTitle || JSON.stringify(args).slice(0, 120);
  } else if (name === "powershell" || name === "bash") {
    iconClass = "sh";
    iconText = ">_";
    primaryLabel = String(args.description || tc.toolTitle || "Run shell command");
    secondaryText = String(args.command || "").replace(/\s+/g, " ").trim();
  } else if (name === "read_powershell" || name === "stop_powershell") {
    iconClass = "sh";
    iconText = ">_";
    primaryLabel = name === "read_powershell" ? "Read shell output" : "Stop shell session";
    secondaryText = args.shellId ? `shellId: ${args.shellId}` : "";
  } else if (name === "view") {
    const b = fileLangBadge(args.path);
    iconClass = b.cls;
    iconText = b.txt;
    const range = Array.isArray(args.view_range) ? `:${args.view_range[0]}-${args.view_range[1]}` : "";
    primaryLabel = `View ${baseName(args.path)}${range}`;
    secondaryText = toRelativePath(args.path);
  } else if (name === "edit" || name === "create") {
    const b = fileLangBadge(args.path);
    iconClass = b.cls;
    iconText = b.txt;
    primaryLabel = `${name === "create" ? "Create" : "Edit"} ${baseName(args.path)}`;
    secondaryText = toRelativePath(args.path);
  } else if (name === "read_agent" || name === "write_agent") {
    iconClass = "mcp";
    iconText = "SUB";
    const rawTargetId = String(
      args.agent_id || (Array.isArray(args.agent_ids) ? args.agent_ids[0] : "agent")
    );
    const matchedSa =
      tc.subAgent ||
      (state.subAgents || []).find(
        (a) =>
          a.agentId === rawTargetId ||
          a.id === rawTargetId ||
          a.name === rawTargetId ||
          a.toolCallId === rawTargetId
      );
    const displayTarget = matchedSa ? matchedSa.name : rawTargetId;
    const targetCallId = matchedSa ? matchedSa.toolCallId : "";
    primaryLabel = `${name === "read_agent" ? "Read sub-agent" : "Message sub-agent"} [${displayTarget}]`;
    secondaryText =
      name === "write_agent" && typeof args.message === "string"
        ? args.message.replace(/\s+/g, " ").trim().slice(0, 90)
        : tc.intentionSummary || "";
    if (targetCallId) {
      return `
        <div class="native-cli-row" style="display:flex;align-items:center;gap:6px;padding:4px 6px;">
          <span class="native-cli-icon ${iconClass}">${escapeHtml(iconText)}</span>
          <span class="native-cli-title" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(primaryLabel)}</span>
          <span class="native-cli-sub" style="flex-shrink:0;">${escapeHtml(secondaryText)}</span>
          <button class="btn btn-sm open-subagent-stream-btn" data-subagent-id="${escapeHtml(targetCallId)}" style="padding:2px 7px;font-size:10.5px;color:#d2a8ff;border-color:rgba(163,113,247,0.45);">Inspect →</button>
        </div>
      `;
    }
  } else if (name === "task" || tc.subAgent) {
    const sa = tc.subAgent || {};
    iconClass = "mcp";
    iconText = sa.mode === "background" || args.mode === "background" ? "BG" : "SUB";
    const agentName = sa.name || args.name || args.agent_id || "sub-agent";
    const agentType = sa.agentType || args.agent_type || "agent";
    const desc = sa.description || args.description || tc.toolTitle || agentName;
    const targetCallId = sa.toolCallId || tc.toolCallId || "";
    primaryLabel = `Sub-Agent [${agentName}] · ${desc}`;
    const statsParts = [agentType];
    if (sa.model) statsParts.push(sa.model);
    if (sa.totalToolCalls) statsParts.push(`${sa.totalToolCalls} tools`);
    if (sa.totalTokens) statsParts.push(`${formatCompactNum(sa.totalTokens)} tok`);
    if (sa.durationMs) statsParts.push(`${Math.round(sa.durationMs / 1000)}s`);
    secondaryText = statsParts.join(" · ");
    if (targetCallId) {
      return `
        <div class="native-cli-row" style="display:flex;align-items:center;gap:6px;padding:4px 6px;">
          <span class="native-cli-icon ${iconClass}">${escapeHtml(iconText)}</span>
          <span class="native-cli-title" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(primaryLabel)}</span>
          <span class="native-cli-sub" style="flex-shrink:0;">${escapeHtml(secondaryText)}</span>
          <button class="btn btn-sm open-subagent-stream-btn" data-subagent-id="${escapeHtml(targetCallId)}" style="padding:2px 7px;font-size:10.5px;color:#d2a8ff;border-color:rgba(163,113,247,0.45);">Inspect →</button>
        </div>
      `;
    }
  } else if (name === "grep" || name === "glob") {
    iconClass = "ts";
    iconText = "FIND";
    primaryLabel = `${name === "grep" ? "Grep" : "Glob"} ${args.pattern || ""}`;
    secondaryText = args.glob || ( args.paths ? JSON.stringify(args.paths) : "" );
  } else {
    iconClass = "thought";
    iconText = "TOOL";
    primaryLabel = tc.toolTitle || tc.intentionSummary || name;
    secondaryText = Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 120) : "";
  }

  const statusHtml =
    tc.status === "completed"
      ? `<span class="native-cli-status" style="color:var(--success)">●</span>`
      : tc.status === "failed"
      ? `<span class="native-cli-status" style="color:var(--danger)">✕</span>`
      : `<span class="native-cli-status" style="color:var(--warning)">…</span>`;

  return `
    <details class="native-cli-row">
      <summary>
        <span class="native-cli-icon ${iconClass}">${escapeHtml(iconText)}</span>
        <span class="native-cli-title">${escapeHtml(primaryLabel)}</span>
        ${secondaryText ? `<span class="native-cli-sub">${escapeHtml(secondaryText)}</span>` : `<span class="native-cli-sub"></span>`}
        ${statusHtml}
      </summary>
      <div class="tool-call-details">Args: ${escapeHtml(
        JSON.stringify(args, null, 2)
      )}${tc.resultPreview ? `\n\nResult:\n${escapeHtml(tc.resultPreview)}` : ""}</div>
    </details>
  `;
}

function formatNativeThoughtRow(reasoningText) {
  if (!reasoningText) return "";
  const cleanPreview = String(reasoningText)
    .replace(/\*\*([^*]+)\*\*/g, "$1 —")
    .replace(/[`#*>-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 115);
  return `
    <details class="native-cli-row">
      <summary>
        <span class="native-cli-icon thought">···</span>
        <span class="native-cli-title" style="color:var(--text-secondary);">Thought</span>
        <span class="native-cli-sub">${escapeHtml(cleanPreview)}</span>
      </summary>
      <div class="reasoning-content" style="padding:6px 4px 2px;">${escapeHtml(reasoningText)}</div>
    </details>
  `;
}

function renderWorkspaceStatusBar() {
  const bar = document.getElementById("workspaceStatusBar");
  if (!bar) return;
  const s = state.activeSession;
  if (!s) {
    bar.innerHTML = "";
    return;
  }

  const pills = [];
  const d = state.diff || s.diffStats;
  if (d && (d.filesChanged > 0 || d.insertions > 0 || d.deletions > 0)) {
    pills.push(
      `<button class="ws-pill" data-jump-tab="reviews">Changes <span class="ins">+${d.insertions || 0}</span> <span class="del">-${d.deletions || 0}</span></button>`
    );
  }

  const totalTodos = state.todos.length || s.counts?.todos || 0;
  const doneTodos =
    state.todos.length > 0
      ? state.todos.filter((t) => t.status === "done").length
      : s.counts?.todosDone || 0;
  if (totalTodos > 0) {
    pills.push(
      `<button class="ws-pill" data-jump-tab="todos">Plan <span style="color:#94a3b8">${doneTodos}/${totalTodos}</span></button>`
    );
  }

  const artCount = state.artifacts.length || s.counts?.artifacts || 0;
  if (artCount > 0) {
    pills.push(
      `<button class="ws-pill" data-jump-tab="artifacts">Artifacts <span style="color:#94a3b8">${artCount}</span></button>`
    );
  }

  const childSessionsCount = state.sessions.filter((x) => x.parentSessionId === s.id).length;
  const subAgentsCount = (state.subAgents?.length || s.counts?.subAgents || 0) + childSessionsCount;
  if (subAgentsCount > 0) {
    const runningCount =
      (state.subAgents ? state.subAgents.filter((a) => a.status === "running").length : s.counts?.runningSubAgents || 0) +
      state.sessions.filter((x) => x.parentSessionId === s.id && x.isRunning).length;
    pills.push(
      `<button class="ws-pill" data-jump-tab="todos" title="View Sub-Agents &amp; Child Sessions">Agents <span style="color:${
        runningCount > 0 ? "#d2a8ff" : "#94a3b8"
      }">${runningCount > 0 ? `${runningCount} active / ` : ""}${subAgentsCount}</span></button>`
    );
  }

  const q = state.hostStatus?.quota;
  if (q && q.premium) {
    const pctLeft = Math.round(q.premium.percentRemaining);
    const pctColor = pctLeft < 15 ? "#f87171" : pctLeft < 35 ? "#fbbf24" : "#4ade80";
    pills.push(
      `<button class="ws-pill" data-jump-tab="todos" title="Monthly Copilot Premium Quota (${q.plan.toUpperCase()})">Quota <span style="color:${pctColor}">${pctLeft}% left</span></button>`
    );
  }

  pills.push(
    `<button id="toggleTraceModePill" class="ws-pill" title="Toggle between Auto-grouped historical steps and Full expanded CLI trace">Trace <span style="color:#7dd3fc">${
      state.expandAllTrace ? "Full" : "Smart"
    }</span></button>`
  );

  bar.innerHTML = pills.join("");
  bar.querySelectorAll(".ws-pill[data-jump-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-jump-tab");
      if (targetTab) {
        document.querySelector(`.view-tab[data-tab="${targetTab}"]`)?.click();
      }
    });
  });
  document.getElementById("toggleTraceModePill")?.addEventListener("click", () => {
    state.expandAllTrace = !state.expandAllTrace;
    localStorage.setItem("ra_expand_all_trace", state.expandAllTrace ? "1" : "0");
    renderWorkspaceStatusBar();
    renderTurns(false);
  });
}

function renderAgentHierarchyBar() {
  const bar = document.getElementById("agentHierarchyBar");
  if (!bar) return;
  const s = state.activeSession;
  if (!s) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }

  const parentSess = s.parentSessionId
    ? state.sessions.find((x) => x.id === s.parentSessionId)
    : null;
  const childSessions = state.sessions.filter((x) => x.parentSessionId === s.id);
  const subAgents = state.subAgents || [];
  const detachedShells = state.detachedShells || [];

  if (!parentSess && childSessions.length === 0 && subAgents.length === 0 && detachedShells.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }

  bar.style.display = "flex";
  const pills = [];

  if (parentSess) {
    pills.push(
      `<button class="hierarchy-node-pill" data-jump-session="${escapeHtml(parentSess.id)}" title="Jump to Parent Coordinator Session">↖ Parent: ${escapeHtml(parentSess.title.slice(0, 22))}</button>`
    );
  }

  const isMainActive = !state.activeSubAgentId && !state.activeDetachedShellId;
  pills.push(
    `<button class="hierarchy-node-pill ${isMainActive ? "active" : ""}" data-select-main="1">Main Lead (${state.turns.length})</button>`
  );

  for (const cs of childSessions) {
    pills.push(
      `<button class="hierarchy-node-pill ${cs.isRunning ? "running" : ""}" data-jump-session="${escapeHtml(cs.id)}" title="Jump to Child Session">↳ ${escapeHtml(cs.title.slice(0, 22))}</button>`
    );
  }

  for (const sa of subAgents) {
    const isSel = state.activeSubAgentId === sa.toolCallId || state.activeSubAgentId === sa.id;
    const isRun = sa.status === "running";
    const statusIcon = isRun ? "⚡" : sa.status === "failed" ? "✕" : "✓";
    const stepCount = sa.totalToolCalls || (sa.turns ? sa.turns.length : 0);
    pills.push(
      `<button class="hierarchy-node-pill ${isSel ? "active" : ""} ${isRun ? "running" : ""}" data-select-subagent="${escapeHtml(sa.toolCallId)}" title="${escapeHtml(sa.description || sa.name)}">${statusIcon} ${escapeHtml(sa.name)}${stepCount ? ` (${stepCount})` : ""}</button>`
    );
  }

  for (const ds of detachedShells) {
    const isSel = state.activeDetachedShellId === ds.shellId;
    const isRun = ds.state === "active";
    pills.push(
      `<button class="hierarchy-node-pill ${isSel ? "active" : ""} ${isRun ? "running" : ""}" data-select-shell="${escapeHtml(ds.shellId)}" title="Detached Background Process (PID ${ds.pid || "?"})">&gt;_ ${escapeHtml(ds.shellId)} (${ds.state})</button>`
    );
  }

  bar.innerHTML = pills.join("");

  const ensureStreamTabActive = () => {
    if (state.activeTab !== "stream") {
      document.querySelector('.view-tab[data-tab="stream"]')?.click();
    }
  };

  bar.querySelector("[data-select-main]")?.addEventListener("click", () => {
    state.activeSubAgentId = null;
    state.activeDetachedShellId = null;
    ensureStreamTabActive();
    renderAgentHierarchyBar();
    renderTurns(false);
  });

  bar.querySelectorAll("[data-select-subagent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-select-subagent");
      state.activeSubAgentId = id;
      state.activeDetachedShellId = null;
      ensureStreamTabActive();
      renderAgentHierarchyBar();
      renderTurns(true);
    });
  });

  bar.querySelectorAll("[data-select-shell]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-select-shell");
      state.activeDetachedShellId = id;
      state.activeSubAgentId = null;
      ensureStreamTabActive();
      renderAgentHierarchyBar();
      renderTurns(false);
    });
  });

  bar.querySelectorAll("[data-jump-session]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-jump-session");
      if (id) selectSession(id);
    });
  });
}

function renderTurns(scrollBottom = false) {
  const container = document.getElementById("turnsContainer");
  const pane = document.getElementById("tab-stream");
  if (!container) return;

  const prevScrollTop = pane ? pane.scrollTop : 0;
  if (scrollBottom) {
    state.stickToBottom = true;
  }

  // Case 1: Viewing a Detached Background Shell / Process
  if (state.activeDetachedShellId) {
    const ds = (state.detachedShells || []).find((x) => x.shellId === state.activeDetachedShellId);
    if (!ds) {
      state.activeDetachedShellId = null;
    } else {
      container.innerHTML = `
        <div class="turn-card" style="padding:12px 14px;background:var(--bg-secondary);border-color:rgba(163,113,247,0.45);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div>
              <div style="font-size:11px;color:#d2a8ff;font-weight:600;">DETACHED BACKGROUND PROCESS</div>
              <div style="font-size:14px;font-weight:600;">&gt;_ ${escapeHtml(ds.shellId)} ${ds.pid ? `(PID ${ds.pid})` : ""}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <span class="badge ${ds.state === "active" ? "badge-busy" : "badge-idle"}">${escapeHtml(ds.state.toUpperCase())}</span>
              <button id="backToMainFromShellBtn" class="btn btn-sm">← Back to Main Agent</button>
            </div>
          </div>
          ${ds.logPath ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">Log: ${escapeHtml(ds.logPath)}</div>` : ""}
          <pre class="tool-call-details" style="max-height:62dvh;margin-top:8px;">${escapeHtml(ds.logPreview || "No log output captured.")}</pre>
        </div>
      `;
      document.getElementById("backToMainFromShellBtn")?.addEventListener("click", () => {
        state.activeDetachedShellId = null;
        renderAgentHierarchyBar();
        renderTurns(false);
      });
      return;
    }
  }

  // Case 2: Viewing a specific Sub-Agent's stream vs. Main Lead Agent stream
  let activeSubAgent = null;
  if (state.activeSubAgentId) {
    activeSubAgent = (state.subAgents || []).find(
      (a) => a.toolCallId === state.activeSubAgentId || a.id === state.activeSubAgentId
    );
    if (!activeSubAgent) {
      state.activeSubAgentId = null;
    }
  }

  const sourceTurns = activeSubAgent ? activeSubAgent.turns || [] : state.turns;

  if (sourceTurns.length === 0 && !state.streaming && !activeSubAgent) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--text-secondary);">
        No turns recorded yet in this session. Send a prompt below to start!
      </div>
    `;
    return;
  }

  // Find index of last user message so the active/latest turn's steps are always shown open inline,
  // while older completed multi-step batches (> 4 steps) fold cleanly unless Trace: Full is active.
  let lastUserIdx = -1;
  for (let i = sourceTurns.length - 1; i >= 0; i--) {
    if (sourceTurns[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const outBlocks = [];

  if (activeSubAgent) {
    const sa = activeSubAgent;
    const stats = [sa.mode === "background" ? "Background Agent" : "Sync Sub-Agent", sa.agentType];
    if (sa.model) stats.push(sa.model);
    if (sa.totalToolCalls) stats.push(`${sa.totalToolCalls} tools`);
    if (sa.totalTokens) stats.push(`${formatCompactNum(sa.totalTokens)} tokens`);
    if (sa.durationMs) stats.push(`${Math.round(sa.durationMs / 1000)}s`);

    outBlocks.push(`
      <div class="turn-card" style="padding:12px 14px;background:var(--bg-secondary);border-color:rgba(163,113,247,0.45);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div>
            <div style="font-size:11px;color:#d2a8ff;font-weight:600;">SUB-AGENT EXECUTION STREAM</div>
            <div style="font-size:14px;font-weight:600;">[${escapeHtml(sa.name)}] ${escapeHtml(sa.description)}</div>
            <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(stats.join(" · "))}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <span class="badge ${sa.status === "running" ? "badge-busy" : "badge-idle"}">${escapeHtml(sa.status.toUpperCase())}</span>
            <button id="backToMainAgentBtn" class="btn btn-sm">← Back to Main Agent</button>
          </div>
        </div>
        ${
          sa.promptPreview
            ? `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:11.5px;color:#58a6ff;">View Delegated Task Prompt ▾</summary><div class="tool-call-details">${escapeHtml(sa.promptPreview)}</div></details>`
            : ""
        }
        ${
          sa.resultPreview
            ? `<details style="margin-top:4px;" open><summary style="cursor:pointer;font-size:11.5px;color:var(--success);">View Sub-Agent Final Report ▾</summary><div class="tool-call-details">${escapeHtml(sa.resultPreview)}</div></details>`
            : ""
        }
      </div>
    `);
  }

  let pendingStepRows = [];
  let pendingStepCount = 0;
  let pendingStepTools = new Set();
  let pendingStepIsLatest = false;

  const flushStepRows = () => {
    if (pendingStepRows.length === 0) return;
    const rowsHtml = pendingStepRows.join("");
    if (state.expandAllTrace || pendingStepIsLatest || pendingStepCount <= 4) {
      outBlocks.push(`<div class="native-step-block">${rowsHtml}</div>`);
    } else {
      const toolSummary = [...pendingStepTools].slice(0, 4).join(", ");
      outBlocks.push(`
        <details class="native-step-group-fold">
          <summary>
            <span>${pendingStepCount} steps (${escapeHtml(toolSummary || "Thought, Tools")})</span>
            <span style="font-size:11px;color:var(--text-secondary);">Show ▾</span>
          </summary>
          <div class="native-step-block">${rowsHtml}</div>
        </details>
      `);
    }
    pendingStepRows = [];
    pendingStepCount = 0;
    pendingStepTools = new Set();
    pendingStepIsLatest = false;
  };

  sourceTurns.forEach((t, idx) => {
    const isLatestTurn = idx > lastUserIdx;
    const inlineArtsHtml =
      t.artifacts && t.artifacts.length > 0
        ? `<div class="inline-artifacts">${t.artifacts
            .slice(0, 8)
            .map(renderInlineArtifactThumb)
            .join("")}</div>`
        : "";

    if (t.role === "user") {
      flushStepRows();
      const turnId = String(t.id || `user-${idx}`);
      const isShown = state.revealedTimestampTurnIds.has(turnId);
      outBlocks.push(`
        <div class="turn-card user ${isShown ? "show-timestamp" : ""}" data-turn-id="${escapeHtml(turnId)}" data-timestamp="${escapeHtml(t.timestamp || "")}" title="Tap or swipe left for timestamp">
          ${t.content ? `<div class="turn-content">${renderMarkdown(t.content)}</div>` : ""}
          ${inlineArtsHtml}
          <div class="bubble-timestamp-drawer">${escapeHtml(formatFullMessageTimestamp(t.timestamp))}</div>
          <span class="bubble-swipe-time">${escapeHtml(formatShortClockTime(t.timestamp))}</span>
        </div>
      `);
      return;
    }

    const visibleTools = (t.toolCalls || []).filter(
      (tc) => !(tc.toolName === "task_complete" && t.content)
    );
    if (t.reasoningText) {
      pendingStepRows.push(formatNativeThoughtRow(t.reasoningText));
      pendingStepCount++;
      pendingStepTools.add("Thought");
    }
    for (const tc of visibleTools) {
      pendingStepRows.push(formatNativeToolRow(tc));
      pendingStepCount++;
      pendingStepTools.add(tc.mcpServerName || tc.toolName);
    }
    if (isLatestTurn) {
      pendingStepIsLatest = true;
    }

    if (t.content) {
      flushStepRows();
      const turnId = String(t.id || `assistant-${idx}`);
      const isShown = state.revealedTimestampTurnIds.has(turnId);
      outBlocks.push(`
        <div class="turn-card assistant ${isShown ? "show-timestamp" : ""}" data-turn-id="${escapeHtml(turnId)}" data-timestamp="${escapeHtml(t.timestamp || "")}" title="Tap or swipe left for full timestamp">
          <div class="turn-meta">
            <span class="turn-role">Copilot ${t.model ? `<span style="font-weight:400;color:var(--text-muted);">· ${escapeHtml(t.model)}</span>` : ""}</span>
            <span>${formatTimeAgo(t.timestamp)}</span>
          </div>
          <div class="turn-content">${renderMarkdown(t.content)}</div>
          ${inlineArtsHtml}
          <div class="bubble-timestamp-drawer">${escapeHtml(formatFullMessageTimestamp(t.timestamp))}</div>
          <span class="bubble-swipe-time">${escapeHtml(formatShortClockTime(t.timestamp))}</span>
        </div>
      `);
    } else if (inlineArtsHtml) {
      flushStepRows();
      outBlocks.push(inlineArtsHtml);
    }
  });

  flushStepRows();

  const html = outBlocks.join("");

  const pendingHtml = (state.pendingSteering || [])
    .map((item) => {
      const modeLabel =
        item.deliveryMode === "enqueue"
          ? "Queued for next turn"
          : "Steering · admits at next step";
      const attThumbs = Array.isArray(item.attachments) && item.attachments.length > 0
        ? `<div class="inline-artifacts">${item.attachments
            .map((a) => {
              const srcUrl = a.dataBase64 || (a.url ? withTokenUrl(a.url) : "");
              return `
              <div class="inline-artifact-card">
                ${srcUrl ? `<img class="inline-artifact-thumb" src="${escapeHtml(srcUrl)}" alt="${escapeHtml(a.name)}" />` : ""}
                <div class="inline-artifact-label">${escapeHtml(a.name)}</div>
              </div>`;
            })
            .join("")}</div>`
        : "";
      const pId = String(item.id || "pending");
      const isShown = state.revealedTimestampTurnIds.has(pId);
      return `
        <div class="turn-card user ${isShown ? "show-timestamp" : ""}" data-turn-id="${escapeHtml(pId)}" data-timestamp="${escapeHtml(item.createdAt || "")}" style="border-style: dashed; border-color: var(--warning); background: rgba(210, 153, 34, 0.1);">
          <div class="turn-meta">
            <span class="turn-role" style="color: var(--warning);">${modeLabel}</span>
            <span>${formatTimeAgo(item.createdAt)}</span>
          </div>
          <div class="turn-content">${renderMarkdown(item.prompt)}</div>
          ${attThumbs}
          <div class="bubble-timestamp-drawer">${escapeHtml(formatFullMessageTimestamp(item.createdAt))}</div>
          <span class="bubble-swipe-time">${escapeHtml(formatShortClockTime(item.createdAt))}</span>
        </div>
      `;
    })
    .join("");

  container.innerHTML = html + `<div id="streamingTurnSlot"></div>` + pendingHtml;
  renderStreamingTurn();

  // Tap/click on any user or assistant message bubble to toggle its exact timestamp drawer
  container.querySelectorAll(".turn-card[data-turn-id]").forEach((card) => {
    card.addEventListener("click", (e) => {
      // Do not toggle if clicking a link, button, details summary, or artifact card, or selecting text
      if (e.target.closest("a, button, summary, input, .inline-artifact-card")) return;
      const sel = window.getSelection ? String(window.getSelection()) : "";
      if (sel && sel.length > 0) return;
      const turnId = card.getAttribute("data-turn-id");
      if (!turnId) return;
      if (state.revealedTimestampTurnIds.has(turnId)) {
        state.revealedTimestampTurnIds.delete(turnId);
        card.classList.remove("show-timestamp");
      } else {
        state.revealedTimestampTurnIds.add(turnId);
        card.classList.add("show-timestamp");
      }
    });
  });

  container.querySelectorAll(".inline-artifact-card").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-artifact-id");
      const art = state.artifacts.find((a) => a.id === id);
      if (art) openArtifactViewer(art);
    });
  });

  // Keep stream pinned to bottom if inline thumbnail images decode asynchronously while sticky
  container.querySelectorAll("img.inline-artifact-thumb").forEach((img) => {
    if (!img.complete) {
      img.addEventListener(
        "load",
        () => {
          if (state.stickToBottom) {
            scrollStreamToBottomIfSticky(false);
          }
        },
        { once: true }
      );
    }
  });

  container.querySelectorAll(".open-subagent-stream-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute("data-subagent-id");
      if (targetId) {
        state.activeSubAgentId = targetId;
        state.activeDetachedShellId = null;
        renderAgentHierarchyBar();
        renderTurns(true);
      }
    });
  });

  document.getElementById("backToMainAgentBtn")?.addEventListener("click", () => {
    state.activeSubAgentId = null;
    state.activeDetachedShellId = null;
    renderAgentHierarchyBar();
    renderTurns(false);
  });

  if (scrollBottom || state.stickToBottom) {
    scrollStreamToBottomIfSticky(scrollBottom);
  } else if (pane) {
    pane.scrollTop = prevScrollTop;
    updateJumpToBottomButton();
  }
}

function renderStreamingTurn() {
  const slot = document.getElementById("streamingTurnSlot");
  if (!slot) return;
  if (!state.streaming || (!state.streaming.content && !state.streaming.reasoning)) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = `
    <div class="native-step-block">
      ${
        state.streaming.reasoning
          ? `<details class="native-cli-row" open>
              <summary>
                <span class="native-cli-icon thought">💭</span>
                <span class="native-cli-title" style="color:#7dd3fc;">Thinking...</span>
                <span class="native-cli-sub">${escapeHtml(
                  state.streaming.reasoning.replace(/\s+/g, " ").trim().slice(-90)
                )}</span>
              </summary>
              <div class="reasoning-content" style="padding:6px 4px 2px;">${escapeHtml(
                state.streaming.reasoning
              )}</div>
            </details>`
          : ""
      }
      ${
        state.streaming.content
          ? `<div class="turn-card assistant" style="border-color: var(--accent);">
              <div class="turn-meta">
                <span class="turn-role">⚡ Copilot Streaming Live...</span>
              </div>
              <div class="turn-content">${renderMarkdown(state.streaming.content)}</div>
            </div>`
          : ""
      }
    </div>
  `;
  if (state.stickToBottom) {
    scrollStreamToBottomIfSticky(false);
  }
}

function renderActionBanner() {
  const banner = document.getElementById("actionBanner");
  if (!banner || !state.activeSession) return;
  const s = state.activeSession;

  if (s.awaitingUserInput) {
    const req = s.awaitingUserInput;
    const choicesHtml = (req.choices || [])
      .map(
        (c) =>
          `<button class="btn btn-sm btn-primary ask-choice-btn" data-choice="${escapeHtml(
            c
          )}">${escapeHtml(c)}</button>`
      )
      .join("");

    banner.style.display = "flex";
    banner.innerHTML = `
      <div class="action-banner-title">❓ Agent is waiting for your answer:</div>
      <div style="font-size: 13.5px;">${escapeHtml(req.question)}</div>
      ${choicesHtml ? `<div class="action-choices">${choicesHtml}</div>` : ""}
      <div style="display: flex; gap: 6px; margin-top: 4px;">
        <input id="askUserFreeformInput" type="text" class="search-input" placeholder="Or type a custom answer..." />
        <button id="askUserSubmitBtn" class="btn btn-sm btn-primary">Reply</button>
      </div>
    `;

    const submitInputAnswer = async (answer, wasFreeform) => {
      if (!answer) return;
      s.awaitingUserInput = null;
      banner.style.display = "none";
      banner.innerHTML = "";
      renderSessionHeader();
      state.pendingSteering.push({
        id: `local-${Date.now()}`,
        prompt: answer,
        deliveryMode: "immediate",
        createdAt: new Date().toISOString(),
      });
      renderTurns(true);
      await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/respond-input`, {
        method: "POST",
        body: { requestId: req.requestId, answer, wasFreeform },
      });
      scheduleActiveSessionRefresh(350);
    };

    banner.querySelectorAll(".ask-choice-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const answer = btn.getAttribute("data-choice") || "";
        await submitInputAnswer(answer, false);
      });
    });

    document.getElementById("askUserSubmitBtn")?.addEventListener("click", async () => {
      const val = document.getElementById("askUserFreeformInput")?.value?.trim();
      if (!val) return;
      await submitInputAnswer(val, true);
    });
    return;
  }

  if (s.awaitingPlanApproval) {
    const plan = s.awaitingPlanApproval;
    banner.style.display = "flex";
    banner.innerHTML = `
      <div class="action-banner-title">📋 Agent Plan Ready for Approval</div>
      <div style="font-size: 13px;">${escapeHtml(plan.summary || "Review and approve or reject the plan.")}</div>
      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        <button id="approvePlanBtn" class="btn btn-sm btn-primary">✅ Approve &amp; Run</button>
        <input id="planFeedbackInput" type="text" class="search-input" style="flex: 1; min-width: 160px;" placeholder="Optional feedback if rejecting..." />
        <button id="rejectPlanBtn" class="btn btn-sm btn-danger">✕ Reject with Feedback</button>
      </div>
    `;

    document.getElementById("approvePlanBtn")?.addEventListener("click", async () => {
      await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/respond-plan`, {
        method: "POST",
        body: { requestId: plan.requestId, approved: true },
      });
      scheduleActiveSessionRefresh(200);
    });

    document.getElementById("rejectPlanBtn")?.addEventListener("click", async () => {
      const feedback = document.getElementById("planFeedbackInput")?.value?.trim() || "";
      await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/respond-plan`, {
        method: "POST",
        body: { requestId: plan.requestId, approved: false, feedback },
      });
      scheduleActiveSessionRefresh(200);
    });
    return;
  }

  banner.style.display = "none";
  banner.innerHTML = "";
}

// --- Artifacts Gallery ---
function renderArtifactsGallery() {
  const grid = document.getElementById("artifactsGrid");
  if (!grid) return;

  const filtered = state.artifacts.filter((a) => {
    if (state.artifactFilter === "all") return true;
    if (state.artifactFilter === "data") return a.category === "data" || a.category === "code" || a.category === "other";
    return a.category === state.artifactFilter;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 30px; color: var(--text-secondary);">No matching artifacts in this session.</div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((a) => {
      const authedUrl = withTokenUrl(a.url);
      const ext = a.name.split(".").pop()?.toUpperCase() || "FILE";
      let previewHtml = "";
      if (a.category === "image") {
        previewHtml = `<img src="${escapeHtml(authedUrl)}" loading="lazy" alt="${escapeHtml(a.name)}" />`;
      } else if (a.category === "3d") {
        previewHtml = `
          <div class="artifact-icon-placeholder" style="color: #c084fc;">
            <span style="font-size: 32px;">🧊</span>
            <span>3D ${escapeHtml(ext)}</span>
          </div>
        `;
      } else if (ext === "APK" || ext === "EXE" || ext === "ZIP") {
        previewHtml = `
          <div class="artifact-icon-placeholder" style="color: #4ade80;">
            <span style="font-size: 30px;">📦</span>
            <span>INSTALL / ${escapeHtml(ext)}</span>
          </div>
        `;
      } else if (a.category === "document") {
        previewHtml = `
          <div class="artifact-icon-placeholder">
            <span style="font-size: 30px;">📄</span>
            <span>DOCUMENT</span>
          </div>
        `;
      } else {
        previewHtml = `
          <div class="artifact-icon-placeholder" style="color: #38bdf8;">
            <span style="font-size: 30px;">📊</span>
            <span>${escapeHtml(ext)}</span>
          </div>
        `;
      }

      return `
        <div class="artifact-card" data-artifact-id="${escapeHtml(a.id)}">
          <div class="artifact-preview">${previewHtml}</div>
          <div class="artifact-body">
            <div class="artifact-name" title="${escapeHtml(a.relativePath)}">${escapeHtml(a.name)}</div>
            <div class="artifact-sub">
              <span>${formatBytes(a.sizeBytes)}</span>
              <span>${escapeHtml(a.source)}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  grid.querySelectorAll(".artifact-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-artifact-id");
      const art = state.artifacts.find((x) => x.id === id);
      if (art) openArtifactViewer(art);
    });
  });
}

function openArtifactViewer(art) {
  const ext = art.name.toLowerCase().split(".").pop() || "";
  if (art.category === "image") {
    openImageAnnotationModal(art);
  } else if (ext === "stl") {
    openStlViewerModal(art);
  } else if (["pdf", "apk", "aab", "exe", "zip", "3mf", "f3d", "step", "stp"].includes(ext)) {
    const dlUrl = `${withTokenUrl(art.url)}&download=1`;
    window.open(dlUrl, "_blank");
  } else {
    openDocViewerModal(art);
  }
}

// --- Image Lightbox (Pinch-to-Zoom & Pan + Optional Touch Annotation Studio) ---
function fitImageCanvasToViewport() {
  const canvas = document.getElementById("annotationCanvas");
  const viewport = document.getElementById("imageModalViewport");
  if (!canvas || !viewport || !canvas.width || !canvas.height) return;

  const vw = Math.max(120, viewport.clientWidth - 16);
  const vh = Math.max(120, viewport.clientHeight - 16);
  const fitScale = Math.min(vw / canvas.width, vh / canvas.height);

  const baseW = Math.max(60, Math.round(canvas.width * fitScale));
  const baseH = Math.max(60, Math.round(canvas.height * fitScale));

  canvas.style.width = `${baseW}px`;
  canvas.style.height = `${baseH}px`;
  state.imgBaseW = baseW;
  state.imgBaseH = baseH;

  // 100% screen width zoom factor (or screen height if image is already 100% width)
  const widthRatio = vw / baseW;
  const heightRatio = vh / baseH;
  state.imgFillWidthZoom = Number(
    (widthRatio > 1.03 ? widthRatio : heightRatio > 1.03 ? heightRatio : 1.5).toFixed(2)
  );
}

function clampImagePan() {
  state.imgZoom = Math.max(0.75, Math.min(8.0, state.imgZoom));
  const baseW = state.imgBaseW || 300;
  const baseH = state.imgBaseH || 300;
  const scaledW = baseW * state.imgZoom;
  const scaledH = baseH * state.imgZoom;

  // Force at least one part of the image to always touch the center of the viewport (0, 0).
  // Since the image spans [panX - scaledW/2, panX + scaledW/2] around center, clamping panX
  // to [-scaledW/2, +scaledW/2] guarantees the image never leaves the center of the screen!
  const maxPanX = scaledW / 2;
  const maxPanY = scaledH / 2;
  state.imgPanX = Math.max(-maxPanX, Math.min(maxPanX, state.imgPanX));
  state.imgPanY = Math.max(-maxPanY, Math.min(maxPanY, state.imgPanY));
}

function snapZoomValue(rawZoom) {
  const snaps = [1.0, state.imgFillWidthZoom || 1.5, 2.0, 4.0];
  for (const s of snaps) {
    if (Math.abs(rawZoom - s) <= s * 0.045) {
      return s;
    }
  }
  return rawZoom;
}

function setZoomAroundFocalPoint(targetZoom, focalX = 0, focalY = 0, snap = false) {
  const prevZoom = state.imgZoom || 1.0;
  let nextZoom = Math.max(0.75, Math.min(8.0, targetZoom));
  if (snap) {
    nextZoom = snapZoomValue(nextZoom);
  }
  const ratio = nextZoom / prevZoom;
  state.imgPanX = focalX - (focalX - state.imgPanX) * ratio;
  state.imgPanY = focalY - (focalY - state.imgPanY) * ratio;
  state.imgZoom = nextZoom;
  if (Math.abs(state.imgZoom - 1.0) < 0.02) {
    state.imgZoom = 1.0;
  }
  applyImageTransform();
}

function applyImageTransform() {
  const canvas = document.getElementById("annotationCanvas");
  const resetBtn = document.getElementById("resetImageZoomBtn");
  if (!canvas) return;
  clampImagePan();
  canvas.style.transform = `translate3d(${Math.round(state.imgPanX)}px, ${Math.round(
    state.imgPanY
  )}px, 0) scale(${state.imgZoom})`;
  if (resetBtn) {
    resetBtn.textContent = `${Math.round(state.imgZoom * 100)}%`;
  }
}

function updateImageModeUi() {
  const drawBtn = document.getElementById("toggleDrawModeBtn");
  const undoBtn = document.getElementById("undoMarkupBtn");
  const clearBtn = document.getElementById("clearMarkupBtn");
  const hintEl = document.getElementById("imageModalHint");
  const canvas = document.getElementById("annotationCanvas");
  const isDraw = state.imageMode === "draw";

  if (drawBtn) {
    drawBtn.textContent = isDraw ? "Zoom / Pan" : "Annotate";
    drawBtn.className = isDraw ? "btn btn-sm btn-primary" : "btn btn-sm btn-purple";
  }
  if (undoBtn) {
    undoBtn.style.display = state.strokes.length > 0 ? "inline-flex" : "none";
  }
  if (clearBtn) {
    clearBtn.style.display = state.strokes.length > 0 ? "inline-flex" : "none";
  }
  if (hintEl) {
    hintEl.textContent = isDraw
      ? "1-finger: Draw markup • 2-finger: Pinch-zoom & pan"
      : "Pinch to zoom • Drag to pan • Double-tap 2×";
  }
  if (canvas) {
    canvas.style.cursor = isDraw ? "crosshair" : "grab";
  }
  // Re-fit & clamp in case header height changed when buttons appeared
  requestAnimationFrame(() => {
    fitImageCanvasToViewport();
    applyImageTransform();
  });
}

function openImageAnnotationModal(art, customDataUrl = null) {
  state.currentImageArtifact = art;
  state.strokes = [];
  state.currentStroke = null;
  state.imageMode = "view";
  state.imgZoom = 1.0;
  state.imgPanX = 0;
  state.imgPanY = 0;

  const modal = document.getElementById("imageModal");
  const titleEl = document.getElementById("imageModalTitle");
  const dlLink = document.getElementById("downloadImageLink");
  const commentInput = document.getElementById("imageCommentInput");
  if (!modal) return;

  titleEl.textContent = art.name;
  const srcUrl = customDataUrl || withTokenUrl(art.url);
  dlLink.href = srcUrl;
  dlLink.download = art.name;
  commentInput.value = "";
  modal.classList.add("open");
  pushOverlayHistory("imageModal");
  updateImageModeUi();

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    state.baseImageObj = img;
    const canvas = document.getElementById("annotationCanvas");
    const maxDim = 1600;
    let w = img.naturalWidth || 800;
    let h = img.naturalHeight || 600;
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    canvas.width = w;
    canvas.height = h;
    state.imgZoom = 1.0;
    state.imgPanX = 0;
    state.imgPanY = 0;
    fitImageCanvasToViewport();
    redrawAnnotationCanvas();
    applyImageTransform();
  };
  img.src = srcUrl;
}

function redrawAnnotationCanvas() {
  const canvas = document.getElementById("annotationCanvas");
  if (!canvas || !state.baseImageObj) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.baseImageObj, 0, 0, canvas.width, canvas.height);

  const allStrokes = [...state.strokes, ...(state.currentStroke ? [state.currentStroke] : [])];
  for (const stroke of allStrokes) {
    if (stroke.points.length < 2) continue;
    ctx.save();
    ctx.strokeStyle = stroke.color || "#ef4444";
    ctx.lineWidth = Math.max(4, Math.round(canvas.width / 180));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }
}

function setupAnnotationCanvasEvents() {
  const canvas = document.getElementById("annotationCanvas");
  const viewport = document.getElementById("imageModalViewport");
  if (!canvas || !viewport) return;

  let isPanning = false;
  let lastPanX = 0;
  let lastPanY = 0;
  let lastPinchDist = null;
  let lastPinchMidX = 0;
  let lastPinchMidY = 0;
  let lastTapTime = 0;

  window.addEventListener("resize", () => {
    if (document.getElementById("imageModal")?.classList.contains("open")) {
      fitImageCanvasToViewport();
      applyImageTransform();
    }
  });

  const getViewportFocal = (clientX, clientY) => {
    const vRect = viewport.getBoundingClientRect();
    return {
      x: clientX - (vRect.left + vRect.width / 2),
      y: clientY - (vRect.top + vRect.height / 2),
    };
  };

  const getCanvasCoords = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width)),
      y: Math.max(0, Math.min(canvas.height, ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height)),
    };
  };

  // Mouse wheel zoom around cursor (Desktop / Chromebook)
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 0.85;
      const focal = getViewportFocal(e.clientX, e.clientY);
      setZoomAroundFocalPoint(state.imgZoom * factor, focal.x, focal.y, true);
    },
    { passive: false }
  );

  // Mouse events
  viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (state.imageMode === "draw") {
      state.currentStroke = { color: "#ef4444", points: [getCanvasCoords(e.clientX, e.clientY)] };
      redrawAnnotationCanvas();
    } else {
      isPanning = true;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (state.currentStroke) {
      state.currentStroke.points.push(getCanvasCoords(e.clientX, e.clientY));
      redrawAnnotationCanvas();
    } else if (isPanning) {
      state.imgPanX += e.clientX - lastPanX;
      state.imgPanY += e.clientY - lastPanY;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      applyImageTransform();
    }
  });

  window.addEventListener("mouseup", () => {
    if (state.currentStroke && state.currentStroke.points.length > 1) {
      state.strokes.push(state.currentStroke);
      updateImageModeUi();
    }
    state.currentStroke = null;
    isPanning = false;
    redrawAnnotationCanvas();
  });

  // Touch events (Android Pinch-to-Zoom around midpoint, Pan, Double-Tap Zoom, and 1-Finger Markup)
  viewport.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (e.touches.length >= 2) {
        // 2 fingers: always pinch-zoom & pan (cancel any in-progress 1-finger stroke)
        if (state.currentStroke) {
          state.currentStroke = null;
          redrawAnnotationCanvas();
        }
        isPanning = false;
        lastPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        lastPinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        lastPinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const now = Date.now();
        if (state.imageMode === "view" && now - lastTapTime < 280) {
          // Double-tap in view mode: cycle Fit (1x) -> Fill Width -> 2x -> Fit
          const focal = getViewportFocal(t.clientX, t.clientY);
          if (state.imgZoom < (state.imgFillWidthZoom || 1.5) - 0.1) {
            setZoomAroundFocalPoint(state.imgFillWidthZoom || 1.5, focal.x, focal.y, false);
          } else if (state.imgZoom < 1.9) {
            setZoomAroundFocalPoint(2.2, focal.x, focal.y, false);
          } else {
            state.imgZoom = 1.0;
            state.imgPanX = 0;
            state.imgPanY = 0;
            applyImageTransform();
          }
          lastTapTime = 0;
          return;
        }
        lastTapTime = now;

        if (state.imageMode === "draw") {
          state.currentStroke = { color: "#ef4444", points: [getCanvasCoords(t.clientX, t.clientY)] };
          redrawAnnotationCanvas();
        } else {
          isPanning = true;
          lastPanX = t.clientX;
          lastPanY = t.clientY;
        }
      }
    },
    { passive: false }
  );

  viewport.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      if (e.touches.length >= 2 && lastPinchDist) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        const ratio = dist / Math.max(1, lastPinchDist);
        lastPinchDist = dist;

        const focal = getViewportFocal(midX, midY);
        const prevZoom = state.imgZoom || 1.0;
        const nextZoom = Math.max(0.75, Math.min(8.0, prevZoom * ratio));
        const actualRatio = nextZoom / prevZoom;

        state.imgPanX = focal.x - (focal.x - state.imgPanX) * actualRatio + (midX - lastPinchMidX);
        state.imgPanY = focal.y - (focal.y - state.imgPanY) * actualRatio + (midY - lastPinchMidY);
        state.imgZoom = nextZoom;

        lastPinchMidX = midX;
        lastPinchMidY = midY;
        applyImageTransform();
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        if (state.currentStroke && state.imageMode === "draw") {
          state.currentStroke.points.push(getCanvasCoords(t.clientX, t.clientY));
          redrawAnnotationCanvas();
        } else if (isPanning) {
          state.imgPanX += t.clientX - lastPanX;
          state.imgPanY += t.clientY - lastPanY;
          lastPanX = t.clientX;
          lastPanY = t.clientY;
          applyImageTransform();
        }
      }
    },
    { passive: false }
  );

  viewport.addEventListener("touchend", (e) => {
    if (e.touches.length < 2 && lastPinchDist !== null) {
      lastPinchDist = null;
      // Magnetically snap if close to Fit (1.0) or 100% Width when finishing a pinch
      state.imgZoom = snapZoomValue(state.imgZoom);
      applyImageTransform();
      if (e.touches.length === 1) {
        // Prevent pan jump when lifting one finger after a 2-finger pinch!
        lastPanX = e.touches[0].clientX;
        lastPanY = e.touches[0].clientY;
        isPanning = state.imageMode === "view";
      }
    }
    if (e.touches.length === 0) {
      if (state.currentStroke && state.currentStroke.points.length > 1) {
        state.strokes.push(state.currentStroke);
        updateImageModeUi();
      }
      state.currentStroke = null;
      isPanning = false;
      redrawAnnotationCanvas();
    }
  });
}

// --- Interactive 3D STL Mesh Viewer (Binary & ASCII STL Parser + Touch Orbit Renderer) ---
function parseStlBuffer(buffer) {
  const view = new DataView(buffer);
  const triangles = [];

  // Check if binary STL: 80-byte header + uint32 count + count * 50 bytes
  if (buffer.byteLength >= 84) {
    const triCount = view.getUint32(80, true);
    const expectedByteLen = 84 + triCount * 50;
    if (expectedByteLen === buffer.byteLength && triCount > 0 && triCount < 2_000_000) {
      let offset = 84;
      for (let i = 0; i < triCount; i++) {
        const nx = view.getFloat32(offset, true);
        const ny = view.getFloat32(offset + 4, true);
        const nz = view.getFloat32(offset + 8, true);
        const v1 = [
          view.getFloat32(offset + 12, true),
          view.getFloat32(offset + 16, true),
          view.getFloat32(offset + 20, true),
        ];
        const v2 = [
          view.getFloat32(offset + 24, true),
          view.getFloat32(offset + 28, true),
          view.getFloat32(offset + 32, true),
        ];
        const v3 = [
          view.getFloat32(offset + 36, true),
          view.getFloat32(offset + 40, true),
          view.getFloat32(offset + 44, true),
        ];
        triangles.push({ n: [nx, ny, nz], v1, v2, v3 });
        offset += 50;
      }
      return triangles;
    }
  }

  // Fallback: ASCII STL
  const text = new TextDecoder().decode(buffer);
  const vertexRegex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  const verts = [];
  for (const m of text.matchAll(vertexRegex)) {
    verts.push([ parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]) ]);
  }
  for (let i = 0; i + 2 < verts.length; i += 3) {
    triangles.push({ n: [0, 0, 1], v1: verts[i], v2: verts[i + 1], v3: verts[i + 2] });
  }
  return triangles;
}

function normalizeStlTriangles(triangles) {
  if (triangles.length === 0) return [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const t of triangles) {
    for (const v of [t.v1, t.v2, t.v3]) {
      if (v[0] < minX) minX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-5);
  const scale = 2.0 / span;

  // Decimate if very high poly so mobile touch orbit stays 60fps
  const step = triangles.length > 25000 ? Math.ceil(triangles.length / 25000) : 1;
  const normalized = [];

  for (let i = 0; i < triangles.length; i += step) {
    const t = triangles[i];
    const p1 = [(t.v1[0] - cx) * scale, (t.v1[1] - cy) * scale, (t.v1[2] - cz) * scale];
    const p2 = [(t.v2[0] - cx) * scale, (t.v2[1] - cy) * scale, (t.v2[2] - cz) * scale];
    const p3 = [(t.v3[0] - cx) * scale, (t.v3[1] - cy) * scale, (t.v3[2] - cz) * scale];

    // Compute face normal
    const ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
    const vx = p3[0] - p1[0], vy = p3[1] - p1[1], vz = p3[2] - p1[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    normalized.push({ p1, p2, p3, n: [nx, ny, nz] });
  }

  return {
    triangles: normalized,
    originalCount: triangles.length,
    dimensions: [+(maxX - minX).toFixed(2), +(maxY - minY).toFixed(2), +(maxZ - minZ).toFixed(2)],
  };
}

async function openStlViewerModal(art) {
  state.currentStlArtifact = art;
  const modal = document.getElementById("stlModal");
  const titleEl = document.getElementById("stlModalTitle");
  const statsEl = document.getElementById("stlModalStats");
  if (!modal) return;

  titleEl.textContent = `🧊 ${art.name}`;
  statsEl.textContent = "Loading 3D STL geometry...";
  modal.classList.add("open");
  pushOverlayHistory("stlModal");

  try {
    const res = await fetch(withTokenUrl(art.url));
    const buf = await res.arrayBuffer();
    const rawTris = parseStlBuffer(buf);
    const norm = normalizeStlTriangles(rawTris);
    state.stlTriangles = norm.triangles || [];
    state.stlRotationX = -0.65;
    state.stlRotationZ = 0.6;
    state.stlZoom = 1.0;
    state.stlPanX = 0;
    state.stlPanY = 0;
    statsEl.textContent = `${norm.originalCount?.toLocaleString() || 0} tris • Size: ${
      norm.dimensions ? norm.dimensions.join(" × ") : ""
    } mm`;
    renderStlCanvas();
  } catch (err) {
    statsEl.textContent = `Failed to load STL: ${err.message}`;
  }
}

function renderStlCanvas() {
  const canvas = document.getElementById("stlCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#060911";
  ctx.fillRect(0, 0, w, h);

  const tris = state.stlTriangles;
  if (!tris || tris.length === 0) return;

  const cosZ = Math.cos(state.stlRotationZ), sinZ = Math.sin(state.stlRotationZ);
  const cosX = Math.cos(state.stlRotationX), sinX = Math.sin(state.stlRotationX);
  const baseScale = Math.min(w, h) * 0.36 * state.stlZoom;
  const cx = w / 2 + state.stlPanX;
  const cy = h / 2 + state.stlPanY;

  const rot = (p) => {
    const x1 = p[0] * cosZ - p[1] * sinZ;
    const y1 = p[0] * sinZ + p[1] * cosZ;
    const z1 = p[2];
    const y2 = y1 * cosX - z1 * sinX;
    const z2 = y1 * sinX + z1 * cosX;
    return [x1, y2, z2];
  };

  const projected = [];
  for (const t of tris) {
    const r1 = rot(t.p1);
    const r2 = rot(t.p2);
    const r3 = rot(t.p3);
    const rn = rot(t.n);
    const depth = (r1[2] + r2[2] + r3[2]) / 3;
    projected.push({ r1, r2, r3, rn, depth });
  }

  projected.sort((a, b) => a.depth - b.depth);

  const light = [0.35, -0.45, 0.82];
  for (const p of projected) {
    const dot = Math.abs(p.rn[0] * light[0] + p.rn[1] * light[1] + p.rn[2] * light[2]);
    const shade = Math.round(45 + dot * 175);
    ctx.beginPath();
    ctx.moveTo(cx + p.r1[0] * baseScale, cy - p.r1[1] * baseScale);
    ctx.lineTo(cx + p.r2[0] * baseScale, cy - p.r2[1] * baseScale);
    ctx.lineTo(cx + p.r3[0] * baseScale, cy - p.r3[1] * baseScale);
    ctx.closePath();

    if (!state.stlWireframe) {
      ctx.fillStyle = `rgb(${Math.round(shade * 0.45)}, ${Math.round(shade * 0.78)}, ${shade})`;
      ctx.fill();
    } else {
      ctx.strokeStyle = "rgba(56, 189, 248, 0.55)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
}

function setupStlCanvasEvents() {
  const canvas = document.getElementById("stlCanvas");
  if (!canvas) return;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastPinchDist = null;

  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.stlRotationZ += dx * 0.01;
    state.stlRotationX += dy * 0.01;
    renderStlCanvas();
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      state.stlZoom = Math.max(0.25, Math.min(5.0, state.stlZoom * (e.deltaY < 0 ? 1.12 : 0.9)));
      renderStlCanvas();
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        dragging = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        dragging = false;
        lastPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && dragging) {
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        state.stlRotationZ += dx * 0.012;
        state.stlRotationX += dy * 0.012;
        renderStlCanvas();
      } else if (e.touches.length === 2 && lastPinchDist) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const ratio = dist / lastPinchDist;
        lastPinchDist = dist;
        state.stlZoom = Math.max(0.25, Math.min(5.0, state.stlZoom * ratio));
        renderStlCanvas();
      }
    },
    { passive: false }
  );

  canvas.addEventListener("touchend", () => {
    dragging = false;
    lastPinchDist = null;
  });
}

// --- Text / Markdown / JSON Artifact Viewer ---
async function openDocViewerModal(art) {
  state.currentDocArtifact = art;
  const modal = document.getElementById("docModal");
  const titleEl = document.getElementById("docModalTitle");
  const contentEl = document.getElementById("docModalContent");
  if (!modal) return;

  titleEl.textContent = `📄 ${art.name}`;
  contentEl.textContent = "Loading content...";
  modal.classList.add("open");
  pushOverlayHistory("docModal");

  try {
    const res = await fetch(withTokenUrl(art.url));
    const text = await res.text();
    contentEl.textContent = text.slice(0, 100_000);
  } catch (err) {
    contentEl.textContent = `Failed to load file: ${err.message}`;
  }
}

// --- Git Diff & Mobile Review Queue ---
function renderReviewsQueue() {
  const listEl = document.getElementById("reviewQueueList");
  if (!listEl) return;

  const queued = state.reviews.filter((r) => r.status === "queued");
  if (queued.length === 0) {
    listEl.innerHTML = `<div style="font-size: 12px; color: var(--text-muted);">No queued comments yet. Annotate an image, 3D model, or diff file to queue feedback.</div>`;
    return;
  }

  listEl.innerHTML = queued
    .map(
      (r) => `
      <div class="review-item">
        <div style="display: flex; gap: 10px; align-items: flex-start;">
          ${
            r.annotatedImageUrl
              ? `<img class="review-item-thumb" src="${escapeHtml(
                  withTokenUrl(r.annotatedImageUrl)
                )}" alt="Annotated" />`
              : ""
          }
          <div>
            <div style="font-size: 11px; color: var(--accent); font-weight: 700;">
              [${escapeHtml(r.targetType.toUpperCase())}] ${escapeHtml(r.targetPath || "")}
            </div>
            <div style="font-size: 13px; margin-top: 2px;">${escapeHtml(r.comment)}</div>
          </div>
        </div>
        <button class="btn btn-sm btn-danger delete-review-btn" data-review-id="${escapeHtml(
          r.id
        )}">✕</button>
      </div>
    `
    )
    .join("");

  listEl.querySelectorAll(".delete-review-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-review-id");
      if (!id || !state.activeSessionId) return;
      await apiFetch(
        `/api/sessions/${encodeURIComponent(state.activeSessionId)}/reviews/${encodeURIComponent(
          id
        )}`,
        { method: "DELETE" }
      );
      await loadSessionDetail(state.activeSessionId, false);
    });
  });
}

function renderDiff() {
  const container = document.getElementById("diffContainer");
  if (!container || !state.diff) return;

  const d = state.diff;
  if (!d.files || d.files.length === 0) {
    container.innerHTML = `<div style="color: var(--text-secondary); padding: 12px;">Working tree is clean on branch <code>${escapeHtml(
      d.branch
    )}</code>.</div>`;
    return;
  }

  container.innerHTML = d.files
    .map((f) => {
      const patchLines = (f.patch || "Binary or untracked file")
        .split(/\r?\n/)
        .map((line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            return `<span class="diff-line-add">${escapeHtml(line)}</span>`;
          }
          if (line.startsWith("-") && !line.startsWith("---")) {
            return `<span class="diff-line-del">${escapeHtml(line)}</span>`;
          }
          return `${escapeHtml(line)}\n`;
        })
        .join("");

      return `
        <div class="diff-file-card">
          <div class="diff-file-header">
            <span><strong>${escapeHtml(f.path)}</strong> (${escapeHtml(f.status)} • +${
        f.insertions
      } / -${f.deletions})</span>
            <button class="btn btn-sm diff-comment-btn" data-file-path="${escapeHtml(
              f.path
            )}">💬 Comment</button>
          </div>
          <pre class="diff-patch">${patchLines}</pre>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".diff-comment-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const filePath = btn.getAttribute("data-file-path") || "";
      const comment = window.prompt(`Add review comment on ${filePath}:`);
      if (!comment || !comment.trim() || !state.activeSessionId) return;
      await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/reviews`, {
        method: "POST",
        body: {
          targetType: "diff",
          targetPath: filePath,
          comment: comment.trim(),
          syncToDesktopDiff: true,
        },
      });
      await loadSessionDetail(state.activeSessionId, false);
    });
  });
}

// --- Copilot Plan / Monthly Quota, Session Plan & Desktop MCP Details ---
function formatCompactNum(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(Math.round(num));
}

function renderQuotaDrawerCard() {
  const el = document.getElementById("quotaDrawerCard");
  if (!el) return;
  const q = state.hostStatus?.quota;
  if (!q || !q.premium) {
    el.style.display = "none";
    return;
  }

  const p = q.premium;
  const barFillColor =
    p.percentUsed > 85
      ? "linear-gradient(90deg, #f59e0b 0%, #ef4444 100%)"
      : "linear-gradient(90deg, #38bdf8 0%, #a855f7 100%)";

  el.style.display = "flex";
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:700;color:#f8fafc;">⚡ Copilot ${escapeHtml(
        q.plan.charAt(0).toUpperCase() + q.plan.slice(1)
      )}</span>
      <span style="color:#94a3b8;font-size:10.5px;">${
        q.resetDate ? `Resets ${escapeHtml(q.resetDate)}` : "Monthly Quota"
      }</span>
    </div>
    <div class="quota-bar-track">
      <div class="quota-bar-fill" style="width:${Math.min(100, Math.max(2, p.percentUsed))}%;background:${barFillColor};"></div>
    </div>
    <div style="display:flex;justify-content:space-between;color:#cbd5e1;font-size:11px;">
      <span>Used: <strong>${p.percentUsed}%</strong> (${formatCompactNum(p.used)} / ${formatCompactNum(p.entitlement)})</span>
      <span style="color:#4ade80;font-weight:600;">${p.percentRemaining}% left</span>
    </div>
  `;
}

function renderTodosAndMcps() {
  const quotaEl = document.getElementById("quotaDetailsContainer");
  const todosEl = document.getElementById("todosContainer");
  const mcpsEl = document.getElementById("mcpDetailsContainer");
  if (!todosEl || !mcpsEl) return;

  if (quotaEl) {
    const q = state.hostStatus?.quota;
    const s = state.activeSession;
    const tu = s?.tokenUsage;
    const planArt = state.artifacts.find((a) => a.name.toLowerCase() === "plan.md");

    let quotaCardHtml = "";
    if (q && q.premium) {
      const p = q.premium;
      quotaCardHtml = `
        <div class="turn-card" style="padding: 12px 14px; border-color: rgba(56, 189, 248, 0.3);">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
            <strong>📊 GitHub Copilot Plan &amp; Monthly Quota</strong>
            <span class="badge badge-busy">COPILOT ${escapeHtml(q.plan.toUpperCase())}</span>
          </div>
          <div class="quota-bar-track" style="height:8px;margin:4px 0;">
            <div class="quota-bar-fill" style="width:${Math.min(100, Math.max(2, p.percentUsed))}%;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12.5px;color:#e2e8f0;flex-wrap:wrap;gap:6px;">
            <span><strong>${p.percentUsed}% used</strong> (${p.used.toLocaleString()} / ${p.entitlement.toLocaleString()} credits)</span>
            <span style="color:#4ade80;font-weight:700;">${p.percentRemaining}% remaining (${p.remaining.toLocaleString()} left)</span>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--text-secondary);margin-top:2px;">
            ${q.resetDate ? `<span>📅 Resets: <strong>${escapeHtml(q.resetDate)}</strong></span>` : ""}
            <span>💬 Chat &amp; Completions: <strong>${q.chatUnlimited ? "Unlimited" : "Metered"}</strong></span>
            <span>🔓 Overage: <strong>${p.overagePermitted ? "Enabled" : "Disabled"}</strong></span>
          </div>
        </div>
      `;
    }

    const sessionUsageHtml = tu
      ? `
        <div class="turn-card" style="padding: 11px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>⚡ Active Session Resource Usage</strong>
            ${tu.aiuUsed ? `<span class="badge badge-idle">${tu.aiuUsed.toLocaleString()} AIU</span>` : ""}
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#cbd5e1;">
            <span>Input: <strong>${formatCompactNum(tu.totalInputTokens)}</strong></span>
            <span>Cached: <strong>${formatCompactNum(tu.totalCachedTokens)}</strong></span>
            <span>Output: <strong>${formatCompactNum(tu.totalOutputTokens)}</strong></span>
            <span>Reasoning: <strong>${formatCompactNum(tu.totalReasoningTokens)}</strong></span>
          </div>
        </div>
      `
      : "";

    const planDocHtml = planArt
      ? `
        <div class="turn-card" style="padding: 11px 14px; border-color: rgba(168, 85, 247, 0.35);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>🗺️ Session Implementation Plan (plan.md)</strong>
            <button id="openPlanMdBtn" class="btn btn-sm btn-purple">📄 Open plan.md</button>
          </div>
        </div>
      `
      : "";

    quotaEl.innerHTML = quotaCardHtml + sessionUsageHtml + planDocHtml;
    document.getElementById("openPlanMdBtn")?.addEventListener("click", () => {
      if (planArt) openDocViewerModal(planArt);
    });
  }

  // Render Background & Sub-Agents + Child/Parent Sessions
  const subAgentsEl = document.getElementById("subAgentsContainer");
  if (subAgentsEl) {
    const s = state.activeSession;
    const parentSess = s?.parentSessionId
      ? state.sessions.find((x) => x.id === s.parentSessionId)
      : null;
    const childSessions = s
      ? state.sessions.filter((x) => x.parentSessionId === s.id)
      : [];
    const subAgents = state.subAgents || [];

    const blocks = [];
    if (parentSess) {
      blocks.push(`
        <div class="turn-card" style="padding: 10px 12px; border-color: rgba(163, 113, 247, 0.4);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div>
              <div style="font-size:11px;color:#d2a8ff;font-weight:600;">PARENT COORDINATOR SESSION</div>
              <div style="font-weight:600;font-size:13px;">${escapeHtml(parentSess.title)}</div>
            </div>
            <button class="btn btn-sm jump-session-btn" data-target-session="${escapeHtml(parentSess.id)}">Open Parent</button>
          </div>
        </div>
      `);
    }

    if (childSessions.length > 0) {
      blocks.push(
        `<strong>Coordinated Child Sessions (${childSessions.length})</strong>` +
          childSessions
            .map(
              (cs) => `
              <div class="turn-card" style="padding: 10px 12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                  <div>
                    <div style="font-weight:600;font-size:13px;">↳ ${escapeHtml(cs.title)}</div>
                    <div style="font-size:11.5px;color:var(--text-secondary);">
                      ${cs.branch ? `#${escapeHtml(cs.branch)} · ` : ""}${escapeHtml(cs.model || "auto")} · ${formatTimeAgo(cs.updatedAt)}
                    </div>
                  </div>
                  <div style="display:flex;gap:6px;align-items:center;">
                    <span class="badge ${cs.isRunning ? "badge-busy" : "badge-idle"}">${cs.isRunning ? "RUNNING" : "IDLE"}</span>
                    <button class="btn btn-sm jump-session-btn" data-target-session="${escapeHtml(cs.id)}">Open</button>
                  </div>
                </div>
              </div>`
            )
            .join("")
      );
    }

    if (subAgents.length > 0) {
      const runningCnt = subAgents.filter((a) => a.status === "running").length;
      blocks.push(
        `<strong>Background &amp; Sub-Agents (${
          runningCnt > 0 ? `${runningCnt} running / ` : ""
        }${subAgents.length} total)</strong>` +
          subAgents
            .map((sa) => {
              const badgeCls =
                sa.status === "running"
                  ? "badge-busy"
                  : sa.status === "failed"
                  ? "badge-alert"
                  : "badge-idle";
              const stats = [];
              stats.push(sa.mode === "background" ? "Background" : "Sync");
              stats.push(sa.agentType);
              if (sa.model) stats.push(sa.model);
              if (sa.totalToolCalls) stats.push(`${sa.totalToolCalls} tools`);
              if (sa.totalTokens) stats.push(`${formatCompactNum(sa.totalTokens)} tokens`);
              if (sa.durationMs) stats.push(`${Math.round(sa.durationMs / 1000)}s`);
              return `
                <details class="turn-card" style="padding: 10px 12px;">
                  <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                    <div>
                      <div style="font-weight:600;font-size:13px;">[${escapeHtml(sa.name)}] ${escapeHtml(sa.description)}</div>
                      <div style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(stats.join(" · "))}</div>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                      <button class="btn btn-sm inspect-subagent-from-tab-btn" data-subagent-id="${escapeHtml(sa.toolCallId)}">Open Stream →</button>
                      <span class="badge ${badgeCls}">${escapeHtml(sa.status.toUpperCase())}</span>
                    </div>
                  </summary>
                  <div class="tool-call-details" style="margin-top:8px;">${
                    sa.promptPreview ? `Task Prompt:\n${escapeHtml(sa.promptPreview)}\n\n` : ""
                  }${
                sa.resultPreview
                  ? `Sub-Agent Output:\n${escapeHtml(sa.resultPreview)}`
                  : "No output recorded yet."
              }</div>
                </details>`;
            })
            .join("")
      );
    }

    subAgentsEl.innerHTML = blocks.join("");
    subAgentsEl.querySelectorAll(".jump-session-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.getAttribute("data-target-session");
        if (targetId) {
          selectSession(targetId);
          document.querySelector('.view-tab[data-tab="stream"]')?.click();
        }
      });
    });
    subAgentsEl.querySelectorAll(".inspect-subagent-from-tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetId = btn.getAttribute("data-subagent-id");
        if (targetId) {
          state.activeSubAgentId = targetId;
          state.activeDetachedShellId = null;
          document.querySelector('.view-tab[data-tab="stream"]')?.click();
          renderAgentHierarchyBar();
          renderTurns(true);
        }
      });
    });
  }

  if (state.todos.length === 0) {
    todosEl.innerHTML = `<div style="color: var(--text-secondary);">No session SQLite todos recorded for this session.</div>`;
  } else {
    todosEl.innerHTML =
      `<strong>☑️ Session Task Breakdown (${state.todos.filter((t) => t.status === "done").length}/${
        state.todos.length
      })</strong>` +
      state.todos
        .map((t) => {
          const icon =
            t.status === "done"
              ? "✅"
              : t.status === "in_progress"
              ? "🔄"
              : t.status === "blocked"
              ? "⛔"
              : "⬜";
          return `
            <div class="turn-card" style="padding: 10px 12px;">
              <div style="font-weight: 600;">${icon} ${escapeHtml(t.title)}</div>
              ${
                t.description
                  ? `<div style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(
                      t.description
                    )}</div>`
                  : ""
              }
            </div>
          `;
        })
        .join("");
  }

  const servers = state.hostStatus?.mcpServers || [];
  mcpsEl.innerHTML =
    `<strong>Desktop MCP Servers Available to Session</strong>` +
    servers
      .map(
        (s) => `
        <div class="turn-card" style="padding: 10px 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
            <strong>${escapeHtml(s.name)}</strong>
            <span class="badge ${s.enabled ? "badge-busy" : "badge-idle"}">${
          s.enabled ? "ACTIVE" : "DISABLED"
        } (${escapeHtml(s.type)})</span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-secondary);">
            Tools: ${escapeHtml(s.tools.join(", "))}
          </div>
        </div>
      `
      )
      .join("");
}

function renderLoginApprovalBanner(req) {
  const banner = document.getElementById("loginApprovalBanner");
  if (!banner) return;
  banner.style.display = "flex";
  banner.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
      <span style="font-weight:600;color:#58a6ff;font-size:13px;">New Machine Login Request — Match Code: <strong style="font-size:15px;color:#fff;padding:1px 6px;background:#1f6feb;border-radius:4px;">${escapeHtml(req.matchCode)}</strong></span>
      <span style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(req.label)} (${escapeHtml(req.clientIp)})</span>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
      <button class="btn btn-sm btn-primary approve-login-btn" data-hours="1">Approve 1h</button>
      <button class="btn btn-sm btn-primary approve-login-btn" data-hours="8">Approve 8h</button>
      <button class="btn btn-sm btn-primary approve-login-btn" data-hours="24">Approve 24h</button>
      <button id="denyLoginReqBtn" class="btn btn-sm btn-danger">Deny</button>
    </div>
  `;

  banner.querySelectorAll(".approve-login-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const hours = Number(btn.getAttribute("data-hours") || 8);
      banner.style.display = "none";
      await apiFetch("/api/auth/resolve-approval", {
        method: "POST",
        body: { requestId: req.requestId, approved: true, durationHours: hours },
      });
    });
  });

  document.getElementById("denyLoginReqBtn")?.addEventListener("click", async () => {
    banner.style.display = "none";
    await apiFetch("/api/auth/resolve-approval", {
      method: "POST",
      body: { requestId: req.requestId, approved: false },
    });
  });
}

// --- QR Pairing, Rolling MFA & WAN Modal ---
let mfaTimer = null;
let mfaSecondsLeft = 0;

function startMfaCountdown(seconds) {
  mfaSecondsLeft = Number(seconds || 30);
  if (mfaTimer) clearInterval(mfaTimer);
  const countEl = document.getElementById("mfaCountdownText");
  if (countEl) countEl.textContent = `Refreshes in ${mfaSecondsLeft}s`;

  mfaTimer = setInterval(() => {
    if (!document.getElementById("qrModal")?.classList.contains("open")) {
      clearInterval(mfaTimer);
      mfaTimer = null;
      return;
    }
    mfaSecondsLeft -= 1;
    if (mfaSecondsLeft <= 0) {
      refreshQrModalInfo();
    } else if (countEl) {
      countEl.textContent = `Refreshes in ${mfaSecondsLeft}s`;
    }
  }, 1000);
}

async function refreshQrModalInfo() {
  try {
    const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
    const res = await fetch(resolvePeerPath("/api/pair-info"), { headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const info = await res.json();
    document.getElementById("qrCodeImg").src = info.qrDataUrl;
    const lines = [];
    if (info.wanBase) {
      lines.push(`<div><strong>WAN URL:</strong> ${escapeHtml(info.wanBase)}</div>`);
    }
    for (const u of info.lanUrls || []) {
      lines.push(`<div><strong>LAN URL:</strong> ${escapeHtml(u)}</div>`);
    }
    for (const u of info.tailscaleUrls || []) {
      lines.push(`<div><strong>Tailscale:</strong> ${escapeHtml(u)}</div>`);
    }
    document.getElementById("qrUrlsList").innerHTML = lines.join("");

    // Populate Rolling 6-Digit MFA Generator for already-paired device
    const mfaCard = document.getElementById("mfaGeneratorCard");
    if (mfaCard && info.mfa) {
      mfaCard.style.display = "flex";
      const codeStr = String(info.mfa.code || "000000");
      const formattedCode = `${codeStr.slice(0, 3)} ${codeStr.slice(3)}`;
      const codeEl = document.getElementById("mfaLiveCodeText");
      if (codeEl) codeEl.textContent = formattedCode;
      startMfaCountdown(info.mfa.secondsRemaining);

      const authLink = document.getElementById("addToAuthenticatorLink");
      if (authLink && info.mfa.otpauthUri) {
        authLink.href = info.mfa.otpauthUri;
      }
      const totpQrImg = document.getElementById("totpQrImg");
      if (totpQrImg && info.mfa.totpQrDataUrl) {
        totpQrImg.src = info.mfa.totpQrDataUrl;
      }

      const tempWrap = document.getElementById("tempSessionsContainer");
      const tempList = info.mfa.tempSessions || [];
      if (tempWrap) {
        if (tempList.length === 0) {
          tempWrap.style.display = "none";
          tempWrap.innerHTML = "";
        } else {
          tempWrap.style.display = "flex";
          tempWrap.innerHTML =
            `<div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);">Active Temporary Machines (${tempList.length})</div>` +
            tempList
              .map(
                (ts) => `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;background:var(--bg-primary);padding:5px 8px;border-radius:6px;border:1px solid var(--border);">
                  <span><strong>${escapeHtml(ts.label)}</strong> (${escapeHtml(ts.clientIp)}) • expires ${formatTimeAgo(ts.expiresAt)}</span>
                  <button class="btn btn-sm btn-danger revoke-temp-btn" data-temp-id="${escapeHtml(ts.id)}">Revoke</button>
                </div>`
              )
              .join("");

          tempWrap.querySelectorAll(".revoke-temp-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const id = btn.getAttribute("data-temp-id");
              if (!id) return;
              await apiFetch("/api/auth/revoke-temp", { method: "POST", body: { id } });
              await refreshQrModalInfo();
            });
          });
        }
      }
    }

    const wanLabel = document.getElementById("wanStatusLabel");
    const startBtn = document.getElementById("startWanBtn");
    const stopBtn = document.getElementById("stopWanBtn");
    const customWanInput = document.getElementById("customWanUrlInput");
    if (wanLabel && startBtn && stopBtn) {
      const wan = info.wan || {};
      if (customWanInput && wan.customWanUrl) {
        customWanInput.value = wan.customWanUrl;
      }
      if (wan.status === "online" && wan.publicUrl) {
        wanLabel.textContent = `ONLINE: ${wan.publicUrl}`;
        wanLabel.style.color = "var(--success)";
        startBtn.style.display = "none";
        stopBtn.style.display = "inline-flex";
      } else if (wan.status === "starting" || wan.status === "installing") {
        wanLabel.textContent = `${wan.status.toUpperCase()} Cloudflare tunnel...`;
        wanLabel.style.color = "var(--warning)";
        startBtn.disabled = true;
      } else {
        wanLabel.textContent = wan.error ? `Error: ${wan.error}` : "Stopped (LAN only)";
        wanLabel.style.color = wan.error ? "var(--danger)" : "var(--text-secondary)";
        startBtn.disabled = false;
        startBtn.style.display = "inline-flex";
        stopBtn.style.display = "none";
      }
    }

    const apkBtn = document.getElementById("downloadApkBtn");
    if (apkBtn) {
      apkBtn.href = withTokenUrl("/download/RemoteAgent-android.apk");
    }
    const autoPairBtn = document.getElementById("autoPairNativeAppBtn");
    if (autoPairBtn && info.token) {
      const lanParam = encodeURIComponent(info.lanBase || "");
      const wanParam = encodeURIComponent(info.wanBase || "");
      const tokParam = encodeURIComponent(info.token || "");
      autoPairBtn.href = `remoteagent://pair?lan=${lanParam}&wan=${wanParam}&token=${tokParam}`;
      autoPairBtn.style.display = "inline-flex";
    }
    const deskBtn = document.getElementById("downloadDesktopBtn");
    if (deskBtn) {
      deskBtn.href = withTokenUrl("/download/RemoteAgent-Desktop-Setup.exe");
    }
  } catch {
    document.getElementById("qrUrlsList").textContent =
      "Enter the pairing token shown in your Desktop app or terminal.";
  }
}

async function openQrModal() {
  const modal = document.getElementById("qrModal");
  if (!modal) return;
  const alreadyOpen = modal.classList.contains("open");
  if (!alreadyOpen) {
    modal.classList.add("open");
    pushOverlayHistory("qrModal");
    const inputEl = document.getElementById("manualTokenInput");
    if (inputEl && document.activeElement !== inputEl && !inputEl.value) {
      inputEl.value = state.token || "";
    }
  }
  if (state.token || !alreadyOpen) {
    await refreshQrModalInfo();
  }
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  const toggleMobileDrawer = () => {
    const panel = document.getElementById("sessionsPanel");
    if (!panel) return;
    const opening = !panel.classList.contains("mobile-open");
    panel.classList.toggle("mobile-open");
    if (opening) pushOverlayHistory("sessionsDrawer");
  };

  document.getElementById("mobileMenuBtn")?.addEventListener("click", toggleMobileDrawer);
  document.getElementById("topbarTitleTapArea")?.addEventListener("click", () => {
    if (window.innerWidth <= 820) {
      toggleMobileDrawer();
    }
  });

  document.getElementById("refreshBtn")?.addEventListener("click", async () => {
    const base = window.location.pathname || "/";
    const tok = state.token ? `?token=${encodeURIComponent(state.token)}&_v=${Date.now()}` : `?_v=${Date.now()}`;
    window.location.replace(`${base}${tok}`);
  });

  document.getElementById("sessionSearchInput")?.addEventListener("input", () => {
    renderSessionsList();
  });

  document.getElementById("sessionGroupBySelect")?.addEventListener("change", (e) => {
    state.uiPrefs.groupBy = e.target.value;
    renderSessionsList();
    saveUiPrefsToServer();
  });

  document.getElementById("sessionSortBySelect")?.addEventListener("change", (e) => {
    state.uiPrefs.sortBy = e.target.value;
    renderSessionsList();
    saveUiPrefsToServer();
  });

  document.getElementById("openQrBtn")?.addEventListener("click", openQrModal);
  document.getElementById("closeQrModalBtn")?.addEventListener("click", () => {
    closeModalWithHistory("qrModal");
  });

  document.getElementById("startWanBtn")?.addEventListener("click", async () => {
    const wanLabel = document.getElementById("wanStatusLabel");
    const startBtn = document.getElementById("startWanBtn");
    if (wanLabel) wanLabel.textContent = "Starting Cloudflare HTTPS WAN tunnel...";
    if (startBtn) startBtn.disabled = true;
    try {
      await apiFetch("/api/wan/start", { method: "POST", body: { persistAutoStart: true } });
      await loadHostStatus();
      await refreshQrModalInfo();
    } catch (err) {
      if (wanLabel) wanLabel.textContent = `WAN Error: ${err.message}`;
      if (startBtn) startBtn.disabled = false;
    }
  });

  document.getElementById("stopWanBtn")?.addEventListener("click", async () => {
    try {
      await apiFetch("/api/wan/stop", { method: "POST" });
      await loadHostStatus();
      await refreshQrModalInfo();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("saveCustomWanUrlBtn")?.addEventListener("click", async () => {
    const val = document.getElementById("customWanUrlInput")?.value?.trim() || "";
    try {
      await apiFetch("/api/wan/custom-url", { method: "POST", body: { url: val || null } });
      await loadHostStatus();
      await refreshQrModalInfo();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("linkPeerMachineBtn")?.addEventListener("click", async () => {
    const inputEl = document.getElementById("peerPairingUrlInput");
    const pairingUrl = inputEl?.value?.trim() || "";
    if (!pairingUrl) return;
    const btn = document.getElementById("linkPeerMachineBtn");
    if (btn) btn.textContent = "Linking...";
    try {
      const res = await apiFetch("/api/peers", {
        method: "POST",
        body: { pairingUrl },
      });
      localStorage.setItem("ra_saved_hosts", JSON.stringify(res.peers || []));
      if (inputEl) inputEl.value = "";
      if (btn) btn.textContent = "Linked ✓";
      await loadHostStatus();
      setTimeout(() => {
        if (btn) btn.textContent = "Link";
      }, 2000);
    } catch (err) {
      if (btn) btn.textContent = "Link";
      alert(err.message);
    }
  });

  document.getElementById("toggleTotpQrBtn")?.addEventListener("click", () => {
    const wrap = document.getElementById("totpQrWrap");
    if (wrap) {
      wrap.style.display = wrap.style.display === "none" ? "block" : "none";
    }
  });

  document.getElementById("saveTokenBtn")?.addEventListener("click", async () => {
    const val = document.getElementById("manualTokenInput")?.value?.trim() || "";
    if (!val) return;
    const durationHours = Number(document.getElementById("tempLeaseDurationSelect")?.value || 8);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: val, durationHours }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Invalid MFA code or pairing token");
      }
      const effectiveToken = data.token || val;
      state.token = effectiveToken;
      localStorage.setItem("ra_token", effectiveToken);
      document.getElementById("qrModal")?.classList.remove("open");
      await loadHostStatus();
      await loadSessionsList(true);
      connectWebSocket();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("requestPhoneApprovalBtn")?.addEventListener("click", async () => {
    const statusEl = document.getElementById("phoneApprovalStatusText");
    const btn = document.getElementById("requestPhoneApprovalBtn");
    const durationHours = Number(document.getElementById("tempLeaseDurationSelect")?.value || 8);
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/auth/request-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationHours }),
      });
      const data = await res.json();
      if (!res.ok || !data.requestId) {
        throw new Error(data.error || "Failed to request approval");
      }
      if (statusEl) {
        statusEl.style.display = "block";
        statusEl.innerHTML = `Waiting for approval on your paired phone... Match Code: <strong style="color:#fff;background:#1f6feb;padding:1px 7px;border-radius:4px;">${escapeHtml(data.matchCode)}</strong>`;
      }

      const pollTimer = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/auth/poll-approval?requestId=${encodeURIComponent(data.requestId)}`);
          const pollData = await pollRes.json();
          if (pollData.status === "approved" && pollData.token) {
            clearInterval(pollTimer);
            state.token = pollData.token;
            localStorage.setItem("ra_token", pollData.token);
            if (statusEl) statusEl.style.display = "none";
            if (btn) btn.disabled = false;
            document.getElementById("qrModal")?.classList.remove("open");
            await loadHostStatus();
            await loadSessionsList(true);
            connectWebSocket();
          } else if (pollData.status === "denied" || pollData.status === "expired") {
            clearInterval(pollTimer);
            if (statusEl) statusEl.textContent = `Request ${pollData.status}.`;
            if (btn) btn.disabled = false;
          }
        } catch {
          clearInterval(pollTimer);
          if (btn) btn.disabled = false;
        }
      }, 1200);
    } catch (err) {
      if (btn) btn.disabled = false;
      alert(err.message);
    }
  });

  // Smart sticky auto-scroll listener on #tab-stream
  const streamPane = document.getElementById("tab-stream");
  streamPane?.addEventListener(
    "scroll",
    () => {
      if (Date.now() < programmaticScrollUntil) return;
      state.stickToBottom = isStreamNearBottom(streamPane);
      updateJumpToBottomButton();
    },
    { passive: true }
  );

  const turnsContainerEl = document.getElementById("turnsContainer");
  if (turnsContainerEl && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (state.stickToBottom && streamPane) {
        programmaticScrollUntil = Date.now() + 180;
        streamPane.scrollTop = streamPane.scrollHeight + 10000;
        updateJumpToBottomButton();
      }
    });
    ro.observe(turnsContainerEl);
  }

  // iMessage / SMS-style swipe-left gesture on #tab-stream to peek message timestamps
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swipeLockedHorizontal = false;
  let swipeCancelVertical = false;
  let swipedBubbleCard = null;
  let lastSwipeDx = 0;

  streamPane?.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
      swipeLockedHorizontal = false;
      swipeCancelVertical = false;
      lastSwipeDx = 0;
      swipedBubbleCard = e.target.closest?.(".turn-card[data-turn-id]") || null;
    },
    { passive: true }
  );

  streamPane?.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1 || swipeCancelVertical) return;
      const dx = e.touches[0].clientX - swipeStartX;
      const dy = e.touches[0].clientY - swipeStartY;

      if (!swipeLockedHorizontal) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
          swipeCancelVertical = true;
          return;
        }
        if (dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.35) {
          swipeLockedHorizontal = true;
        }
      }

      if (swipeLockedHorizontal) {
        lastSwipeDx = dx;
        const turnsEl = document.getElementById("turnsContainer");
        if (turnsEl) {
          const damped = Math.max(-76, Math.min(0, dx * 0.58));
          turnsEl.classList.add("swiping-timestamps");
          turnsEl.style.setProperty("--swipe-x", `${Math.round(damped)}px`);
        }
      }
    },
    { passive: true }
  );

  const finishTimestampSwipe = () => {
    const turnsEl = document.getElementById("turnsContainer");
    if (turnsEl && turnsEl.classList.contains("swiping-timestamps")) {
      turnsEl.classList.remove("swiping-timestamps");
      turnsEl.style.removeProperty("--swipe-x");
    }
    if (swipeLockedHorizontal && lastSwipeDx < -38 && swipedBubbleCard) {
      const turnId = swipedBubbleCard.getAttribute("data-turn-id");
      if (turnId) {
        if (state.revealedTimestampTurnIds.has(turnId)) {
          state.revealedTimestampTurnIds.delete(turnId);
          swipedBubbleCard.classList.remove("show-timestamp");
        } else {
          state.revealedTimestampTurnIds.add(turnId);
          swipedBubbleCard.classList.add("show-timestamp");
        }
      }
    }
    swipeLockedHorizontal = false;
    swipeCancelVertical = false;
    swipedBubbleCard = null;
    lastSwipeDx = 0;
  };

  streamPane?.addEventListener("touchend", finishTimestampSwipe, { passive: true });
  streamPane?.addEventListener("touchcancel", finishTimestampSwipe, { passive: true });

  document.getElementById("jumpToBottomBtn")?.addEventListener("click", () => {
    scrollStreamToBottomIfSticky(true);
  });

  // View Tabs switching
  document.querySelectorAll(".view-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      const tab = tabBtn.getAttribute("data-tab") || "stream";
      state.activeTab = tab;
      document.querySelectorAll(".view-tab").forEach((b) => b.classList.remove("active"));
      tabBtn.classList.add("active");
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      document.getElementById(`tab-${tab}`)?.classList.add("active");
      if (tab === "stream" && state.stickToBottom) {
        scrollStreamToBottomIfSticky(true);
      } else {
        updateJumpToBottomButton();
      }
      if (tab === "reviews" && state.activeSessionId) {
        loadSessionDiff(state.activeSessionId);
      }
    });
  });

  // Artifact category filter chips
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.artifactFilter = chip.getAttribute("data-filter") || "all";
      document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderArtifactsGallery();
    });
  });

  // Mode, Model, Reasoning Effort & Context Tier switchers
  const updateSessionConfig = async (patch) => {
    if (!state.activeSessionId) return;
    if (state.activeSession) {
      Object.assign(state.activeSession, patch);
      renderSessionHeader();
    }
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/config`, {
        method: "POST",
        body: patch,
      });
    } catch (err) {
      console.error("Failed to update session config:", err);
    }
  };

  document.getElementById("sessionModeSelect")?.addEventListener("change", (e) => {
    updateSessionConfig({ mode: e.target.value });
  });

  document.getElementById("sessionModelSelect")?.addEventListener("change", (e) => {
    updateSessionConfig({ model: e.target.value });
  });

  document.getElementById("sessionEffortSelect")?.addEventListener("change", (e) => {
    updateSessionConfig({ reasoningEffort: e.target.value });
  });

  document.getElementById("sessionContextTierSelect")?.addEventListener("change", (e) => {
    updateSessionConfig({ contextTier: e.target.value });
  });

  document.getElementById("abortSessionBtn")?.addEventListener("click", async () => {
    if (!state.activeSessionId) return;
    await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/abort`, {
      method: "POST",
    });
    scheduleActiveSessionRefresh(300);
  });

  // File / Camera attachment input
  document.getElementById("fileUploadInput")?.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        state.stagedAttachments.push({
          name: file.name,
          dataBase64: String(reader.result),
        });
        renderStagedAttachments();
      };
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  });

  // Send Prompt to Desktop Session
  const sendPrompt = async () => {
    const input = document.getElementById("promptInput");
    const rawPrompt = (input?.value || "").trim();
    if ((!rawPrompt && state.stagedAttachments.length === 0) || !state.activeSessionId) return;
    const prompt = rawPrompt || "Attached file";

    const deliveryMode = document.getElementById("deliveryModeSelect")?.value || "immediate";
    const mode = document.getElementById("sessionModeSelect")?.value || undefined;
    const attachments = [...state.stagedAttachments];

    input.value = "";
    state.stagedAttachments = [];
    renderStagedAttachments();

    // Optimistically display the queued steering message immediately in the chat stream!
    const optimisticItem = {
      id: `local-${Date.now()}`,
      prompt,
      deliveryMode,
      attachments,
      createdAt: new Date().toISOString(),
    };
    state.pendingSteering.push(optimisticItem);
    renderTurns(true);

    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/message`, {
        method: "POST",
        body: { prompt, deliveryMode, mode, attachments },
      });
      scheduleActiveSessionRefresh(300);
    } catch (err) {
      state.pendingSteering = state.pendingSteering.filter((x) => x.id !== optimisticItem.id);
      renderTurns(false);
      alert(`Failed to send prompt: ${err.message}`);
    }
  };

  document.getElementById("sendPromptBtn")?.addEventListener("click", sendPrompt);
  document.getElementById("promptInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // Image Lightbox & Annotation Modal actions
  document.getElementById("closeImageModalBtn")?.addEventListener("click", () => {
    closeModalWithHistory("imageModal");
  });
  document.getElementById("toggleDrawModeBtn")?.addEventListener("click", () => {
    state.imageMode = state.imageMode === "draw" ? "view" : "draw";
    updateImageModeUi();
  });
  document.getElementById("zoomFitBtn")?.addEventListener("click", () => {
    state.imgZoom = 1.0;
    state.imgPanX = 0;
    state.imgPanY = 0;
    fitImageCanvasToViewport();
    applyImageTransform();
  });
  document.getElementById("zoomFillWidthBtn")?.addEventListener("click", () => {
    fitImageCanvasToViewport();
    setZoomAroundFocalPoint(state.imgFillWidthZoom || 1.5, 0, 0, false);
  });
  document.getElementById("zoom2xBtn")?.addEventListener("click", () => {
    setZoomAroundFocalPoint(2.0, 0, 0, false);
  });
  document.getElementById("resetImageZoomBtn")?.addEventListener("click", () => {
    state.imgZoom = 1.0;
    state.imgPanX = 0;
    state.imgPanY = 0;
    fitImageCanvasToViewport();
    applyImageTransform();
  });
  document.getElementById("undoMarkupBtn")?.addEventListener("click", () => {
    if (state.strokes.length > 0) {
      state.strokes.pop();
      updateImageModeUi();
      redrawAnnotationCanvas();
    }
  });
  document.getElementById("clearMarkupBtn")?.addEventListener("click", () => {
    state.strokes = [];
    state.currentStroke = null;
    updateImageModeUi();
    redrawAnnotationCanvas();
  });

  const getAnnotatedDataUrl = () => {
    const canvas = document.getElementById("annotationCanvas");
    return canvas ? canvas.toDataURL("image/png") : "";
  };

  document.getElementById("queueImageReviewBtn")?.addEventListener("click", async () => {
    if (!state.activeSessionId || !state.currentImageArtifact) return;
    const comment =
      document.getElementById("imageCommentInput")?.value?.trim() ||
      `Review markup on ${state.currentImageArtifact.name}`;
    const annotatedImageBase64 = state.strokes.length > 0 ? getAnnotatedDataUrl() : undefined;
    await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/reviews`, {
      method: "POST",
      body: {
        targetType: "artifact",
        targetPath: state.currentImageArtifact.name,
        comment,
        annotatedImageBase64,
      },
    });
    document.getElementById("imageModal")?.classList.remove("open");
    await loadSessionDetail(state.activeSessionId, false);
  });

  document.getElementById("sendImageNowBtn")?.addEventListener("click", async () => {
    if (!state.activeSessionId || !state.currentImageArtifact) return;
    const comment =
      document.getElementById("imageCommentInput")?.value?.trim() ||
      `Please inspect this annotated view of ${state.currentImageArtifact.name}`;
    const dataUrl = getAnnotatedDataUrl();
    await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/message`, {
      method: "POST",
      body: {
        prompt: comment,
        deliveryMode: "immediate",
        attachments: [
          {
            name: `annotated-${state.currentImageArtifact.name.replace(/\.[^.]+$/, "")}.png`,
            dataBase64: dataUrl,
          },
        ],
      },
    });
    document.getElementById("imageModal")?.classList.remove("open");
    scheduleActiveSessionRefresh(250);
  });

  // STL Viewer Modal actions
  document.getElementById("closeStlModalBtn")?.addEventListener("click", () => {
    closeModalWithHistory("stlModal");
  });
  document.getElementById("stlResetCamBtn")?.addEventListener("click", () => {
    state.stlRotationX = -0.65;
    state.stlRotationZ = 0.6;
    state.stlZoom = 1.0;
    state.stlPanX = 0;
    state.stlPanY = 0;
    renderStlCanvas();
  });
  document.getElementById("stlWireframeBtn")?.addEventListener("click", () => {
    state.stlWireframe = !state.stlWireframe;
    renderStlCanvas();
  });
  document.getElementById("stlSnapshotAnnotateBtn")?.addEventListener("click", () => {
    const stlCanvas = document.getElementById("stlCanvas");
    if (!stlCanvas || !state.currentStlArtifact) return;
    const snapUrl = stlCanvas.toDataURL("image/png");
    document.getElementById("stlModal")?.classList.remove("open");
    openImageAnnotationModal(
      {
        ...state.currentStlArtifact,
        name: `${state.currentStlArtifact.name}-3d-view.png`,
      },
      snapUrl
    );
  });

  // Doc Viewer Modal actions
  document.getElementById("closeDocModalBtn")?.addEventListener("click", () => {
    closeModalWithHistory("docModal");
  });
  document.getElementById("commentOnDocBtn")?.addEventListener("click", async () => {
    if (!state.activeSessionId || !state.currentDocArtifact) return;
    const note = window.prompt(`Add review comment on ${state.currentDocArtifact.name}:`);
    if (!note || !note.trim()) return;
    await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/reviews`, {
      method: "POST",
      body: {
        targetType: "artifact",
        targetPath: state.currentDocArtifact.relativePath || state.currentDocArtifact.name,
        comment: note.trim(),
      },
    });
    document.getElementById("docModal")?.classList.remove("open");
    await loadSessionDetail(state.activeSessionId, false);
  });

  // Review Queue actions
  document.getElementById("addGeneralReviewBtn")?.addEventListener("click", async () => {
    if (!state.activeSessionId) return;
    const note = window.prompt("Add a review note to the feedback batch:");
    if (!note || !note.trim()) return;
    await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/reviews`, {
      method: "POST",
      body: { targetType: "general", comment: note.trim() },
    });
    await loadSessionDetail(state.activeSessionId, false);
  });

  document.getElementById("dispatchReviewsBtn")?.addEventListener("click", async () => {
    if (!state.activeSessionId) return;
    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(state.activeSessionId)}/reviews/dispatch`,
        {
          method: "POST",
          body: { deliveryMode: "immediate" },
        }
      );
      await loadSessionDetail(state.activeSessionId, false);
      // Switch to stream tab to watch the agent respond
      document.querySelector('.view-tab[data-tab="stream"]')?.click();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("refreshDiffBtn")?.addEventListener("click", () => {
    if (state.activeSessionId) loadSessionDiff(state.activeSessionId);
  });
}

function renderStagedAttachments() {
  const wrap = document.getElementById("stagedAttachments");
  if (!wrap) return;
  if (state.stagedAttachments.length === 0) {
    wrap.style.display = "none";
    wrap.innerHTML = "";
    return;
  }
  wrap.style.display = "flex";
  wrap.innerHTML = state.stagedAttachments
    .map(
      (a, idx) => `
      <span class="staged-item">
        📎 ${escapeHtml(a.name)}
        <button class="btn btn-sm" data-remove-idx="${idx}" style="padding: 0 4px;">✕</button>
      </span>
    `
    )
    .join("");

  wrap.querySelectorAll("[data-remove-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-remove-idx"));
      state.stagedAttachments.splice(idx, 1);
      renderStagedAttachments();
    });
  });
}

// --- Bootstrap ---
async function init() {
  await initTokenFromUrl();
  const protoBadge = document.getElementById("protoBadge");
  if (protoBadge && window.location.protocol === "https:") {
    protoBadge.style.display = "inline-block";
  }
  const nativeHubBtn = document.getElementById("nativeHubBtn");
  const openNativeEndpointHubBtn = document.getElementById("openNativeEndpointHubBtn");
  if (window.AndroidNative && typeof window.AndroidNative.openConnectionSettings === "function") {
    if (nativeHubBtn) {
      nativeHubBtn.style.display = "inline-flex";
      nativeHubBtn.addEventListener("click", () => {
        openQrModal();
      });
    }
    if (openNativeEndpointHubBtn) {
      openNativeEndpointHubBtn.style.display = "inline-flex";
      openNativeEndpointHubBtn.addEventListener("click", () => {
        window.AndroidNative.openConnectionSettings();
      });
    }
  }
  setupEventListeners();
  syncArrangeSelects();
  setupAnnotationCanvasEvents();
  setupStlCanvasEvents();

  // Frame-1 0ms Hydration from localStorage cache before network completes!
  try {
    const persistedSessions = JSON.parse(localStorage.getItem("ra_persisted_sessions_v1") || "null");
    if (Array.isArray(persistedSessions) && persistedSessions.length > 0) {
      state.sessions = persistedSessions;
      renderSessionsList();
    }
    const persistedDetail = JSON.parse(localStorage.getItem("ra_persisted_active_detail_v1") || "null");
    if (persistedDetail && persistedDetail.session?.id) {
      state.activeSessionId = persistedDetail.session.id;
      state.sessionCache.set(persistedDetail.session.id, persistedDetail);
      applySessionPayload(persistedDetail, true);
    }
  } catch {}

  // Check authentication status first before starting WebSocket or background polling
  // so unauthenticated new PCs open the MFA / Phone Approval modal once without resetting the input!
  try {
    const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
    const healthRes = await fetch("/api/health", { headers });
    if (healthRes.ok) {
      const health = await healthRes.json();
      if (!health.authenticated) {
        await openQrModal();
        return;
      }
    }
  } catch {}

  connectWebSocket();
  await Promise.all([loadHostStatus(), loadSessionsList(true)]);
  if (state.activeSessionId) {
    loadSessionDetail(state.activeSessionId, true);
  }
}

init();
