export type SessionMode = "interactive" | "plan" | "autopilot";
export type DeliveryMode = "immediate" | "enqueue";

export type ArtifactCategory = "image" | "3d" | "document" | "data" | "code" | "other";

export interface ArtifactItem {
  id: string;
  name: string;
  relativePath: string;
  fullPath: string;
  category: ArtifactCategory;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  source: "session-files" | "checkpoint" | "referenced" | "workspace";
  url: string;
}

export interface PendingUserInput {
  requestId: string;
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  timestamp: string;
}

export interface PendingPlanApproval {
  requestId: string;
  summary?: string;
  planContent?: string;
  recommendedAction?: string;
  timestamp: string;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  serverName?: string;
  arguments?: unknown;
  timestamp: string;
}

export interface SubAgentItem {
  id: string;
  agentId?: string;
  toolCallId: string;
  name: string;
  agentType: string;
  displayName: string;
  description: string;
  mode: "sync" | "background";
  status: "running" | "completed" | "failed";
  model?: string;
  totalToolCalls?: number;
  totalTokens?: number;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
  promptPreview?: string;
  resultPreview?: string;
  turns?: ConversationTurn[];
}

export interface DetachedShellItem {
  shellId: string;
  pid: number | null;
  state: "active" | "stopped";
  logPath?: string;
  logPreview?: string;
  startedAt?: string;
}

export interface UiPreferences {
  pinnedSessionIds: string[];
  sessionOrderIds: string[];
  groupBy: "project" | "flat" | "status";
  sortBy: "custom" | "recent" | "title";
}

export interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  toolTitle?: string;
  intentionSummary?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  arguments?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  resultPreview?: string;
  startedAt: string;
  completedAt?: string;
  artifacts: ArtifactItem[];
  subAgent?: SubAgentItem;
}

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  rawContent?: string;
  reasoningText?: string;
  model?: string;
  timestamp: string;
  turnId?: string;
  parentToolCallId?: string;
  isStreaming?: boolean;
  toolCalls: ToolCallItem[];
  artifacts: ArtifactItem[];
}

export interface SessionTodoItem {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  dependsOn: string[];
}

export interface GitHubAccountInfo {
  id: string;
  login: string;
  name?: string;
  host: string;
  isDefault: boolean;
}

export interface PeerDesktopHost {
  id: string;
  name: string;
  lanUrl: string;
  wanUrl?: string;
  token?: string;
  accountLogin?: string;
  addedAt: string;
}

export interface RemoteSessionSummary {
  id: string;
  workspaceId?: string;
  title: string;
  sessionType: "project" | "general_chat" | "cli";
  isRunning: boolean;
  activityStatus: "busy" | "idle";
  mode: SessionMode;
  model: string;
  /** True when no model is recorded for the session, so `model` is only a placeholder. */
  modelUnset?: boolean;
  reasoningEffort?: string;
  contextTier?: string;
  /** Auto routing tier, when the session uses the Auto model and its tier is known. */
  autoTier?: string;
  /** A model change waiting for the session's current turn to end. */
  pendingModel?: { model: string; reasoningEffort?: string; contextTier?: string; autoTier?: string };
  projectId?: string;
  projectName?: string;
  repository?: string;
  branch?: string;
  originBranch?: string;
  cwd?: string;
  parentSessionId?: string;
  accountLogin?: string;
  hostName?: string;
  createdAt: string;
  updatedAt: string;
  wasInterrupted?: boolean;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  tokenUsage?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalReasoningTokens: number;
    aiuUsed?: number;
  };
  contextWindow?: {
    currentTokens: number;
    tokenLimit: number;
  };
  awaitingUserInput?: PendingUserInput | null;
  awaitingPlanApproval?: PendingPlanApproval | null;
  awaitingPermission?: PendingPermissionRequest | null;
  counts: {
    turns: number;
    artifacts: number;
    images: number;
    models3d: number;
    todos: number;
    todosDone: number;
    subAgents?: number;
    runningSubAgents?: number;
  };
}

export interface WorkspaceDiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  insertions: number;
  deletions: number;
  patch?: string;
}

export interface WorkspaceDiffSummary {
  baseBranch: string;
  branch: string;
  isClean: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: WorkspaceDiffFile[];
}

export interface MobileReviewComment {
  id: string;
  sessionId: string;
  targetType: "artifact" | "diff" | "general";
  targetPath?: string;
  lineStart?: number;
  lineEnd?: number;
  comment: string;
  annotatedImageUrl?: string;
  annotatedImageLocalPath?: string;
  createdAt: string;
  status: "queued" | "sent";
}

export interface McpServerSummary {
  name: string;
  type: "stdio" | "http" | "builtin";
  tools: string[];
  enabled: boolean;
  source: string;
}

export interface CopilotQuotaStatus {
  plan: string;
  sku?: string;
  resetDate?: string;
  premium: {
    entitlement: number;
    used: number;
    remaining: number;
    percentUsed: number;
    percentRemaining: number;
    overagePermitted: boolean;
    overageCount: number;
    unlimited: boolean;
  };
  chatUnlimited: boolean;
  completionsUnlimited: boolean;
  updatedAt: string;
}

export interface DesktopHostStatus {
  hostId: string;
  hostname: string;
  platform: string;
  desktopAppConnected: boolean;
  desktopAppPort: number | null;
  desktopAppPid: number | null;
  sdkAvailable: boolean;
  sdkVersion: string | null;
  copilotCliVersion: string | null;
  accounts: GitHubAccountInfo[];
  primaryAccount: string | null;
  quota?: CopilotQuotaStatus | null;
  availableModels?: Array<{ id: string; name: string }>;
  peerHosts: PeerDesktopHost[];
  mcpServers: McpServerSummary[];
  lanUrls: string[];
  tailscaleUrls: string[];
  wan: {
    enabled: boolean;
    status: string;
    provider: string;
    publicUrl: string | null;
    customWanUrl?: string | null;
    error: string | null;
  };
  apkAvailable: boolean;
  apkDownloadUrl: string;
  desktopSetupAvailable: boolean;
  activeSessionsCount: number;
  totalSessionsCount: number;
  uiVersion?: string;
  uiPrefs?: UiPreferences;
}
