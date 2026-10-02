import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFooterSummary,
  buildModelFlavors,
  readEnabledModels,
  readFlavoredModels,
  writeFlavorsToSettings,
} from "./flavoredModels";

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
  if (settingsDir) {
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

describe("readFlavoredModels", () => {
  it("returns empty lists when flavor keys are missing", () => {
    writeSettingsFile({ enabledModels: ["a", "b"] });
    expect(readFlavoredModels(settingsPath)).toEqual({
      high: [],
      med: [],
      fast: [],
    });
  });

  it("reads all three flavor lists", () => {
    writeSettingsFile({
      enabledModelsHigh: ["h1"],
      enabledModelsMed: ["m1", "m2"],
      enabledModelsFast: ["f1"],
    });
    expect(readFlavoredModels(settingsPath)).toEqual({
      high: ["h1"],
      med: ["m1", "m2"],
      fast: ["f1"],
    });
  });

  it("throws on non-string entries", () => {
    writeSettingsFile({ enabledModelsHigh: ["ok", 42] });
    expect(() => readFlavoredModels(settingsPath)).toThrow(/Non-string value/);
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

describe("buildModelFlavors", () => {
  it("assigns none to models not in any flavor list", () => {
    const flavors = { high: ["a"], med: ["b"], fast: [] };
    expect(buildModelFlavors(["a", "b", "c"], flavors)).toEqual([
      { id: "a", flavor: "high" },
      { id: "b", flavor: "med" },
      { id: "c", flavor: "none" },
    ]);
  });

  it("lets later lists win on duplicates (fast > med > high)", () => {
    const flavors = { high: ["x"], med: ["x"], fast: ["x"] };
    expect(buildModelFlavors(["x"], flavors)).toEqual([
      { id: "x", flavor: "fast" },
    ]);
  });
});

describe("buildFooterSummary", () => {
  it("counts each flavor bucket", () => {
    const items = [
      { id: "a", flavor: "high" as const },
      { id: "b", flavor: "med" as const },
      { id: "c", flavor: "none" as const },
      { id: "d", flavor: "none" as const },
    ];
    expect(buildFooterSummary(items)).toBe("high:1 med:1 fast:0 none:2");
  });
});

describe("writeFlavorsToSettings round-trip", () => {
  it("writes flavor lists and preserves unrelated keys", () => {
    writeSettingsFile({
      enabledModels: ["a", "b", "c"],
      unrelated: { keep: true },
    });

    const assigned = buildModelFlavors(
      ["a", "b", "c"],
      readFlavoredModels(settingsPath),
    );
    assigned[0].flavor = "high";
    assigned[1].flavor = "fast";
    // assigned[2] stays "none"

    writeFlavorsToSettings(assigned, settingsPath);

    const result = readFlavoredModels(settingsPath);
    expect(result.high).toEqual(["a"]);
    expect(result.fast).toEqual(["b"]);
    expect(result.med).toEqual([]);

    // Unrelated keys survive the read-modify-write
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(raw.unrelated).toEqual({ keep: true });
    expect(raw.enabledModels).toEqual(["a", "b", "c"]);
  });
});
