// The model catalog comes from the desktop Copilot app (`list_models`), normalized for the mobile picker,
// plus the rules that turn a requested change into a selection the app accepts for a session. Ordering,
// labels, and defaults follow the desktop app's own model picker so both show the same choices.

export interface CatalogContextTier {
  id: "default" | "long_context";
  /** "Default context" or "Long context". */
  label: string;
  /** The window the desktop shows for the tier, e.g. "328K" or "1.1M". */
  contextLabel: string | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  vendor?: string;
  /** Set for models served through a custom provider rather than Copilot. */
  providerId?: string;
  /** Picker grouping published by the service: "powerful", "versatile", or "lightweight". */
  category?: string;
  /** Relative cost published for pickers: "low", "medium", "high", or "very_high". */
  priceCategory?: string;
  /** False unless policy enables the model for this account (no policy counts as enabled). */
  enabled: boolean;
  /** The service's explanation for a model that isn't enabled. */
  policyTerms?: string;
  /** Supported reasoning efforts, weakest first. Empty when the model has no effort setting. */
  efforts: string[];
  defaultEffort?: string;
  /** Standard context window in tokens. */
  contextWindow?: number;
  /** Window of the `long_context` tier, when the model offers a distinct one. */
  longContextWindow?: number;
  /** The context size the desktop picker shows for the model. */
  contextLabel?: string;
  /** The desktop's "Context window" choices; empty unless the model has a distinct long-context tier. */
  contextTiers?: CatalogContextTier[];
  /** Premium request multiplier, when the service publishes one. */
  multiplier?: number;
  /** The tag the desktop shows beside the name: "Research preview" or a multiplier such as "3x". */
  badge?: string;
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
  /** Why a disabled tier can't be used, when the service says. */
  statusMessage?: string;
  promo?: { discountPercent?: number; message?: string; startsAt?: string; endsAt?: string };
}

/** Model preferences the desktop app keeps in its own state; they shape its picker. */
export interface DesktopModelPreferences {
  /** Recently chosen models, most recent first. */
  recentModels: string[];
  /** The desktop's default model for new sessions. */
  defaultModel?: string;
  /** The Copilot Fusion level last chosen in the desktop. */
  autoTier?: string;
  /** Last effort chosen per model. */
  effortByModel: Record<string, string>;
  /** Last context tier chosen per model. */
  contextTierByModel: Record<string, string>;
  /** Desktop feature flags; undefined when they couldn't be read. */
  experiments?: string[];
}

/** The desktop picker's layout for a catalog: what's listed where, in its order. */
export interface ModelPickerView {
  /** "Copilot Fusion" when the desktop brands Auto that way, else "Auto". */
  autoLabel: string;
  /** Models listed at the top of the picker. */
  featured: string[];
  /** Models under "More models". */
  more: string[];
  /** Models under "Disabled models", with the reason the service gives. */
  disabled: { id: string; reason: string }[];
  /** Auto (Copilot Fusion) levels the picker lists, disabled ones included. */
  autoTiers: string[];
  /** The level a session uses when none is chosen; null when no listed level is usable. */
  defaultAutoTier: string | null;
  /** The session's model the lists were built for (it's always listed at the top). */
  selectedModel?: string;
  /** The desktop's three most recently chosen models that are available, most recent first. */
  recent: string[];
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
/** The desktop app's reasoning effort scale, weakest first. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Any finite number, zero included (prices can be zero). */
function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function sortEfforts(efforts: string[]): string[] {
  const known = efforts.filter((e) => EFFORT_ORDER.includes(e));
  const unknown = efforts.filter((e) => !EFFORT_ORDER.includes(e));
  return [...new Set([...known.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)), ...unknown])];
}

// Names the desktop app shows in place of the service's, before trimming "(Internal …)" suffixes.
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  "claude-opus-4.6-1m": "Claude Opus 4.6 (1M · Internal)",
};

function displayName(id: string, name: string): string {
  return (DISPLAY_NAME_OVERRIDES[id] ?? name).replace(/\s*\(\s*internal[^)]*\)\s*$/i, "");
}

/** Context sizes as the desktop picker writes them: "200K", "1M", "1.1M". */
export function contextSizeLabel(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 950_000 && tokens < 1e6) return "1M";
  if (tokens >= 1e6) {
    const millions = tokens / 1e6;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return tokens >= 1e3 ? `${Math.round(tokens / 1e3).toLocaleString("en-US")}K` : `${tokens}`;
}

