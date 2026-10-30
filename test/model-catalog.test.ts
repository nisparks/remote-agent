import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySessionModels, modelsFromAppState, normalizeDesktopCatalog, resolveModelSelection } from "../src/model-catalog.js";

// Shapes mirror the desktop app's `models_list` reply.
const desktopReply = {
  type: "models_list",
  models: [
    { id: "auto", name: "Auto", capabilities: {}, billing: { discountPercent: 10 } },
    {
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
      vendor: "Anthropic",
      modelPickerCategory: "powerful",
      policy: { state: "enabled" },
      supportedReasoningEfforts: ["max", "low", "high", "medium", "xhigh"],
      capabilities: { limits: { max_context_window_tokens: 1000000 } },
      billing: { tokenPrices: { contextMax: 200000, longContext: { contextMax: 1000000 } } },
    },
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      modelPickerCategory: "powerful",
      policy: { state: "enabled" },
      supportedReasoningEfforts: ["low", "medium", "high"],
      billing: { tokenPrices: { contextMax: 200000, longContext: { contextMax: 983040 } } },
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      modelPickerCategory: "lightweight",
      policy: { state: "enabled" },
      capabilities: { limits: { max_context_window_tokens: 200000 } },
      billing: { tokenPrices: { inputPrice: 100 } },
    },
    { id: "blocked-model", name: "Blocked", policy: { state: "disabled" }, supportedReasoningEfforts: ["low"] },
  ],
  auto_tiers: {
    defaultTier: "balance",
    tiers: [
      {
        id: "balance",
        displayName: "Standard",
        description: "Everyday coding.",
        type: "auto",
        status: { enabled: true, pickerVisible: true },
        billing: { promo: { discountPercent: 30, message: "30% off", endsAt: "2999-01-01T00:00:00Z" } },
      },
      { id: "hydrafusion", displayName: "High", description: "Hard tasks.", type: "fusion", status: { enabled: true } },
      {
        id: "retired-tier",
        displayName: "Old",
        description: "",
        type: "auto",
        status: { enabled: false, pickerVisible: true },
        billing: { promo: { discountPercent: 50, endsAt: "2001-01-01T00:00:00Z" } },
      },
      { id: "fast", displayName: "Fast", description: "Low latency.", type: "auto", status: { enabled: true, pickerVisible: false } },
    ],
  },
};

