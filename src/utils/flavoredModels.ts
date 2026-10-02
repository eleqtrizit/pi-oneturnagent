/**
 * Flavored model configuration utilities.
 *
 * Reads and writes flavor-categorized model lists (high/med/fast) from the
 * pi settings.json file, alongside the master `enabledModels` list.
 *
 * Settings keys:
 *   enabledModels: string[]      — master list of all model IDs
 *   enabledModelsHigh: string[]  — models for high-quality/deep reasoning
 *   enabledModelsMed: string[]   — models for balanced performance
 *   enabledModelsFast: string[]  — models for quick responses
 */

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

/** Flavor-categorized model lists. */
export interface FlavoredModelsResult {
  high: string[];
  med: string[];
  fast: string[];
}

/** In-memory representation of one model's flavor assignment. */
export interface ModelFlavor {
  id: string;
  flavor: FlavorValue;
}

export type FlavorValue = "high" | "med" | "fast" | "none";
export type FlavorKey = "high" | "med" | "fast";

export const FLAVOR_VALUES: FlavorValue[] = ["high", "med", "fast", "none"];

/** @internal Settings file shape — only the keys we care about. */
export interface SettingsFile {
  enabledModels?: unknown;
  enabledModelsHigh?: unknown;
  enabledModelsMed?: unknown;
  enabledModelsFast?: unknown;
  [key: string]: unknown;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);

// ── Settings I/O ────────────────────────────────────────────────────────────

/**
 * Read the full settings.json object.
 *
 * @param settingsPath - Path to the settings file
 * @returns The parsed settings object
 * @throws If the file cannot be read or parsed
 */
export function readSettings(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): SettingsFile {
  const raw = readFileSync(settingsPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Read flavor-categorized models from the pi settings.json file.
 *
 * Reads three optional arrays: enabledModelsHigh, enabledModelsMed,
 * enabledModelsFast. Missing keys are treated as empty arrays.
 *
 * @param settingsPath - Path to the settings file
 * @returns An object with high, med, and fast model identifier arrays
 * @throws If the file cannot be read or parsed or contains non-string values
 */
export function readFlavoredModels(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): FlavoredModelsResult {
  const config = readSettings(settingsPath);

  const safeArray = (val: unknown): string[] => {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item !== "string") {
          throw new Error(
            `Non-string value found in model list: ${JSON.stringify(item)}`,
          );
        }
      }
      return val as string[];
    }
    return [];
  };

  return {
    high: safeArray(config.enabledModelsHigh),
    med: safeArray(config.enabledModelsMed),
    fast: safeArray(config.enabledModelsFast),
  };
}

/**
 * Read the master enabledModels list.
 *
 * @param settingsPath - Path to the settings file
 * @returns The array of model identifiers
 * @throws If enabledModels is missing or not an array
 */
export function readEnabledModels(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): string[] {
  const config = readSettings(settingsPath);
  const models = config.enabledModels;

  if (!Array.isArray(models)) {
    throw new Error("enabledModels is not an array in settings.json");
  }

  return models as string[];
}

/**
 * Derive the current flavor assignment for each model in enabledModels.
 *
 * On duplicate entries across lists, later lists win: fast overwrites med,
 * med overwrites high.
 *
 * @param enabledModels - The master list of model IDs
 * @param flavors - The flavor-sorted model lists
 * @returns An array of ModelFlavor entries (one per model)
 */
export function buildModelFlavors(
  enabledModels: string[],
  flavors: FlavoredModelsResult,
): ModelFlavor[] {
  // Build a reverse-lookup: modelId -> flavor
  const flavorMap = new Map<string, FlavorValue>();
  for (const modelId of flavors.high) flavorMap.set(modelId, "high");
  for (const modelId of flavors.med) flavorMap.set(modelId, "med");
  for (const modelId of flavors.fast) flavorMap.set(modelId, "fast");

  return enabledModels.map((id) => ({
    id,
    flavor: flavorMap.get(id) ?? "none",
  }));
}

/**
 * Build a summary line showing current flavor counts.
 *
 * @param flavors - The current model flavor assignments
 * @returns A human-readable summary string
 */
export function buildFooterSummary(flavors: ModelFlavor[]): string {
  const high = flavors.filter((f) => f.flavor === "high").length;
  const med = flavors.filter((f) => f.flavor === "med").length;
  const fast = flavors.filter((f) => f.flavor === "fast").length;
  const none = flavors.filter((f) => f.flavor === "none").length;
  return `high:${high} med:${med} fast:${fast} none:${none}`;
}

/**
 * Write the current flavor assignments to settings.json.
 *
 * Performs a read-modify-write to preserve all existing keys.
 *
 * @param flavors - The current model flavor assignments
 * @param settingsPath - Path to the settings file
 * @throws If the file cannot be read or written
 */
export function writeFlavorsToSettings(
  flavors: ModelFlavor[],
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): void {
  const config = readSettings(settingsPath);

  config.enabledModelsHigh = flavors
    .filter((f) => f.flavor === "high")
    .map((f) => f.id);
  config.enabledModelsMed = flavors
    .filter((f) => f.flavor === "med")
    .map((f) => f.id);
  config.enabledModelsFast = flavors
    .filter((f) => f.flavor === "fast")
    .map((f) => f.id);

  writeFileSync(settingsPath, JSON.stringify(config, null, 2), "utf-8");
}
