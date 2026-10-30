import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeliveryMode, SessionMode } from "./types.js";

const RUN_DIR = path.join(os.homedir(), ".copilot", "run");
// `session.model_change` sources that mean someone chose a model in the desktop app itself.
const EXTERNAL_MODEL_SOURCES = new Set(["model_picker", "model_command", "settings_command", "config_command"]);

export interface DesktopConnectionInfo {
  port: number;
  pid: number | null;
  token: string;
}

export class DesktopAppBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private currentPort: number | null = null;
  private currentPid: number | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
      /** For requests answered in several messages: true once `msg` is the final answer. */
      isFinal?: (msg: Record<string, unknown>) => boolean;
    }
  >();
  private liveWorkspaces = new Map<string, Record<string, unknown>>();
  private sessionAutoTiers = new Map<string, string>();
  /** Changes the app queued because the session was mid-turn; cleared when the runtime applies one. */
  private queuedSelections = new Map<
    string,
    { model: string; reasoningEffort?: string; contextTier?: string; autoTier?: string }
  >();
  /** Whether each session is mid-turn, from its own root turn events (absent until one is seen). */
  private busySessions = new Map<string, boolean>();
  /** The last model this bridge asked each session to switch to, to tell the app's echoes apart. */
  private lastSentModels = new Map<string, { model: string; at: number }>();
  private streamingBuffers = new Map<
    string,
    { content: string; reasoning: string; updatedAt: number }
  >();

  start(): void {
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error("Bridge stopped"));
    }
    this.pendingRequests.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPort(): number | null {
    return this.currentPort;
  }

  getPid(): number | null {
    return this.currentPid;
  }

  getLiveWorkspaces(): Map<string, Record<string, unknown>> {
    return this.liveWorkspaces;
  }

  getStreamingState(sessionId: string): { content: string; reasoning: string } | null {
    const entry = this.streamingBuffers.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > 120_000) {
      this.streamingBuffers.delete(sessionId);
      return null;
    }
    return { content: entry.content, reasoning: entry.reasoning };
  }

  private readConnectionInfo(): DesktopConnectionInfo | null {
    try {
      const portFile = path.join(RUN_DIR, "ws.port");
      const tokenFile = path.join(RUN_DIR, "ws.token");
      if (!fs.existsSync(portFile) || !fs.existsSync(tokenFile)) {
        return null;
      }
      const portLines = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      const port = Number(portLines[0]);
      const pid = portLines[1] ? Number(portLines[1]) : null;
      const token = fs.readFileSync(tokenFile, "utf8").trim().split(/\r?\n/)[0];
      if (!port || !token) return null;
      return { port, pid, token };
    } catch {
      return null;
    }
  }

  private scheduleReconnect(delayMs = 3000): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private connect(): void {
    if (this.stopping) return;
    const info = this.readConnectionInfo();
    if (!info) {
      this.connected = false;
      this.currentPort = null;
      this.currentPid = null;
      this.scheduleReconnect(4000);
      return;
    }

    this.currentPort = info.port;
    this.currentPid = info.pid;

    try {
      const url = `ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.emit("status", { connected: true, port: info.port, pid: info.pid });
        // Request initial workspace & chat inventory
        this.sendRaw({ type: "list_workspaces", request_id: crypto.randomUUID() });
        this.sendRaw({ type: "list_general_chat_sessions", request_id: crypto.randomUUID() });
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          this.handleServerMessage(data);
        } catch {
          // Ignore non-JSON frame
        }
      };

      ws.onerror = () => {
        // Handled in onclose
      };

      ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        this.emit("status", { connected: false, port: null, pid: null });
        // None of these can be observed while disconnected, and a restarted app starts over.
        this.queuedSelections.clear();
        this.sessionAutoTiers.clear();
        this.busySessions.clear();
        this.scheduleReconnect(3000);
      };
    } catch {
      this.connected = false;
      this.scheduleReconnect(4000);
    }
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type || "");
    const reqId = typeof msg.request_id === "string" ? msg.request_id : undefined;
    const isOwnReply = reqId !== undefined && this.pendingRequests.has(reqId);

    if (reqId && this.pendingRequests.has(reqId)) {
      const pending = this.pendingRequests.get(reqId)!;
      if (type === "error" || !pending.isFinal || pending.isFinal(msg)) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(reqId);
        if (type === "error") {
          pending.reject(new Error(String(msg.message || "Desktop WebSocket error")));
        } else {
          pending.resolve(msg);
        }
      }
    }

    // The app pushes its catalogs when they change (and in reply to its own UI's requests).
    if (!isOwnReply && (type === "models_list" || type === "session_models_list") && Array.isArray(msg.models)) {
      this.emit("catalog_changed", msg);
    }

    if (type === "workspace_list" && Array.isArray(msg.workspaces)) {
      for (const ws of msg.workspaces as Array<Record<string, unknown>>) {
        const id = String(ws.activeSessionId || ws.id || "");
        if (id) {
          this.liveWorkspaces.set(id, ws);
        }
      }
      this.emit("workspaces_updated", msg.workspaces);
    } else if (type === "session_event") {
      const sessionId = String(msg.session_id || "");
      const ev = (msg.event as Record<string, unknown>) || {};
      const evType = String(ev.type || "");
      const evData = (ev.data as Record<string, unknown>) || {};

      if (sessionId) {
        if (!ev.agentId) {
          // Root turn events (sub-agents carry an agentId) say whether the session is mid-turn.
          if (evType === "assistant.turn_start" || evType === "user.message") this.busySessions.set(sessionId, true);
          else if (evType === "session.idle") this.busySessions.set(sessionId, false);
        }
        if (evType === "assistant.message_delta") {
          const delta = String(evData.deltaContent || "");
          const buf = this.streamingBuffers.get(sessionId) || {
            content: "",
            reasoning: "",
            updatedAt: Date.now(),
          };
          buf.content += delta;
          buf.updatedAt = Date.now();
          this.streamingBuffers.set(sessionId, buf);
        } else if (evType === "assistant.reasoning_delta") {
          const delta = String(evData.deltaContent || evData.delta || "");
          const buf = this.streamingBuffers.get(sessionId) || {
            content: "",
            reasoning: "",
            updatedAt: Date.now(),
          };
          buf.reasoning += delta;
          buf.updatedAt = Date.now();
          this.streamingBuffers.set(sessionId, buf);
        } else if (
          evType === "assistant.message" ||
          evType === "assistant.turn_end" ||
          evType === "user.message"
        ) {
          this.streamingBuffers.delete(sessionId);
        } else if (evType === "session.model_change" && !ev.agentId) {
          // Sub-agent switches (with an agentId) don't change the session's own model.
          const queued = this.queuedSelections.get(sessionId);
          this.queuedSelections.delete(sessionId);
          const newModel = typeof evData.newModel === "string" ? evData.newModel : "";
          // Fusion levels are recorded as autoTierIdCompat. The event may carry neither, so fall back
          // to a change queued from here.
          const recorded = evData.autoTier ?? evData.autoTierIdCompat;
          const tier =
            typeof recorded === "string" && recorded
              ? recorded
              : queued?.model === "auto"
                ? queued.autoTier
                : undefined;
          if (newModel === "auto" && tier) {
            this.sessionAutoTiers.set(sessionId, tier);
          } else if (newModel && newModel !== "auto") {
            this.sessionAutoTiers.delete(sessionId);
          }
          // A choice made in the desktop app replaces any choice still waiting here.
          if (typeof evData.source === "string" && EXTERNAL_MODEL_SOURCES.has(evData.source)) {
            this.emit("external_model_change", { sessionId });
          }
        } else if (evType === "session.idle" && !ev.agentId) {
          // Queued changes apply as the turn ends. Changing only the Auto level emits no model_change
          // event, so treat whatever is still queued as applied once the session is idle.
          const queued = this.queuedSelections.get(sessionId);
          this.queuedSelections.delete(sessionId);
          if (queued?.model === "auto" && queued.autoTier) this.sessionAutoTiers.set(sessionId, queued.autoTier);
        }
      }

      this.emit("session_event", {
        sessionId,
        event: ev,
      });
    } else if (type === "session_model_result" && !isOwnReply && typeof msg.session_id === "string") {
      // Pushed when a session's selection is restored (on resume, with a history_request_id) or changed
      // by another client.
      const model = typeof msg.model === "string" ? msg.model : "";
      const tier = typeof msg.auto_tier === "string" ? msg.auto_tier : "";
      if (model === "auto" && tier) this.sessionAutoTiers.set(msg.session_id, tier);
      else if (model && model !== "auto") this.sessionAutoTiers.delete(msg.session_id);
      if (!msg.history_request_id && model && !this.isEchoOfOwnSwitch(msg.session_id, model)) {
        this.emit("external_model_change", { sessionId: msg.session_id });
      }
    } else if (type === "session_model_queued" && !isOwnReply && typeof msg.session_id === "string") {
      // Another client (e.g. the desktop picker) queued a change for the end of the current turn. The app
      // may also echo our own queued changes this way, so keep fields the echo leaves out.
      if (typeof msg.model === "string" && msg.model) {
        const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
        const known = this.queuedSelections.get(msg.session_id);
        const same = known?.model === msg.model ? known : undefined;
        this.queuedSelections.set(msg.session_id, {
          model: msg.model,
          reasoningEffort: text(msg.reasoning_effort) ?? same?.reasoningEffort,
          contextTier: text(msg.context_tier) ?? same?.contextTier,
          autoTier: text(msg.auto_tier) ?? same?.autoTier,
        });
        if (!this.isEchoOfOwnSwitch(msg.session_id, msg.model)) {
          this.emit("external_model_change", { sessionId: msg.session_id });
        }
      }
    } else if (
      type === "user_input_request" ||
      type === "exit_plan_mode_request" ||
      type === "session_mode_changed" ||
      type === "session_title_updated" ||
      type === "artifacts_changed"
    ) {
      this.emit("desktop_notification", msg);
    }
  }

  sendRaw(payload: Record<string, unknown>): boolean {
    if (!this.ws || !this.connected) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  async request(
    payload: Record<string, unknown>,
    timeoutMs = 6000,
    isFinal?: (msg: Record<string, unknown>) => boolean
  ): Promise<Record<string, unknown>> {
    if (!this.ws || !this.connected) {
      throw new Error("Desktop GitHub Copilot app WebSocket is not connected");
    }
    const requestId = String(payload.request_id || crypto.randomUUID());
    const fullPayload = { ...payload, request_id: requestId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timed out waiting for Desktop response to ${String(payload.type)}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer, isFinal });
      const sent = this.sendRaw(fullPayload);
      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new Error("Failed to send message over Desktop WebSocket"));
      }
    });
  }

  async sendMessage(params: {
    sessionId: string;
    prompt: string;
    displayPrompt?: string;
    deliveryMode?: DeliveryMode;
    mode?: SessionMode;
    attachmentPaths?: string[];
  }): Promise<{ ok: boolean; method: "desktop-ws" }> {
    if (!this.connected) {
      throw new Error("Desktop App WebSocket is not connected");
    }

    if (params.mode) {
      this.sendRaw({
        type: "set_session_mode",
        session_id: params.sessionId,
        mode: params.mode,
      });
    }

    const attachments = (params.attachmentPaths || []).map((p) => ({
      type: "file",
      path: p,
    }));

    const payload: Record<string, unknown> = {
      type: "send_message",
      session_id: params.sessionId,
      prompt: params.prompt,
      display_prompt: params.displayPrompt || params.prompt,
      delivery_mode: params.deliveryMode || "immediate",
    };

    if (attachments.length > 0) {
      payload.attachments = attachments;
    }

    const ok = this.sendRaw(payload);
    if (!ok) {
      throw new Error("Failed to dispatch send_message to Desktop App");
    }
    return { ok: true, method: "desktop-ws" };
  }

  respondToUserInput(params: {
    sessionId: string;
    requestId: string;
    answer: string;
    wasFreeform?: boolean;
  }): boolean {
    return this.sendRaw({
      type: "respond_to_user_input",
      session_id: params.sessionId,
      request_id: params.requestId,
      answer: params.answer,
      was_freeform: Boolean(params.wasFreeform),
    });
  }

  respondToPlanApproval(params: {
    sessionId: string;
    requestId: string;
    approved: boolean;
    feedback?: string;
    selectedAction?: string;
  }): boolean {
    return this.sendRaw({
      type: "respond_to_exit_plan_mode",
      session_id: params.sessionId,
      request_id: params.requestId,
      approved: params.approved,
      feedback: params.feedback || undefined,
      selected_action: params.selectedAction || "autopilot",
    });
  }

  respondToPermission(params: {
    sessionId: string;
    requestId: string;
    approved: boolean;
  }): boolean {
    return this.sendRaw({
      type: "respond_to_permission",
      session_id: params.sessionId,
      request_id: params.requestId,
      result: params.approved ? "approved" : "denied",
    });
  }

  setSessionMode(sessionId: string, mode: SessionMode): boolean {
    return this.sendRaw({
      type: "set_session_mode",
      session_id: sessionId,
      mode,
    });
  }

  /** The desktop app's live model catalog: `{ type: "models_list", models, auto_tiers }`. */
  async listModels(): Promise<Record<string, unknown>> {
    const reply = await this.request({ type: "list_models" }, 10_000);
    if (reply.type !== "models_list") {
      throw new Error(`Unexpected reply to list_models: ${String(reply.type)}`);
    }
    return reply;
  }

  /**
   * One session's own model list: `{ type: "session_models_list", models, auto_tiers? }`. Sessions can run
   * under different accounts, so this decides which models and Auto levels the session accepts.
   * `auto_tiers` is absent for sessions without Auto levels. Errors while the session isn't loaded.
   */
  async listSessionModels(sessionId: string): Promise<Record<string, unknown>> {
    const reply = await this.request({ type: "list_session_models", session_id: sessionId }, 10_000);
    if (reply.type !== "session_models_list") {
      throw new Error(`Unexpected reply to list_session_models: ${String(reply.type)}`);
    }
    return reply;
  }

  /**
   * Loads a session's runtime the way opening it in the desktop app does. Resolves on `session_resumed`;
   * the history the app streams for the same request afterwards is ignored.
   */
  async resumeSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request({ type: "resume_session", session_id: sessionId }, 20_000, (m) => m.type === "session_resumed");
  }

  /** Whether the session is mid-turn, by its own turn events; undefined until one has been seen. */
  isSessionBusy(sessionId: string): boolean | undefined {
    return this.busySessions.get(sessionId);
  }

  /** True when a pushed model change is the app echoing a switch this bridge just sent. */
  private isEchoOfOwnSwitch(sessionId: string, model: string): boolean {
    const sent = this.lastSentModels.get(sessionId);
    return Boolean(sent && sent.model === model && Date.now() - sent.at < 15_000);
  }

  /**
   * Switches a session's model through the desktop app and waits for its verdict. Resolves with the
   * selection the app applied, or with `queued` when the session is mid-turn and the app will apply it
   * once the turn ends. Rejects with the app's reason when it refuses the change.
   */
  async setSessionModel(
    sessionId: string,
    selection: { model: string; reasoningEffort?: string; contextTier?: string; autoTier?: string }
  ): Promise<{
    model: string;
    reasoningEffort?: string;
    contextTier?: string;
    autoTier?: string;
    queued: boolean;
    notice?: string;
  }> {
    const payload: Record<string, unknown> = {
      type: "set_session_model",
      session_id: sessionId,
      model: selection.model,
    };
    if (selection.reasoningEffort) payload.reasoning_effort = selection.reasoningEffort;
    if (selection.contextTier) payload.context_tier = selection.contextTier;
    if (selection.autoTier) payload.auto_tier = selection.autoTier;
    const finalTypes = ["session_model_result", "session_model_queued", "session_model_change_rejected", "session_auto_tier_dropped"];
    this.lastSentModels.set(sessionId, { model: selection.model, at: Date.now() });
    const reply = await this.request(payload, 15_000, (m) => finalTypes.includes(String(m.type)));
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    if (reply.type === "session_model_change_rejected") {
      throw new Error(text(reply.warning) ?? text(reply.message) ?? "The desktop app rejected the model change.");
    }
    const applied = {
      model: text(reply.model) ?? selection.model,
      reasoningEffort: text(reply.reasoning_effort) ?? text(reply.reasoningEffort),
      contextTier: text(reply.context_tier) ?? text(reply.contextTier),
      autoTier: text(reply.auto_tier) ?? text(reply.autoTier) ?? selection.autoTier,
      queued: reply.type === "session_model_queued",
      notice: undefined as string | undefined,
    };
    if (reply.type === "session_auto_tier_dropped") {
      const effective = text(reply.effective_auto_tier);
      applied.autoTier = effective;
      applied.notice = `The ${text(reply.requested_auto_tier) ?? "requested"} Auto level isn't available for this session; using ${effective ?? "the default"}.`;
    }
    if (applied.queued) {
      this.queuedSelections.set(sessionId, {
        model: applied.model,
        reasoningEffort: applied.reasoningEffort,
        contextTier: applied.contextTier ?? selection.contextTier,
        autoTier: applied.autoTier,
      });
    } else {
      this.queuedSelections.delete(sessionId);
      if (applied.model === "auto" && applied.autoTier) this.sessionAutoTiers.set(sessionId, applied.autoTier);
    }
    return applied;
  }

  /** A model change the app is holding until the session's current turn ends, if any. */
  getQueuedSelection(
    sessionId: string
  ): { model: string; reasoningEffort?: string; contextTier?: string; autoTier?: string } | undefined {
    return this.queuedSelections.get(sessionId);
  }

  /** Last Auto tier seen for a session (from model switches made here or reported by the app). */
  getSessionAutoTier(sessionId: string): string | undefined {
    return this.sessionAutoTiers.get(sessionId);
  }

  abortSession(sessionId: string): boolean {
    return this.sendRaw({
      type: "abort_session",
      session_id: sessionId,
    });
  }

  saveInlineReviewComment(params: {
    workspaceId: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    text: string;
  }): boolean {
    return this.sendRaw({
      type: "save_inline_review_comment",
      workspace_id: params.workspaceId,
      comment: {
        id: crypto.randomUUID(),
        workspace_id: params.workspaceId,
        file_path: params.filePath,
        range_start: params.lineStart,
        range_end: params.lineEnd,
        line_start: params.lineStart,
        line_end: params.lineEnd,
        text: params.text,
        created_at: new Date().toISOString(),
        status: "open",
        is_agent_comment: false,
      },
    });
  }
}
