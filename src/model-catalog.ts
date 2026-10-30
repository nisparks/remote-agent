// The model catalog comes from the desktop Copilot app (`list_models`), normalized for the mobile picker,
// plus the rules that turn a requested change into a selection the app accepts for a session.

export interface CatalogModel {
  id: string;
  name: string;
  vendor?: string;
  /** Picker grouping published by the service: "powerful", "versatile", or "lightweight". */
  category?: string;
  /** Relative cost published for pickers: "low", "medium", "high", or "very_high". */
  priceCategory?: string;
  /** False when policy disables the model for this account. */
  enabled: boolean;
  /** Supported reasoning efforts, weakest first. Empty when the model has no effort setting. */
  efforts: string[];
  defaultEffort?: string;
  /** Standard context window in tokens. */
  contextWindow?: number;
  /** Window of the `long_context` tier, when the model offers one. */
  longContextWindow?: number;
  discountPercent?: number;
}

export interface CatalogAutoTier {
  id: string;
  name: string;
  description: string;
  /** Execution kind: "auto", or "fusion" for Copilot Fusion tiers. */
  kind: string;
  enabled: boolean;
  /** False for tiers the service hides from pickers; they stay valid when already selected. */
  visible: boolean;
  promo?: { discountPercent?: number; message?: string; startsAt?: string; endsAt?: string };
}

export interface ModelCatalog {
  models: CatalogModel[];
  /** Auto levels (tiers) offered. Empty when only plain Auto is available. */
  autoTiers: CatalogAutoTier[];
  defaultAutoTier: string;
  source: "desktop" | "cache" | "app-state" | "fallback";
  fetchedAt: string;
  /** Set when the catalog was narrowed to one session's own model list. */
  sessionId?: string;
  /**
   * True when `autoTiers` are the account's, shown because the session isn't loaded and can't list its
   * own. They must be confirmed by the session before one is sent.
   */
  autoTiersUnverified?: boolean;
}

export interface ModelSelection {
  model?: string;
  reasoningEffort?: string;
  contextTier?: string;
  autoTier?: string;
}

export type ResolvedSelection =
  | { ok: true; selection: Required<Pick<ModelSelection, "model">> & ModelSelection; adjustments: string[] }
  | { ok: false; error: string };

export const AUTO_MODEL_ID = "auto";
export const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function sortEfforts(efforts: string[]): string[] {
  const known = efforts.filter((e) => EFFORT_ORDER.includes(e));
  const unknown = efforts.filter((e) => !EFFORT_ORDER.includes(e));
  return [...new Set([...known.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)), ...unknown])];
}

export function normalizeModel(raw: unknown): CatalogModel | null {
  const m = obj(raw);
  const id = str(m.id);
  if (!id) return null;
  const capabilities = obj(m.capabilities);
  const limits = obj(capabilities.limits);
  const billing = obj(m.billing);
  const prices = obj(billing.tokenPrices);
  const longPrices = obj(prices.longContext);
  const effortsRaw = m.supportedReasoningEfforts ?? m.supported_reasoning_efforts;
  const efforts = Array.isArray(effortsRaw) ? sortEfforts(effortsRaw.map(String).filter(Boolean)) : [];
  const tiersRaw = m.supportedContextTiers ?? m.supported_context_tiers;
  const advertisesLong = Array.isArray(tiersRaw) && tiersRaw.map(String).includes("long_context");
  const maxWindow = num(limits.max_context_window_tokens);
  const longContextWindow = num(longPrices.contextMax) ?? (advertisesLong ? maxWindow : undefined);
  const policyState = str(obj(m.policy).state);
  return {
    id,
    name: str(m.name) ?? id,
    vendor: str(m.vendor),
    category: str(m.modelPickerCategory ?? m.model_picker_category),
    priceCategory: str(m.modelPickerPriceCategory ?? m.model_picker_price_category),
    enabled: policyState !== "disabled",
    efforts,
    defaultEffort: str(m.defaultReasoningEffort ?? m.default_reasoning_effort),
    contextWindow: num(prices.contextMax) ?? (longContextWindow ? undefined : maxWindow),
    longContextWindow,
    discountPercent: num(billing.discountPercent),
  };
}