/** A tier's usable window: its prompt budget plus output, capped by the model's limit when given. */
function windowWithOutput(context: number | undefined, output: number | undefined, cap: number | undefined) {
  if (context === undefined) return undefined;
  const total = context + (output ?? 0);
  return cap === undefined ? total : Math.min(total, cap);
}

interface TierPrices {
  inputPrice?: number;
  outputPrice?: number;
  cachePrice?: number;
  contextMax?: number;
}

function tierPrices(raw: Record<string, unknown>, contextMax?: number): TierPrices {
  return {
    inputPrice: finite(raw.inputPrice),
    outputPrice: finite(raw.outputPrice),
    cachePrice: finite(raw.cachePrice),
    contextMax: finite(raw.contextMax) ?? contextMax,
  };
}

/** The desktop picker's context tiers and labels for a model (its `pricingTiers` rules). */
function contextInfo(m: Record<string, unknown>): {
  contextLabel: string | null;
  tiers: CatalogContextTier[];
  contextWindow?: number;
  longContextWindow?: number;
} {
  const limits = obj(obj(m.capabilities).limits);
  const billing = obj(m.billing);
  const prices = isObj(billing.tokenPrices) ? billing.tokenPrices : undefined;
  const longRaw = prices && isObj(prices.longContext) ? prices.longContext : undefined;
  const tiersRaw = m.supportedContextTiers ?? m.supported_context_tiers;
  const advertisesLong = Array.isArray(tiersRaw) && tiersRaw.map(String).includes("long_context");
  const maxWindow = finite(limits.max_context_window_tokens);
  const maxOutput = finite(limits.max_output_tokens);
  const baseMax = prices ? finite(prices.contextMax) : undefined;
  const longMax = longRaw ? finite(longRaw.contextMax) : undefined;
  const longExceedsLimit = longMax !== undefined && longMax > (baseMax ?? maxWindow ?? 0);
  const base = tierPrices(prices ?? {}, maxWindow);
  const defaultWindow = windowWithOutput(baseMax, maxOutput, maxWindow) ?? maxWindow;

  const tiers: CatalogContextTier[] = [];
  const hasBasePrices = base.inputPrice !== undefined || base.outputPrice !== undefined || base.cachePrice !== undefined;
  if (advertisesLong || (prices && (hasBasePrices || base.contextMax !== undefined))) {
    tiers.push({ id: "default", label: "Default context", contextLabel: contextSizeLabel(defaultWindow) });
  }
  const long = longRaw ? tierPrices(longRaw) : undefined;
  const longDiffers =
    long !== undefined &&
    (long.contextMax !== base.contextMax ||
      long.inputPrice !== base.inputPrice ||
      long.outputPrice !== base.outputPrice ||
      long.cachePrice !== base.cachePrice);
  if (advertisesLong || longDiffers) {
    tiers.push({
      id: "long_context",
      label: "Long context",
      contextLabel: contextSizeLabel(windowWithOutput(longMax, maxOutput, longExceedsLimit ? undefined : maxWindow)),
    });
  }
  const contextLabel = contextSizeLabel(
    windowWithOutput(longMax ?? baseMax, maxOutput, longExceedsLimit ? undefined : maxWindow) ?? defaultWindow ?? maxWindow
  );
  const distinct = tiers.some((t) => t.id === "long_context");
  const choices: CatalogContextTier[] = !distinct
    ? []
    : tiers.some((t) => t.id === "default")
      ? tiers
      : [{ id: "default", label: "Default context", contextLabel: null }, ...tiers];
  return {
    contextLabel,
    tiers: choices,
    contextWindow: baseMax ?? (distinct ? undefined : maxWindow),
    longContextWindow: distinct ? (longMax ?? maxWindow) : undefined,
  };
}

/** A promotion the desktop would show: a valid discount (or a "spotlight" with a message) that hasn't ended. */
function activePromo(raw: unknown): { discountPercent: number; message?: string; startsAt?: string; endsAt: string } | undefined {
  if (!isObj(raw)) return undefined;
  const percent = raw.discountPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  if (percent > 0 && percent < 0.01) return undefined;
  const endsAt = str(raw.endsAt);
  const endsAtMs = endsAt ? Date.parse(endsAt) : NaN;
  if (!endsAt || !Number.isFinite(endsAtMs) || endsAtMs <= Date.now()) return undefined;
  const message = str(raw.message);
  if (percent === 0 && !message) return undefined;
  return { discountPercent: percent, message, startsAt: str(raw.startsAt), endsAt };
}

