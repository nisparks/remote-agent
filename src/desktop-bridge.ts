import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeliveryMode, SessionMode } from "./types.js";

const RUN_DIR = path.join(os.homedir(), ".copilot", "run");

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
    }
  >();
  private liveWorkspaces = new Map<string, Record<string, unknown>>();
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

    if (reqId && this.pendingRequests.has(reqId)) {
      const pending = this.pendingRequests.get(reqId)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(reqId);
      if (type === "error") {
        pending.reject(new Error(String(msg.message || "Desktop WebSocket error")));
      } else {
        pending.resolve(msg);
      }
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
        }
      }

      this.emit("session_event", {
        sessionId,
        event: ev,
      });
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
    timeoutMs = 6000
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

      this.pendingRequests.set(requestId, { resolve, reject, timer });
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

  setSessionModel(
    sessionId: string,
    model: string,
    reasoningEffort?: string,
    contextTier?: string
  ): boolean {
    const payload: Record<string, unknown> = {
      type: "set_session_model",
      session_id: sessionId,
      model,
    };
    if (reasoningEffort) {
      payload.reasoning_effort = reasoningEffort;
      payload.reasoningEffort = reasoningEffort;
    }
    if (contextTier) {
      payload.context_tier = contextTier;
      payload.contextTier = contextTier;
    }
    return this.sendRaw(payload);
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