function normalizeAutoTier(raw: unknown): CatalogAutoTier | null {
  const t = obj(raw);
  const id = str(t.id);
  if (!id) return null;
  const status = obj(t.status);
  const promo = obj(obj(t.billing).promo);
  const promoEnds = str(promo.endsAt);
  const promoActive = Object.keys(promo).length > 0 && (!promoEnds || Date.parse(promoEnds) > Date.now());
  return {
    id,
    name: str(t.displayName ?? t.display_name) ?? id,
    description: str(t.description) ?? "",
    kind: str(t.type) ?? "auto",
    enabled: status.enabled !== false,
    visible: status.pickerVisible !== false && status.picker_visible !== false,
    promo: promoActive
      ? {
          discountPercent: num(promo.discountPercent),
          message: str(promo.message),
          startsAt: str(promo.startsAt),
          endsAt: promoEnds,
        }
      : undefined,
  };
}

/** Normalizes a desktop `models_list` reply (or a cached copy of one). */
export function normalizeDesktopCatalog(raw: unknown, source: ModelCatalog["source"] = "desktop"): ModelCatalog {
  const r = obj(raw);
  const models = (Array.isArray(r.models) ? r.models : []).map(normalizeModel).filter((m): m is CatalogModel => !!m);
  const autoRaw = obj(r.auto_tiers ?? r.autoTiers ?? r.auto);
  const autoTiers = (Array.isArray(autoRaw.tiers) ? autoRaw.tiers : [])
    .map(normalizeAutoTier)
    .filter((t): t is CatalogAutoTier => !!t);
  if (!models.some((m) => m.id === AUTO_MODEL_ID) && autoTiers.length > 0) {
    models.unshift({ id: AUTO_MODEL_ID, name: "Auto", enabled: true, efforts: [] });
  }
  return {
    models,
    autoTiers,
    defaultAutoTier: str(autoRaw.defaultTier ?? autoRaw.default_tier) ?? autoTiers[0]?.id ?? "balance",
    source,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Narrows the account catalog to one session's own list (`list_session_models`). The session list decides
 * which models and Auto levels the session can use (sessions can run under different accounts), while
 * the account catalog supplies the details the session list omits: efforts, context tiers, picker groups.
 */
export function applySessionModels(account: ModelCatalog, raw: unknown, sessionId?: string): ModelCatalog {
  const r = obj(raw);
  if (!Array.isArray(r.models)) return account;
  const rich = new Map(account.models.map((m) => [m.id, m]));
  const models: CatalogModel[] = [];
  for (const entry of r.models) {
    const own = normalizeModel(entry);
    if (!own || models.some((m) => m.id === own.id)) continue;
    const known = rich.get(own.id);
    models.push(known ? { ...known, enabled: known.enabled && own.enabled } : own);
  }
  // Without published levels the runtime rejects any explicit Auto preference for this session.
  const tiers = normalizeDesktopCatalog({ models: [], auto_tiers: r.auto_tiers ?? r.autoTiers });
  return {
    ...account,
    models,
    autoTiers: tiers.autoTiers,
    defaultAutoTier: tiers.autoTiers.length > 0 ? tiers.defaultAutoTier : account.defaultAutoTier,
    sessionId,
  };
}

/**
 * Reads the desktop app's cached model list from its `app_state`. Older app versions stored a bare
 * array; current versions store `{ accountId, models }`.
 */
export function modelsFromAppState(value: string | undefined): CatalogModel[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    const list = Array.isArray(parsed) ? parsed : obj(parsed).models;
    return Array.isArray(list) ? list.map(normalizeModel).filter((m): m is CatalogModel => !!m) : [];
  } catch {
    return [];
  }
}

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "XHigh" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Highest supported effort that doesn't exceed the requested one; else the weakest supported. */
function nearestEffort(requested: string, supported: string[]): string {
  const target = EFFORT_ORDER.indexOf(requested);
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) !== -1 && EFFORT_ORDER.indexOf(e) <= target);
  return below.length > 0 ? below[below.length - 1] : supported[0];
}