function isFusionModelId(id: string): boolean {
  return id === "hydrafusion" || id === "hydrafusion-max";
}

/** Splits a `provider/model` id the way the desktop does. */
function splitProviderModel(id: string): { providerId: string; modelId: string } | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  const provider = id.slice(0, slash);
  const hash = provider.indexOf("#");
  const providerId = hash >= 0 ? provider.slice(0, hash) : provider;
  return providerId ? { providerId, modelId: id.slice(slash + 1) } : undefined;
}

/** The model's maker, inferred from its id the way the desktop groups its picker. */
export function modelProvider(id: string): string | undefined {
  if (id === AUTO_MODEL_ID) return "github";
  const model = splitProviderModel(id)?.modelId ?? id;
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || /^o\d+(-|$)/.test(model)) return "openai";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("goldeneye") || model === "hydrafusion") return "github";
  if (model.startsWith("mai-")) return "microsoft";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("moonshot-") || model.startsWith("kimi-")) return "moonshot-ai";
  if (model.startsWith("grok-")) return "xai";
  return undefined;
}

export function normalizeModel(raw: unknown): CatalogModel | null {
  const m = obj(raw);
  const id = str(m.id);
  if (!id) return null;
  const billing = obj(m.billing);
  const policy = isObj(m.policy) ? m.policy : undefined;
  const enabled = !policy || str(policy.state) === "enabled";
  const providerId = str(m.providerId ?? m.provider_id);
  const effortsRaw = m.supportedReasoningEfforts ?? m.supported_reasoning_efforts;
  let efforts = Array.isArray(effortsRaw) ? sortEfforts(effortsRaw.map(String).filter(Boolean)) : [];
  let defaultEffort = str(m.defaultReasoningEffort ?? m.default_reasoning_effort);
  // Efforts the desktop app pins for particular models.
  if (id === "claude-opus-4.7") {
    efforts = ["medium"];
    defaultEffort = "medium";
  } else if (id === "kimi-k3" && !providerId) {
    efforts = ["low", "high", "max"];
    defaultEffort = defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : "high";
  }
  const context = contextInfo(m);
  const multiplier = finite(billing.multiplier);
  const researchPreview = !providerId && isFusionModelId(id);
  const promo = enabled ? activePromo(billing.promo) : undefined;
  return {
    id,
    name: displayName(id, str(m.name) ?? id),
    vendor: str(m.vendor),
    providerId,
    category: str(m.modelPickerCategory ?? m.model_picker_category),
    priceCategory: str(m.modelPickerPriceCategory ?? m.model_picker_price_category),
    enabled,
    policyTerms: policy && !enabled ? str(policy.terms) : undefined,
    efforts,
    defaultEffort,
    contextWindow: context.contextWindow,
    longContextWindow: context.longContextWindow,
    contextLabel: context.contextLabel ?? undefined,
    contextTiers: context.tiers,
    multiplier,
    badge: id === AUTO_MODEL_ID ? undefined : researchPreview ? "Research preview" : multiplier !== undefined ? `${multiplier}x` : undefined,
    discountPercent: promo && promo.discountPercent > 0 ? promo.discountPercent : num(billing.discountPercent),
  };
}

