import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readRecordedModelState } from "../src/session-store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-model-state-"));
let fileNo = 0;

function eventsFile(events: Array<Record<string, unknown>>, filler = 0): string {
  const file = path.join(dir, `events-${fileNo++}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e));
  if (filler > 0) {
    // Large unrelated events between the model events, so the reader crosses chunk boundaries.
    const big = JSON.stringify({ type: "tool.execution_complete", data: { result: "é".repeat(filler) } });
    lines.splice(1, 0, big, big);
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

describe("readRecordedModelState", () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads Fusion levels recorded as autoTierIdCompat and ignores sub-agent switches", () => {
    const file = eventsFile([
      { type: "session.start", data: { selectedModel: "claude-opus-5.5", contextTier: "long_context", reasoningEffort: "high" } },
      { type: "session.model_change", data: { source: "sdk", newModel: "auto", previousModel: "claude-opus-5.5", contextTier: null, autoTierIdCompat: "hydrafusion-max" } },
      { type: "session.model_change", agentId: "sub-1", data: { source: "agent", newModel: "gpt-5.6-luna", contextTier: "long_context" } },
    ]);
    assert.deepEqual(readRecordedModelState(file), { model: "auto", contextTier: "default", autoTier: "hydrafusion-max" });
  });

  it("takes fields an event leaves out from older events, across chunk boundaries", () => {
    const file = eventsFile(
      [
        { type: "session.start", data: { selectedModel: "gemini-4-argon", contextTier: "long_context", reasoningEffort: "high" } },
        { type: "session.model_change", data: { source: "sdk", newModel: "gemini-4-argon", previousModel: "gemini-4-argon", reasoningEffort: "medium" } },
      ],
      400_000
    );
    assert.deepEqual(readRecordedModelState(file), { model: "gemini-4-argon", contextTier: "long_context", reasoningEffort: "medium" });
  });

  it("forgets levels from before the session last entered Auto", () => {
    const file = eventsFile([
      { type: "session.resume", data: { selectedModel: "auto", contextTier: "default", autoTier: "balance" } },
      { type: "session.model_change", data: { newModel: "grok-4.7", previousModel: "auto", contextTier: "default" } },
      { type: "session.model_change", data: { newModel: "auto", previousModel: "grok-4.7", contextTier: null } },
    ]);
    const state = readRecordedModelState(file);
    assert.equal(state.model, "auto");
    assert.equal(state.autoTier, undefined);
  });

  it("returns nothing for a missing log", () => {
    assert.deepEqual(readRecordedModelState(path.join(dir, "missing.jsonl")), {});
  });
});
