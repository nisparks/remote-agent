import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  buildModelPicker,
  normalizeDesktopCatalog,
  resolveModelSelection,
  type DesktopModelPreferences,
  type ModelCatalog,
  type ModelSelection,
} from "../src/model-catalog.js";

const source = fs.readFileSync(new URL("../src/public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../src/public/index.html", import.meta.url), "utf8");
const catalog = normalizeDesktopCatalog({
  models: [
    { id: "auto", name: "Auto", billing: { discountPercent: 10 } },
    {
      id: "manual-model", name: "Manual Model",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      billing: { tokenPrices: { contextMax: 200000, longContext: { contextMax: 1000000 } } },
    },
    { id: "mai-code-2-flash", name: "MAI-Code-2-Flash" },
    { id: "older-model", name: "Older Model", modelPickerCategory: "lightweight" },
    { id: "blocked-model", name: "Blocked Model", policy: { state: "disabled", terms: "Ask an admin." } },
  ],
  auto_tiers: {
    defaultTier: "balance",
    tiers: [
      { id: "balance", displayName: "Standard", type: "auto" },
      { id: "hydrafusion", displayName: "High", type: "fusion" },
      { id: "hydrafusion-max", displayName: "Max", type: "fusion" },
      { id: "fast", displayName: "Fast", type: "auto", status: { pickerVisible: false } },
    ],
  },
});
const manual: ModelSelection = { model: "manual-model", reasoningEffort: "xhigh", contextTier: "long_context" };
type Session = ModelSelection & { pendingModel?: ModelSelection };
type HarnessOptions = { prefs?: Partial<DesktopModelPreferences>; layout?: boolean };

class Element {
  innerHTML = "";
  textContent = "";
  value = "";
  disabled = false;
  title = "";
  focused = false;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(event: { target: Element }) => unknown>>();
  classList = {
    toggle: (name: string, value: boolean) => value ? this.classes.add(name) : this.classes.delete(name),
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, fn: (event: { target: Element }) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), fn]);
  }
  focus() { this.focused = true; }
  async dispatch(name: string, value?: string) {
    if (value !== undefined) this.value = value;
    for (const fn of this.listeners.get(name) || []) await fn({ target: this });
  }
}

function harness(initial: Session = manual, modelCatalog = catalog, options: HarnessOptions = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  const calls: ModelSelection[] = [];
  const toasts: string[] = [];
  let applied: ModelSelection = { ...initial };
  // As the server sends it: the catalog with the desktop picker's layout (older desktops send none).
  const served = (c: ModelCatalog) =>
    options.layout === false ? c : { ...c, picker: buildModelPicker(c, { prefs: options.prefs }) };
  const control = {
    respond: async (patch: ModelSelection): Promise<Record<string, unknown>> => {
      const result = resolveModelSelection(modelCatalog, applied, patch);
      if (!result.ok) throw new Error(result.error);
      applied = result.selection;
      return { ok: true, ...result.selection };
    },
  };
  const context = vm.createContext({
    localStorage: { getItem: () => null },
    window: { addEventListener() {} },
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    testRequest: async (_url: string, options: { body: ModelSelection }) => {
      const patch = JSON.parse(JSON.stringify(options.body)) as ModelSelection;
      calls.push(patch);
      return control.respond(patch);
    },
    testToast: (message: string) => toasts.push(message),
  });
  assert.match(source, /\ninit\(\);\s*$/);
  // Run the real controls and event handlers without bootstrapping network access or other app views.
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, "") + `
    apiFetch = testRequest;
    showToast = testToast;
    renderSessionHeader = renderModelControls;
    loadSessionModelCatalog = async () => {};
    loadModelCatalog = async () => {};
    setupEventListeners();
  `, context);
  const picker = vm.runInContext(`({
    select(session, sessionId = "session-one", host = null) {
      state.activeSession = session;
      state.activeSessionId = sessionId;
      state.activePeerId = host;
      renderModelControls();
    },
    catalog(catalog) { state.modelCatalog = catalog; renderModelControls(); },
    render: renderModelControls,
    selection() { return state.activeSession; },
    description() { return describeModelSelection(state.activeSession); }
  })`, context) as {
    select: (session: Session, id?: string, host?: string | null) => void;
    catalog: (catalog: ModelCatalog) => void;
    render: () => void;
    selection: () => Session;
    description: () => string;
  };
  picker.catalog(served(modelCatalog));
  picker.select({ ...initial });
  return {
    ...picker, calls, toasts, control,
    catalog: (c: ModelCatalog) => picker.catalog(served(c)),
    el(id: string) {
      const element = elements.get(id);
      assert.ok(element, `Missing actual HTML control: ${id}`);
      return element;
    },
  };
}