describe("model catalog", () => {
  const catalog = normalizeDesktopCatalog(desktopReply);

  it("normalizes the desktop catalog: efforts, context tiers, policy, and Auto tiers", () => {
    const opus = catalog.models.find((m) => m.id === "claude-opus-5.5")!;
    assert.deepEqual(opus.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(opus.category, "powerful");
    assert.equal(opus.contextWindow, 200000);
    assert.equal(opus.longContextWindow, 1000000);

    const haiku = catalog.models.find((m) => m.id === "claude-haiku-4.5")!;
    assert.deepEqual(haiku.efforts, []);
    assert.equal(haiku.contextWindow, 200000);
    assert.equal(haiku.longContextWindow, undefined);

    assert.equal(catalog.models.find((m) => m.id === "blocked-model")!.enabled, false);
    assert.equal(catalog.models.find((m) => m.id === "auto")!.discountPercent, 10);

    assert.equal(catalog.defaultAutoTier, "balance");
    assert.deepEqual(
      catalog.autoTiers.map((t) => [t.id, t.name, t.kind, t.enabled, t.visible]),
      [
        ["balance", "Standard", "auto", true, true],
        ["hydrafusion", "High", "fusion", true, true],
        ["retired-tier", "Old", "auto", false, true],
        ["fast", "Fast", "auto", true, false],
      ]
    );
    assert.equal(catalog.autoTiers[0].promo?.discountPercent, 30);
    assert.equal(catalog.autoTiers[2].promo, undefined, "ended promotions are dropped");
  });

  it("reads the app's cached model list in both its old and current formats", () => {
    const legacy = JSON.stringify([{ id: "auto", name: "Auto" }, { id: "gpt-6-sol", name: "GPT-6 Sol" }]);
    const current = JSON.stringify({ accountId: "acct", models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] });
    assert.deepEqual(modelsFromAppState(legacy).map((m) => m.id), ["auto", "gpt-6-sol"]);
    assert.deepEqual(modelsFromAppState(current).map((m) => m.id), ["gpt-6.1-sol"]);
    assert.deepEqual(modelsFromAppState("not json"), []);
    assert.deepEqual(modelsFromAppState(undefined), []);
  });

  it("adjusts an effort the target model doesn't offer and keeps a supported long-context tier", () => {
    const result = resolveModelSelection(
      catalog,
      { model: "claude-opus-5.5", reasoningEffort: "max", contextTier: "long_context" },
      { model: "gemini-4-argon" }
    );
    assert.ok(result.ok);
    assert.deepEqual(result.selection, { model: "gemini-4-argon", reasoningEffort: "high", contextTier: "long_context" });
    assert.match(result.adjustments[0], /doesn't offer Max effort; using High/);
  });

  it("drops effort and long context for a model without them", () => {
    const result = resolveModelSelection(
      catalog,
      { model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "long_context" },
      { model: "claude-haiku-4.5" }
    );
    assert.ok(result.ok);
    assert.deepEqual(result.selection, { model: "claude-haiku-4.5", contextTier: "default" });
    assert.match(result.adjustments.join(" "), /no long-context tier/);
  });

  it("changes only the effort when that is all that was asked", () => {
    const result = resolveModelSelection(
      catalog,
      { model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "default" },
      { reasoningEffort: "xhigh" }
    );
    assert.ok(result.ok);
    assert.deepEqual(result.selection, { model: "claude-opus-5.5", reasoningEffort: "xhigh", contextTier: "default" });
    assert.deepEqual(result.adjustments, []);
  });

  it("selects Auto with a requested, remembered, or default tier", () => {
    const explicit = resolveModelSelection(catalog, { model: "gemini-4-argon" }, { model: "auto", autoTier: "hydrafusion" });
    assert.ok(explicit.ok);
    assert.deepEqual(explicit.selection, { model: "auto", autoTier: "hydrafusion" });

    const remembered = resolveModelSelection(catalog, { model: "auto", autoTier: "fast" }, { model: "auto" });
    assert.ok(remembered.ok);
    assert.equal(remembered.selection.autoTier, "fast", "hidden tiers stay valid once selected");

    const byDefault = resolveModelSelection(catalog, { model: "claude-opus-5.5" }, { model: "auto" });
    assert.ok(byDefault.ok);
    assert.equal(byDefault.selection.autoTier, "balance");

    const unlisted = resolveModelSelection(catalog, {}, { model: "auto", autoTier: "intelligence" });
    assert.ok(!unlisted.ok, "levels the session doesn't publish are never sent");

    const retired = resolveModelSelection(catalog, { model: "auto", autoTier: "gone" }, { model: "auto" });
    assert.ok(retired.ok);
    assert.equal(retired.selection.autoTier, "balance", "a remembered level that disappeared falls back to the default");
    assert.match(retired.adjustments.join(" "), /isn't offered anymore/);
  });

  it("offers only plain Auto when the session publishes no Auto levels", () => {
    const noLevels = { ...catalog, autoTiers: [] };
    const plain = resolveModelSelection(noLevels, { model: "gpt-6-sol" }, { model: "auto" });
    assert.ok(plain.ok);
    assert.deepEqual(plain.selection, { model: "auto" });

    const level = resolveModelSelection(noLevels, { model: "gpt-6-sol" }, { model: "auto", autoTier: "hydrafusion" });
    assert.ok(!level.ok);
    assert.match(level.error, /only plain Auto/);

    const unconfirmed = resolveModelSelection({ ...catalog, autoTiersUnverified: true }, { model: "gpt-6-sol" }, { model: "auto" });
    assert.ok(!unconfirmed.ok, "levels a session hasn't confirmed are never sent");
  });

  it("narrows the account catalog to a session's own list", () => {
    // `list_session_models` omits efforts and context tiers, and leaves out `auto_tiers` for accounts without levels.
    const sessionReply = {
      type: "session_models_list",
      models: [
        { id: "auto", name: "Auto", capabilities: {} },
        { id: "claude-opus-5.5", name: "Claude Opus 5.5", policy: { state: "enabled" }, billing: {} },
        { id: "gemini-4-argon", name: "Gemini 4 Argon", policy: { state: "disabled" }, billing: {} },
        { id: "session-only", name: "Session Only", billing: {} },
      ],
    };
    const narrowed = applySessionModels(catalog, sessionReply, "s1");
    assert.equal(narrowed.sessionId, "s1");
    assert.deepEqual(narrowed.models.map((m) => m.id), ["auto", "claude-opus-5.5", "gemini-4-argon", "session-only"]);
    assert.deepEqual(narrowed.models[1].efforts, ["low", "medium", "high", "xhigh", "max"], "account details are kept");
    assert.equal(narrowed.models[1].longContextWindow, 1000000);
    assert.equal(narrowed.models[2].enabled, false, "the session's policy wins");
    assert.deepEqual(narrowed.autoTiers, [], "no auto_tiers means no Auto levels");

    const withLevels = applySessionModels(catalog, { ...sessionReply, auto_tiers: desktopReply.auto_tiers });
    assert.deepEqual(withLevels.autoTiers.map((t) => t.id), ["balance", "hydrafusion", "retired-tier", "fast"]);
    assert.equal(withLevels.defaultAutoTier, "balance");

    assert.equal(applySessionModels(catalog, { type: "error" }), catalog, "unreadable lists leave the catalog alone");
  });

  it("rejects unknown models, policy-disabled models, and unavailable Auto tiers", () => {
    const unknown = resolveModelSelection(catalog, {}, { model: "gpt-5.4" });
    assert.ok(!unknown.ok);
    assert.match(unknown.error, /isn't available/);

    const blocked = resolveModelSelection(catalog, {}, { model: "blocked-model" });
    assert.ok(!blocked.ok);
    assert.match(blocked.error, /disabled by your organization/);

    const badTier = resolveModelSelection(catalog, {}, { model: "auto", autoTier: "nonexistent" });
    assert.ok(!badTier.ok);

    const disabledTier = resolveModelSelection(catalog, {}, { model: "auto", autoTier: "retired-tier" });
    assert.ok(!disabledTier.ok);
    assert.match(disabledTier.error, /isn't available right now/);
  });

  it("passes selections through when no catalog is available", () => {
    const result = resolveModelSelection(null, { reasoningEffort: "max" }, { model: "some-new-model" });
    assert.ok(result.ok);
    assert.deepEqual(result.selection, { model: "some-new-model", reasoningEffort: "max", contextTier: "default" });
  });
});