/**
 * Turns a requested change (any subset of model, effort, context tier, Auto tier) into a complete
 * selection the desktop app accepts for the target model, filling the rest from the session's current
 * selection. Values the target model doesn't support are adjusted to the closest valid choice, and each
 * adjustment is reported so the user can see what changed.
 */
export function resolveModelSelection(
  catalog: ModelCatalog | null,
  current: ModelSelection,
  patch: ModelSelection
): ResolvedSelection {
  const modelId = patch.model || current.model || AUTO_MODEL_ID;
  const known = catalog && catalog.models.length > 0 ? catalog.models : null;
  const model = known?.find((m) => m.id === modelId);
  if (known && !model) {
    return { ok: false, error: `${modelId} isn't available for this account. Refresh the model list and pick another.` };
  }
  if (model && !model.enabled) {
    return { ok: false, error: `${model.name} is disabled by your organization's Copilot policy.` };
  }
  const modelName = model?.name ?? modelId;
  const adjustments: string[] = [];

  if (modelId === AUTO_MODEL_ID) {
    // A rejected switch can leave the session refusing all further changes and messages until the
    // desktop app restarts, so only levels the session publishes are ever sent.
    if (catalog?.autoTiersUnverified) {
      return { ok: false, error: "This session's Auto levels haven't been confirmed yet. Try again in a moment." };
    }
    const tiers = catalog?.autoTiers ?? [];
    if (tiers.length === 0) {
      if (patch.autoTier) {
        return { ok: false, error: "This session doesn't offer Auto levels right now; only plain Auto is available." };
      }
      return { ok: true, selection: { model: AUTO_MODEL_ID }, adjustments };
    }
    const fallback = tiers.find((t) => t.id === catalog?.defaultAutoTier) ?? tiers.find((t) => t.enabled && t.visible);
    const tierId = patch.autoTier || current.autoTier || fallback?.id;
    let tier = tiers.find((t) => t.id === tierId);
    if (!tier && patch.autoTier) {
      return { ok: false, error: `The Auto level "${patch.autoTier}" isn't offered for this session.` };
    }
    if (!tier) {
      tier = fallback;
      if (tierId && tier) adjustments.push(`The Auto level "${tierId}" isn't offered anymore; using ${tier.name}.`);
    }
    if (!tier) return { ok: true, selection: { model: AUTO_MODEL_ID }, adjustments };
    if (!tier.enabled) {
      return { ok: false, error: `The ${tier.name} Auto level isn't available right now.` };
    }
    return { ok: true, selection: { model: AUTO_MODEL_ID, autoTier: tier.id }, adjustments };
  }

  const selection: Required<Pick<ModelSelection, "model">> & ModelSelection = { model: modelId };
  const efforts = model?.efforts ?? [];
  const requestedEffort = patch.reasoningEffort || current.reasoningEffort;
  if (efforts.length > 0) {
    if (requestedEffort && efforts.includes(requestedEffort)) {
      selection.reasoningEffort = requestedEffort;
    } else if (requestedEffort) {
      selection.reasoningEffort = nearestEffort(requestedEffort, efforts);
      adjustments.push(
        `${modelName} doesn't offer ${effortLabel(requestedEffort)} effort; using ${effortLabel(selection.reasoningEffort)}.`
      );
    } else {
      selection.reasoningEffort = model?.defaultEffort ?? (efforts.includes("high") ? "high" : efforts[efforts.length - 1]);
    }
  } else if (!model && requestedEffort) {
    selection.reasoningEffort = requestedEffort; // No catalog to check against: pass it through.
  } else if (patch.reasoningEffort) {
    adjustments.push(`${modelName} has no reasoning effort setting.`);
  }

  const requestedTier = patch.contextTier || current.contextTier || "default";
  if (requestedTier === "long_context" && model && !model.longContextWindow) {
    selection.contextTier = "default";
    adjustments.push(`${modelName} has no long-context tier; using the standard window.`);
  } else {
    selection.contextTier = requestedTier === "long_context" ? "long_context" : "default";
  }
  return { ok: true, selection, adjustments };
}