describe("mobile Copilot Fusion controls", () => {
  it("exposes Fusion while a named model is selected, including MAI models", () => {
    const ui = harness();
    assert.equal(ui.el("sessionFusionToggle").style.display, "");
    assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "false");
    assert.match(ui.el("sessionModelSelect").innerHTML, /Copilot Fusion/);
    assert.match(ui.el("sessionModelSelect").innerHTML, /MAI-Code-2-Flash/);
    assert.doesNotMatch(ui.el("sessionModelSelect").innerHTML, /10% off/);
    assert.equal(ui.el("sessionAutoTierControl").style.display, "none");
    assert.equal(ui.el("sessionEffortSelect").style.display, "");
    assert.equal(ui.el("sessionContextTierSelect").value, "long_context");
  });

  it("shows Standard, High and Max as Fusion effort levels, not model reasoning", () => {
    for (const tier of catalog.autoTiers.slice(0, 3)) {
      const ui = harness({ model: "auto", autoTier: tier.id });
      assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "true");
      assert.equal(ui.el("sessionAutoTierControl").style.display, "");
      assert.equal(ui.el("sessionAutoTierSelect").value, tier.id);
      for (const name of ["Standard", "High", "Max"]) assert.match(ui.el("sessionAutoTierSelect").innerHTML, new RegExp(name));
      assert.doesNotMatch(ui.el("sessionAutoTierSelect").innerHTML, /Fast/);
      assert.equal(ui.el("sessionEffortSelect").style.display, "none");
      assert.equal(ui.el("sessionContextTierSelect").style.display, "none");
      assert.equal(ui.description(), `Copilot Fusion · ${tier.name}`);
    }
  });

  it("uses the published default, switches every level, and restores manual effort and context", async () => {
    const ui = harness();
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.deepEqual(ui.calls.at(-1), { model: "auto", autoTier: "balance" });
    for (const autoTier of ["balance", "hydrafusion", "hydrafusion-max"]) {
      await ui.el("sessionAutoTierSelect").dispatch("change", autoTier);
      assert.deepEqual(ui.calls.at(-1), { model: "auto", autoTier });
    }
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.deepEqual(ui.calls.at(-1), manual);
    assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "false");
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.deepEqual(ui.calls.at(-1), { model: "auto", autoTier: "hydrafusion-max" });
  });

  it("shows queued Fusion choices and can replace them with the prior manual selection", async () => {
    const ui = harness();
    ui.control.respond = async (patch) => ({ ok: true, ...patch, queued: true });
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.equal(ui.selection().model, manual.model);
    assert.equal(ui.selection().pendingModel?.autoTier, "balance");
    assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "true");
    assert.ok(ui.el("sessionFusionToggle").classes.has("pending"));
    await ui.el("sessionAutoTierSelect").dispatch("change", "hydrafusion-max");
    assert.equal(ui.el("sessionAutoTierSelect").value, "hydrafusion-max");
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.deepEqual(ui.calls.at(-1), manual);
    assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "false");
  });

  it("keeps controls locked across redraws, then restores the selection after a failed request", async () => {
    const ui = harness();
    let rejectRequest: (error: Error) => void = () => assert.fail("request never started");
    ui.control.respond = () => new Promise((_, reject) => { rejectRequest = reject; });
    const request = ui.el("sessionFusionToggle").dispatch("click");
    ui.render();
    assert.equal(ui.el("sessionFusionToggle").disabled, true);
    assert.equal(ui.el("sessionAutoTierSelect").disabled, true);
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.equal(ui.calls.length, 1);
    rejectRequest(new Error("Desktop refused the change"));
    await request;
    assert.equal(ui.el("sessionFusionToggle").disabled, false);
    assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "false");
    assert.equal(ui.el("sessionContextTierSelect").value, "long_context");
    assert.match(ui.toasts.at(-1)!, /Desktop refused/);
  });

  it("doesn't guess a manual model when opening a session on Fusion", async () => {
    const ui = harness({ model: "auto", autoTier: "balance" });
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.el("sessionModelSelect").focused, true);
    assert.match(ui.toasts.at(-1)!, /Choose a model/);
    await ui.el("sessionModelSelect").dispatch("change", "mai-code-2-flash");
    assert.equal(ui.selection().model, "mai-code-2-flash");
    assert.equal(ui.el("sessionFusionToggle").attributes.get("aria-checked"), "false");
  });

  it("keeps remembered models separate by session and desktop", async () => {
    const ui = harness();
    await ui.el("sessionFusionToggle").dispatch("click");
    ui.select({ model: "auto", autoTier: "balance" }, "session-two");
    await ui.el("sessionFusionToggle").dispatch("click");
    ui.select({ model: "auto", autoTier: "balance" }, "session-one", "other-desktop");
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.equal(ui.calls.length, 1, "neither session inherits another session's manual model");
  });

  it("doesn't apply an in-flight response to a different desktop's matching session ID", async () => {
    const ui = harness();
    let finish: (result: Record<string, unknown>) => void = () => assert.fail("request never started");
    ui.control.respond = () => new Promise((resolve) => { finish = resolve; });
    const request = ui.el("sessionFusionToggle").dispatch("click");
    ui.select({ model: "mai-code-2-flash" }, "session-one", "other-desktop");
    finish({ ok: true, model: "auto", autoTier: "balance" });
    await request;
    assert.equal(ui.selection().model, "mai-code-2-flash");
    assert.equal(ui.toasts.length, 0);
  });

  it("retains unknown and currently hidden levels without claiming the default is selected", () => {
    const ui = harness({ model: "auto" });
    assert.equal(ui.el("sessionAutoTierSelect").value, "");
    assert.match(ui.el("sessionAutoTierSelect").innerHTML, /Level\?/);
    ui.select({ model: "auto", autoTier: "fast" });
    assert.match(ui.el("sessionAutoTierSelect").innerHTML, /Fast/);
    ui.select({ model: "auto", autoTier: "future-tier" });
    assert.match(ui.el("sessionAutoTierSelect").innerHTML, /future-tier/);
  });

  it("retains plain Auto for sessions without Fusion and respects policy", () => {
    const ui = harness({ model: "auto" }, { ...catalog, autoTiers: [] });
    assert.equal(ui.el("sessionFusionToggle").style.display, "none");
    assert.equal(ui.el("sessionAutoTierControl").style.display, "none");
    assert.equal(ui.description(), "Auto");
    ui.catalog({ ...catalog, autoTiers: catalog.autoTiers.map((t) => ({ ...t, enabled: false })) });
    ui.select(manual);
    assert.equal(ui.el("sessionFusionToggle").disabled, true);
    ui.catalog({ ...catalog, models: catalog.models.map((m) => ({ ...m, enabled: m.id !== "auto" })) });
    assert.equal(ui.el("sessionFusionToggle").disabled, true);
  });

  it("lists models in the desktop's sections: featured, More models, and Disabled models", () => {
    const ui = harness(manual, catalog, { prefs: { recentModels: ["mai-code-2-flash"] } });
    const select = ui.el("sessionModelSelect").innerHTML;
    const more = select.indexOf('<optgroup label="More models">');
    const disabled = select.indexOf('<optgroup label="Disabled models">');
    assert.ok(select.indexOf("Copilot Fusion") < select.indexOf("MAI-Code-2-Flash"));
    assert.ok(select.indexOf("MAI-Code-2-Flash") < more, "recent models are featured");
    assert.ok(more < select.indexOf("Older Model") && select.indexOf("Older Model") < disabled);
    assert.match(select.slice(disabled), /value="blocked-model" disabled title="Ask an admin\."/);
    assert.equal(ui.el("sessionModelSelect").value, "manual-model");
  });

  it("hands Fusion back to the desktop's latest model when the session has no manual choice", async () => {
    const ui = harness({ model: "auto", autoTier: "balance" }, catalog, { prefs: { recentModels: ["blocked-model", "mai-code-2-flash"] } });
    await ui.el("sessionFusionToggle").dispatch("click");
    assert.deepEqual(ui.calls.at(-1), { model: "mai-code-2-flash" });
  });

  it("shows unavailable Fusion levels as disabled with the service's reason", () => {
    const limited = {
      ...catalog,
      autoTiers: catalog.autoTiers.map((t) => (t.id === "hydrafusion-max" ? { ...t, enabled: false, statusMessage: "Upgrade to use Max." } : t)),
    };
    const ui = harness({ model: "auto", autoTier: "balance" }, limited);
    assert.match(ui.el("sessionAutoTierSelect").innerHTML, /value="hydrafusion-max" disabled title="Upgrade to use Max\.">Max \(not available\)/);
  });

  it("labels context windows and efforts as the desktop does", () => {
    const ui = harness();
    assert.match(ui.el("sessionContextTierSelect").innerHTML, /200K context.*1M context/);
    assert.match(ui.el("sessionEffortSelect").innerHTML, /Extra High/);
    assert.equal(ui.description(), "Manual Model · Extra High · 1M context");
  });

  it("still renders catalogs from desktops that send no picker layout", () => {
    const ui = harness(manual, catalog, { layout: false });
    const select = ui.el("sessionModelSelect").innerHTML;
    assert.match(select, /Older Model/);
    assert.match(select, /<optgroup label="Disabled models">.*Blocked Model/);
    assert.equal(ui.el("sessionModelSelect").value, "manual-model");
  });
});
