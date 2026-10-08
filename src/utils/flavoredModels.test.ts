import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEnabledModels, readFlavoredModelIds } from "./flavoredModels";

let settingsDir: string;
let settingsPath: string;

function writeSettingsFile(data: object): void {
  writeFileSync(settingsPath, JSON.stringify(data), "utf-8");
}

beforeEach(() => {
  settingsDir = mkdtempSync(path.join(tmpdir(), "flavored-models-"));
  settingsPath = path.join(settingsDir, "settings.json");
});

afterEach(() => {
  rmSync(settingsDir, { recursive: true, force: true });
});

describe("readFlavoredModelIds", () => {
  it("returns an empty list when no flavor keys exist", () => {
    writeSettingsFile({ enabledModels: ["a"] });
    expect(readFlavoredModelIds(settingsPath)).toEqual([]);
  });

  it("reads the current orchestrator/worker/swarm keys", () => {
    writeSettingsFile({
      enabledModelsOrchestrator: ["o1"],
      enabledModelsWorker: ["w1", "w2"],
      enabledModelsSwarm: ["s1"],
    });
    expect(readFlavoredModelIds(settingsPath)).toEqual([
      "o1",
      "w1",
      "w2",
      "s1",
    ]);
  });

  it("reads the legacy high/med/fast keys", () => {
    writeSettingsFile({
      enabledModelsHigh: ["h1"],
      enabledModelsMed: ["m1"],
      enabledModelsFast: ["f1"],
    });
    expect(readFlavoredModelIds(settingsPath)).toEqual(["h1", "m1", "f1"]);
  });

  it("merges current and legacy keys without duplicates", () => {
    writeSettingsFile({
      enabledModelsWorker: ["x", "y"],
      enabledModelsFast: ["y", "z"],
    });
    expect(readFlavoredModelIds(settingsPath)).toEqual(["x", "y", "z"]);
  });

  it("throws on non-string entries", () => {
    writeSettingsFile({ enabledModelsHigh: ["ok", 42] });
    expect(() => readFlavoredModelIds(settingsPath)).toThrow(
      /Non-string value/,
    );
  });
});

describe("readEnabledModels", () => {
  it("returns the master list", () => {
    writeSettingsFile({ enabledModels: ["a", "b"] });
    expect(readEnabledModels(settingsPath)).toEqual(["a", "b"]);
  });

  it("throws when enabledModels is missing or not an array", () => {
    writeSettingsFile({});
    expect(() => readEnabledModels(settingsPath)).toThrow(
      /enabledModels is not an array/,
    );
    writeSettingsFile({ enabledModels: "nope" });
    expect(() => readEnabledModels(settingsPath)).toThrow(
      /enabledModels is not an array/,
    );
  });
});