function normalizeAutoTier(raw: unknown): CatalogAutoTier | null {
  const t = obj(raw);
  const id = str(t.id);
  if (!id) return null;
  const status = obj(t.status);
  const promo = activePromo(obj(t.billing).promo);
  return {
    id,
    name: str(t.displayName ?? t.display_name) ?? id,
    description: str(t.description) ?? "",
    kind: str(t.type) ?? "auto",
    enabled: status.enabled !== false,
    visible: status.pickerVisible !== false && status.picker_visible !== false,
    statusMessage: str(status.message),
    promo,
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
    models.push(
      known
        ? {
            ...known,
            enabled: known.enabled && own.enabled,
            policyTerms: own.enabled ? known.policyTerms : (own.policyTerms ?? known.policyTerms),
          }
        : own
    );
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

// ---- The desktop picker's layout -------------------------------------------------------------------

/** Version-numbered model families ("gpt-sol" 6.1, "claude-opus" 5.5) as the desktop parses them. */
function modelVersion(id: string): { family: string; version: number[] } | undefined {
  const base = (splitProviderModel(id)?.modelId ?? id).toLowerCase();
  const match = /^(.+?)-(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(base);
  if (!match) return undefined;
  const suffix = match[3]?.trim();
  const family = suffix && !/^(fast|[0-9]+m)$/.test(suffix) ? `${match[1]}-${suffix}` : match[1];
  const version = match[2]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
  return version.length > 0 ? { family, version } : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function providerGroupKey(m: CatalogModel): string {
  return m.providerId ? `provider:${m.providerId}` : `catalog:${modelProvider(m.id) ?? m.id}`;
}

/**
 * Within each group (same key and maker), puts versioned models newest first while keeping the slots
 * the group occupies, so a newer generation always precedes an older one.
 */
function newestFirstWithinGroups(models: CatalogModel[], key: (m: CatalogModel) => string = () => ""): CatalogModel[] {
  const result = [...models];
  const groups = new Map<string, { model: CatalogModel; index: number; version: number[] }[]>();
  models.forEach((model, index) => {
    const version = modelVersion(model.id)?.version;
    if (!version) return;
    const groupKey = `${key(model)}\0${providerGroupKey(model)}`;
    const group = groups.get(groupKey) ?? [];
    group.push({ model, index, version });
    groups.set(groupKey, group);
  });
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => compareVersions(b.version, a.version) || a.index - b.index);
    group.forEach((slot, i) => {
      result[slot.index] = sorted[i].model;
    });
  }
  return result;
}

/** Models superseded by a newer version in the same family. */
function olderGenerations(models: CatalogModel[]): Set<string> {
  const families = new Map<string, { id: string; version: number[] }[]>();
  for (const m of models) {
    const parsed = modelVersion(m.id);
    if (!parsed) continue;
    const family = families.get(parsed.family) ?? [];
    family.push({ id: m.id, version: parsed.version });
    families.set(parsed.family, family);
  }
  const older = new Set<string>();
  for (const family of families.values()) {
    const newest = family.reduce((max, m) => (compareVersions(m.version, max) > 0 ? m.version : max), family[0].version);
    for (const m of family) if (compareVersions(m.version, newest) !== 0) older.add(m.id);
  }
  return older;
}

// Generations the desktop always files under "More models", and ones it always keeps at the top.
const ALWAYS_PREVIOUS_GENERATION = new Set(["gpt-5.6-terra", "gpt-5.5", "gpt-5.3-codex"]);
const NEVER_PREVIOUS_GENERATION = new Set(["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-luna"]);

/** The Auto levels a picker lists: visible Auto and Fusion tiers (a hidden one only while it's in use). */
export function listedAutoTiers(catalog: ModelCatalog, currentTier?: string): CatalogAutoTier[] {
  return catalog.autoTiers.filter(
    (t) => (t.kind === "auto" || t.kind === "fusion") && (t.visible || (currentTier !== undefined && t.id === currentTier))
  );
}

/** The level a session gets when none is chosen: the service's default, else Standard, else any usable one. */
export function defaultListedAutoTier(catalog: ModelCatalog): string | null {
  const usable = listedAutoTiers(catalog).filter((t) => t.enabled);
  return (
    usable.find((t) => t.id === catalog.defaultAutoTier)?.id ??
    usable.find((t) => t.id === "balance")?.id ??
    usable[0]?.id ??
    null
  );
}

/**
 * Lays out a catalog the way the desktop model picker does: featured models (the strongest current
 * generation of each maker, plus the session's model, the desktop default, and the three most recently
 * chosen), "More models", and "Disabled models", each grouped by maker in catalog order.
 */
export function buildModelPicker(
  catalog: ModelCatalog,
  options: { selectedModel?: string; currentAutoTier?: string; prefs?: Partial<DesktopModelPreferences> } = {}
): ModelPickerView {
  const prefs = options.prefs ?? {};
  const selected = options.selectedModel;
  const tiers = listedAutoTiers(catalog, options.currentAutoTier);
  const fusionBranding = prefs.experiments
    ? prefs.experiments.includes("dynamic_auto_tiers")
    : catalog.autoTiers.some((t) => t.kind === "fusion");
  // With Fusion levels, the Fusion models are chosen as levels of Auto rather than listed as models.
  const tiersOwnFusion = fusionBranding && tiers.some((t) => t.kind === "fusion" && t.enabled);
  const listed = (m: CatalogModel) =>
    m.id !== AUTO_MODEL_ID && !(tiersOwnFusion && !m.providerId && isFusionModelId(m.id) && m.id !== selected);

  const available = catalog.models.filter((m) => m.enabled && listed(m));
  const availableIds = new Set(available.map((m) => m.id));
  const recents = (prefs.recentModels ?? []).filter((id) => availableIds.has(id)).slice(0, 3);
  const defaultModel = prefs.defaultModel && !isFusionModelId(prefs.defaultModel) ? prefs.defaultModel : undefined;
  const older = olderGenerations(available.filter((m) => m.category));
  for (const id of ALWAYS_PREVIOUS_GENERATION) older.add(id);
  for (const id of NEVER_PREVIOUS_GENERATION) older.delete(id);
  const strongCategory = (m: CatalogModel) => m.category === "powerful" || m.category === "versatile";
  const isFeatured = (m: CatalogModel) =>
    m.id === "hydrafusion" ||
    m.id === selected ||
    m.id === defaultModel ||
    recents.includes(m.id) ||
    Boolean(m.providerId) ||
    (!older.has(m.id) && strongCategory(m));

  const catalogIndex = new Map(available.map((m, i) => [m.id, i]));
  const providerOrder = new Map<string, number>();
  for (const m of available) {
    const key = m.providerId ?? modelProvider(m.id) ?? m.id;
    if (!providerOrder.has(key)) providerOrder.set(key, providerOrder.size);
  }
  const providerRank = (m: CatalogModel) => providerOrder.get(m.providerId ?? modelProvider(m.id) ?? m.id) ?? Infinity;
  const arrange = (models: CatalogModel[], rank: (m: CatalogModel) => number): string[] => {
    const sorted = [...models].sort(
      (a, b) =>
        providerRank(a) - providerRank(b) ||
        rank(a) - rank(b) ||
        (catalogIndex.get(a.id) ?? 0) - (catalogIndex.get(b.id) ?? 0)
    );
    const ordered = newestFirstWithinGroups(sorted, (m) => String(rank(m)));
    const fusion = ordered.findIndex((m) => m.id === "hydrafusion" && m.enabled);
    if (fusion > 0) ordered.unshift(...ordered.splice(fusion, 1));
    return ordered.map((m) => m.id);
  };

  const featuredRank = (m: CatalogModel) =>
    m.category === "powerful"
      ? 0
      : m.category === "versatile"
        ? 1
        : m.providerId
          ? 2
          : recents.includes(m.id)
            ? 3
            : m.id === selected || m.id === defaultModel
              ? 4
              : 5;
  const featured = arrange(available.filter(isFeatured), featuredRank);
  const more = arrange(
    available.filter((m) => !isFeatured(m)),
    (m) => (m.category === "lightweight" ? 0 : 1)
  );
  const disabledModels = newestFirstWithinGroups(
    catalog.models.filter((m) => listed(m) && !m.enabled),
    (m) => m.category ?? "unknown"
  );
  return {
    autoLabel: fusionBranding ? "Copilot Fusion" : "Auto",
    featured,
    more,
    disabled: disabledModels.map((m) => ({ id: m.id, reason: m.policyTerms || "This model isn't available to you." })),
    autoTiers: tiers.map((t) => t.id),
    defaultAutoTier: defaultListedAutoTier(catalog),
    selectedModel: selected,
    recent: recents,
  };
}

// ---- Resolving a change ----------------------------------------------------------------------------

export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The desktop's starting effort for a model: its default (else Medium) when offered, else its weakest. */
export function defaultEffortFor(model: Pick<CatalogModel, "efforts" | "defaultEffort">): string | undefined {
  const efforts = model.efforts;
  if (efforts.length === 0) return undefined;
  const preferred = model.defaultEffort ?? "medium";
  if (efforts.includes(preferred)) return preferred;
  return efforts.find((e) => e !== "none") ?? "none";
}

/** The supported effort closest to the requested one on the desktop's scale; ties go to the stronger. */
function nearestEffort(requested: string, model: CatalogModel): string | undefined {
  const target = EFFORT_ORDER.indexOf(requested);
  if (target === -1) return defaultEffortFor(model);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const effort of model.efforts) {
    const index = EFFORT_ORDER.indexOf(effort);
    if (index === -1) continue;
    const distance = Math.abs(index - target);
    if (distance <= bestDistance) {
      best = effort;
      bestDistance = distance;
    }
  }
  return best ?? defaultEffortFor(model);
}

function offersLongContext(model: CatalogModel): boolean {
  return Boolean(model.contextTiers?.some((t) => t.id === "long_context"));
}

/**
 * Turns a requested change (any subset of model, effort, context tier, Auto tier) into a complete
 * selection the desktop app accepts for the target model, following the desktop picker's rules: a new
 * model keeps the closest effort to the current one (its default when coming from Auto) and starts on
 * its default context unless long context was last chosen for it in the desktop. Values the target
 * model doesn't support are adjusted to the closest valid choice, and each adjustment is reported.
 */
export function resolveModelSelection(
  catalog: ModelCatalog | null,
  current: ModelSelection,
  patch: ModelSelection,
  prefs: Partial<Pick<DesktopModelPreferences, "effortByModel" | "contextTierByModel">> = {}
): ResolvedSelection {
  const modelId = patch.model || current.model || AUTO_MODEL_ID;
  const known = catalog && catalog.models.length > 0 ? catalog.models : null;
  const model = known?.find((m) => m.id === modelId);
  if (known && !model) {
    return { ok: false, error: `${modelId} isn't available for this account. Refresh the model list and pick another.` };
  }
  if (model && !model.enabled) {
    return { ok: false, error: model.policyTerms || `${model.name} isn't available to you.` };
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
    const fallbackId = catalog ? defaultListedAutoTier(catalog) : null;
    const fallback = tiers.find((t) => t.id === fallbackId) ?? tiers.find((t) => t.enabled && t.visible);
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
      return { ok: false, error: tier.statusMessage || `The ${tier.name} Auto level isn't available right now.` };
    }
    return { ok: true, selection: { model: AUTO_MODEL_ID, autoTier: tier.id }, adjustments };
  }

  const selection: Required<Pick<ModelSelection, "model">> & ModelSelection = { model: modelId };
  const modelChanged = Boolean(current.model) && current.model !== modelId;
  if (model && model.efforts.length > 0) {
    if (patch.reasoningEffort) {
      selection.reasoningEffort = model.efforts.includes(patch.reasoningEffort)
        ? patch.reasoningEffort
        : nearestEffort(patch.reasoningEffort, model);
      if (selection.reasoningEffort !== patch.reasoningEffort) {
        adjustments.push(
          `${modelName} doesn't offer ${effortLabel(patch.reasoningEffort)} effort; using ${effortLabel(selection.reasoningEffort ?? "")}.`
        );
      }
    } else if (!current.model) {
      const remembered = prefs.effortByModel?.[modelId];
      selection.reasoningEffort =
        remembered && model.efforts.includes(remembered) ? remembered : defaultEffortFor(model);
    } else if (current.reasoningEffort && current.model !== AUTO_MODEL_ID) {
      selection.reasoningEffort = model.efforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : nearestEffort(current.reasoningEffort, model);
      if (selection.reasoningEffort !== current.reasoningEffort) {
        adjustments.push(
          `${modelName} doesn't offer ${effortLabel(current.reasoningEffort)} effort; using ${effortLabel(selection.reasoningEffort ?? "none")}.`
        );
      }
    } else {
      selection.reasoningEffort = defaultEffortFor(model);
    }
  } else if (!model && (patch.reasoningEffort || current.reasoningEffort)) {
    selection.reasoningEffort = patch.reasoningEffort || current.reasoningEffort; // No catalog to check against.
  } else if (patch.reasoningEffort) {
    adjustments.push(`${modelName} has no reasoning effort setting.`);
  }

  if (patch.contextTier) {
    const wantsLong = patch.contextTier === "long_context";
    if (wantsLong && model && !offersLongContext(model)) {
      selection.contextTier = "default";
      adjustments.push(`${modelName} has no long-context tier; using the standard window.`);
    } else {
      selection.contextTier = wantsLong ? "long_context" : "default";
    }
  } else if (!model) {
    selection.contextTier = current.contextTier === "long_context" ? "long_context" : "default";
  } else if (modelChanged || !current.model) {
    const rememberedLong = prefs.contextTierByModel?.[modelId] === "long_context";
    selection.contextTier = rememberedLong && offersLongContext(model) ? "long_context" : "default";
  } else {
    selection.contextTier = current.contextTier === "long_context" && offersLongContext(model) ? "long_context" : "default";
  }
  return { ok: true, selection, adjustments };
}
