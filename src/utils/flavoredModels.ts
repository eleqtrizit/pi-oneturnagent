/**
 * Read-only access to pi settings.json model lists.
 *
 * Settings keys:
 *   enabledModels: string[]              — master list of all model IDs
 *   enabledModelsOrchestrator: string[]  — current flavor: orchestrating, planning
 *   enabledModelsWorker: string[]        — current flavor: coding
 *   enabledModelsSwarm: string[]         — current flavor: read-only gathering
 *   enabledModelsHigh/Med/Fast: string[] — legacy flavors, still read
 *
 * This copy never writes or migrates settings. pi-teams owns the migration.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Settings keys that hold flavored model lists, current and legacy. */
export const FLAVOR_SETTINGS_KEYS = [
  "enabledModelsOrchestrator",
  "enabledModelsWorker",
  "enabledModelsSwarm",
  "enabledModelsHigh",
  "enabledModelsMed",
  "enabledModelsFast",
] as const;

export const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);

/**
 * Read the full settings.json object.
 *
 * @param settingsPath - Path to the settings file
 * @returns The parsed settings object
 * @throws If the file cannot be read or parsed
 */
export function readSettings(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): Record<string, unknown> {
  const raw = readFileSync(settingsPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Validate a settings value as a string array.
 *
 * @param val - Raw settings value
 * @returns The array, or an empty array when the value is not an array
 * @throws If the array contains a non-string value
 */
function safeArray(val: unknown): string[] {
  if (!Array.isArray(val)) {
    return [];
  }
  for (const item of val) {
    if (typeof item !== "string") {
      throw new Error(
        `Non-string value found in model list: ${JSON.stringify(item)}`,
      );
    }
  }
  return val as string[];
}

/**
 * Read every flavored model id from settings.json.
 *
 * Merges the current keys (orchestrator, worker, swarm) and the legacy keys
 * (high, med, fast) into one deduplicated list. Missing keys count as empty.
 *
 * @param settingsPath - Path to the settings file
 * @returns Flavored model ids in key order, without duplicates
 * @throws If the file cannot be read or parsed or contains non-string values
 */
export function readFlavoredModelIds(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): string[] {
  const config = readSettings(settingsPath);
  const ids = FLAVOR_SETTINGS_KEYS.flatMap((key) => safeArray(config[key]));
  return [...new Set(ids)];
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
