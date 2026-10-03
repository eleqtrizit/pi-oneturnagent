/**
 * pi-oneturnagent — one-turn model substitution for Pi Coding Agent.
 *
 * `$<model> <prompt>`  switch to a fuzzy-matched substitute model, run exactly
 *                      one turn, then restore the original model.
 * `$$<model> <prompt>` same, but the session is trimmed afterwards so only the
 *                      agent's final output stays in context — tool calls and
 *                      intermediate results are dropped via context_edit
 *                      entries emitted from the turn_end handler.
 *
 * Three or more dollars is ordinary text, as are dollar amounts like "$100
 * budget note".
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as flavoredModels from "../src/utils/flavoredModels";

// Cache for available models
let availableModelsCache: Array<{ provider: string; model: string }> | null =
  null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 60000; // 1 minute


/** A resolved model reference: full "provider/model" string split in two. */
export interface SubModelRef {
  provider: string;
  model: string;
}

/** Parsed arguments of the substitute-model command. */
export interface SubCommandArgs {
  modelRequest: string;
  prompt: string;
}

/** Which bang-model command a `$`-prefixed input maps to. */
export type BangModelCommandKind = "sub" | "sub-trimmed";

/** Parsed `$`-prefixed model command input. */
export interface BangModelCommandArgs {
  /** One `$` runs a substitute turn; `$$` runs one and keeps only its final output */
  kind: BangModelCommandKind;
  /** Fuzzy model request, e.g. "opus-4" or "openai/gpt-5" */
  modelRequest: string;
  /** Everything after the model token */
  prompt: string;
}

/** One or two dollars; three or more is ordinary text, not a command prefix. */
const BANG_MODEL_INPUT = /^(\${1,2})(\S+)\s+(\S.*)$/;

/**
 * What a plausible model request looks like: a letter first, then word
 * characters, dots, slashes, colons, at-signs, or hyphens. Rejects dollar
 * amounts ("$100 note"), stray dollars ("$$$$$ money"), and plain numbers so
 * ordinary text reaches the model untouched.
 */
const MODEL_REQUEST_LIKE = /^[A-Za-z][\w./:@-]*$/;

/**
 * Parse a `$`-prefixed model command: "$<model> <prompt...>" or
 * "$$<model> <prompt...>". `$$` runs the same substitute turn as `$` but then
 * trims the session so only the agent's final output stays in context.
 *
 * Input that does not match the shape, such as "$100 budget note" or a lone
 * "$model" without a prompt, is left as ordinary message text.
 *
 * @param text - Raw user input
 * @returns The parsed command, or null when the input is not a bang-model command
 */
export function parseBangModelCommand(
  text: string,
): BangModelCommandArgs | null {
  const match = BANG_MODEL_INPUT.exec(text);
  if (!match || !MODEL_REQUEST_LIKE.test(match[2])) {
    return null;
  }
  const kind: BangModelCommandKind =
    match[1].length === 1 ? "sub" : "sub-trimmed";
  return { kind, modelRequest: match[2], prompt: match[3].trim() };
}

/**
 * Parse substitute-model input: "<model name> <prompt...>" (the "$" prefix is
 * stripped by the input handler before this runs).
 *
 * @param args - Raw argument string: the model request and prompt
 * @returns The model request and prompt, or null when either part is missing
 */
export function parseSubCommandArgs(args: string): SubCommandArgs | null {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return null;
  }
  const modelRequest = trimmed.slice(0, firstSpace);
  const prompt = trimmed.slice(firstSpace).trim();
  if (!prompt) {
    return null;
  }
  return { modelRequest, prompt };
}

/** Injected collaborators of executeSubTurn, kept minimal for testability. */
export interface SubTurnDeps {
  /** Model the session ran with before the substitution */
  originalModel: SubModelRef;
  /** Resolves the user's model request, or null when nothing matches */
  resolve: (modelRequest: string) => SubModelRef | null;
  /** Activates a model; resolves false when the provider is not authenticated */
  setModel: (model: SubModelRef) => Promise<boolean>;
  /** Sends the prompt to the agent for one turn */
  runPrompt: (prompt: string) => Promise<void>;
  /** Resolves when the agent is idle again after the turn */
  waitForIdle: () => Promise<void>;
  /** Shows a status, error, or success message to the user */
  notify: (message: string, level: "info" | "error" | "success") => void;
}

/**
 * Run one turn with a substitute model, then restore the original model.
 *
 * The original model is restored even when the prompt run or the idle wait
 * throws, so the session never stays pinned to the substitute model.
 *
 * @param deps - Collaborators for resolution, model switching, prompting
 * @param modelRequest - The user's model request, bare or provider-prefixed
 * @param prompt - The prompt text to run with the substitute model
 */
export async function executeSubTurn(
  deps: SubTurnDeps,
  modelRequest: string,
  prompt: string,
): Promise<void> {
  const substitute = deps.resolve(modelRequest);
  if (!substitute) {
    deps.notify("Could not resolve the substitute model.", "error");
    return;
  }
  let switchResult: boolean;
  try {
    switchResult = await deps.setModel(substitute);
  } catch (error) {
    deps.notify(
      `Switching to ${substitute.provider}/${substitute.model} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
    return;
  }
  if (!switchResult) {
    deps.notify(
      `Could not switch to ${substitute.provider}/${substitute.model}: the model is not in the registry or the provider is not authenticated.`,
      "error",
    );
    return;
  }
  try {
    deps.notify(
      `Running one turn with ${substitute.provider}/${substitute.model}.`,
      "success",
    );
    await deps.runPrompt(prompt);
    await deps.waitForIdle();
  } finally {
    deps.notify(
      `Substitute turn done; restoring ${deps.originalModel.provider}/${deps.originalModel.model}.`,
      "success",
    );
    try {
      await deps.setModel(deps.originalModel);
    } catch (restoreError) {
      deps.notify(
        `Failed to restore ${deps.originalModel.provider}/${deps.originalModel.model}: ${
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError)
        }`,
        "error",
      );
    }
  }
}



/** Entry ids carried by a turn_end event; kept minimal for testability. */
export interface TurnEndTrimEvent {
  messageEntryId: string;
  toolResultEntryIds: string[];
  /**
   * How the turn ended: "completed" means the run may continue (final answer
   * or intermediate step); "aborted" or "error" means the run is over or the
   * turn failed (pi may retry an errored turn inside the same run). pi omits
   * the field on older builds, treated as "completed".
   */
  outcome?: "completed" | "aborted" | "error";
}

/**
 * Build the trim drafts for the buffered turns of one finished run.
 *
 * A turn with tool results is trimmed entirely (assistant message plus tool
 * results). A turn that ended aborted or with no tool results is a dangling
 * partial step: its assistant message is trimmed so the run leaves no
 * half-written text behind. A completed turn with no tool results is the
 * final answer: kept. Entries in `protectedEntryIds` are never targets: they
 * existed before the run started, so erasing them would drop context that
 * predates the run (a protected anchored turn contributes nothing).
 *
 * @param turns - The buffered turn_end events of the run, in order
 * @param protectedEntryIds - Entry ids present before the run started; omit or pass null to disable the guard
 * @returns Context-edit drafts omitting the run's intermediate content
 */
export function buildRunTrimDrafts(
  turns: TurnEndTrimEvent[],
  protectedEntryIds?: ReadonlySet<string> | null,
): Array<{
  type: "context_edit";
  targetId: string;
  replacement: null;
}> {
  const isProtected = (id: string) => protectedEntryIds?.has(id) ?? false;
  return turns.flatMap((turn) => {
    if (isProtected(turn.messageEntryId)) {
      return [];
    }
    if (turn.toolResultEntryIds.length > 0) {
      return buildTrimToLastTurnDrafts(turn, protectedEntryIds) ?? [];
    }
    if (turn.outcome === "completed" || turn.outcome === undefined) {
      // Final answer: keep it.
      return [];
    }
    return [
      {
        type: "context_edit" as const,
        targetId: turn.messageEntryId,
        replacement: null,
      },
    ];
  });
}

/**
 * Build the context_edit drafts that trim one tool-calling turn out of model
 * context, or null when the turn is the final answer (no tool results) and
 * should be kept.
 *
 * Entries listed in `protectedEntryIds` are never draft targets: they existed
 * before the trim-armed run started, so erasing them would drop context that
 * predates the run. A protected assistant entry voids the entire draft (a
 * turn anchored to a pre-existing entry cannot belong to the run); protected
 * tool results are filtered out individually.
 *
 * @param event - The turn_end event's entry-id fields
 * @param protectedEntryIds - Entry ids present before the run started; omit or pass null to disable the guard
 * @returns Context-edit drafts omitting the turn's messages, or null to keep the turn
 */
export function buildTrimToLastTurnDrafts(
  event: TurnEndTrimEvent,
  protectedEntryIds?: ReadonlySet<string> | null,
): Array<{
  type: "context_edit";
  targetId: string;
  replacement: null;
}> | null {
  const isProtected = (id: string) => protectedEntryIds?.has(id) ?? false;
  if (event.toolResultEntryIds.length === 0 || isProtected(event.messageEntryId)) {
    return null;
  }
  return [
    {
      type: "context_edit" as const,
      targetId: event.messageEntryId,
      replacement: null,
    },
    ...event.toolResultEntryIds
      .filter((targetId) => !isProtected(targetId))
      .map((targetId) => ({
        type: "context_edit" as const,
        targetId,
        replacement: null,
      })),
  ];
}

/** Data payload of a green model-switch notice entry. */
interface ModelSwitchEntryData {
  message: string;
  timestamp: number;
}

/** Custom entry type for green model-switch notices. */
const MODEL_SWITCH_ENTRY_TYPE = "pi-oneturnagent/model-switch";


/** Clear the available models cache. Useful for testing. */
export function clearModelsCache(): void {
  availableModelsCache = null;
  modelsCacheTime = 0;
}


/**
 * Minimal model-registry interface used by this extension.
 */
interface ModelRegistryLike {
  getAvailable(): Array<{ provider: string; id: string }>;
}

/**
 * Query available models from Pi's in-process model registry.
 */
function getAvailableModels(
  modelRegistry: ModelRegistryLike,
): Array<{ provider: string; model: string }> {
  const now = Date.now();
  if (availableModelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
    return availableModelsCache;
  }

  try {
    const models = modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      model: model.id,
    }));

    availableModelsCache = models;
    modelsCacheTime = now;
    return models;
  } catch (_e) {
    return [];
  }
}

/** One argument-completion entry pi shows below the command line. */
export interface CommandCompletionItem {
  label: string;
  value: string;
}

/**
 * Complete the leading model argument of a typed command like "$<model> <prompt...>".
 *
 * Treats everything before the first space as the model token, so completions
 * are suppressed once the user starts typing the prompt. Within the token an
 * optional "provider/" prefix narrows the candidates, and the remaining text
 * is matched as a case-insensitive substring of the provider or model name.
 *
 * @param argumentPrefix - Text the user typed after the command name so far
 * @param models - Available models to complete against
 * @param maxItems - Upper bound on returned entries
 * @return: Up to maxItems "provider/model" completions, or null when there is nothing to offer
 */
export function completeModelArg(
  argumentPrefix: string,
  models: Array<{ provider: string; model: string }>,
  maxItems = 12,
): CommandCompletionItem[] | null {
  // Model names never contain spaces, so any space after the leading
  // whitespace means the user has moved on to typing the prompt.
  if (argumentPrefix.trim().includes(" ")) return null;
  const modelToken = argumentPrefix.split(" ", 1)[0];
  // Model ids can contain slashes; split at the first slash only so the full
  // remainder is treated as the model-id prefix (split("/", 2) would truncate
  // the array and drop every slash after the second).
  const slashIndex = modelToken.indexOf("/");
  const providerPrefix =
    slashIndex !== -1 ? modelToken.slice(0, slashIndex).toLowerCase() : null;
  const namePrefix = (
    slashIndex !== -1 ? modelToken.slice(slashIndex + 1) : modelToken
  ).toLowerCase();
  const items = models
    .filter(
      (m) =>
        (providerPrefix === null ||
          m.provider.toLowerCase() === providerPrefix) &&
        (namePrefix === "" ||
          m.model.toLowerCase().includes(namePrefix) ||
          m.provider.toLowerCase().includes(namePrefix)),
    )
    .slice(0, maxItems)
    .map((m) => ({
      label: `${m.provider}/${m.model}`,
      value: `${m.provider}/${m.model}`,
    }));
  return items.length > 0 ? items : null;
}

/** One or two dollars; three or more is ordinary text, not a command prefix. */
const BANG_MODEL_TYPED_PREFIX = /^(\${1,2})(\S*)$/;

/** One suggestion pi's editor can complete: what to insert and how to show it. */
interface BangCompletionItem {
  label: string;
  value: string;
  description?: string;
}

/**
 * Subset of pi-tui's AutocompleteProvider the wrapper needs. Optional
 * `options` mirrors the runtime signature (abort signal, Tab force flag);
 * the vendored peer types predate it.
 */
interface EditorAutocompleteProvider {
  /** Characters that auto-trigger this provider at token boundaries. */
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options?: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: BangCompletionItem[]; prefix: string } | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: BangCompletionItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
}

/**
 * Runtime shape of pi's UI context. The vendored peer types lack
 * addAutocompleteProvider, so the install site casts through this interface.
 */
interface EditorUIContext {
  addAutocompleteProvider?: (
    factory: (
      current: EditorAutocompleteProvider,
    ) => EditorAutocompleteProvider,
  ) => void;
}

/**
 * Wrap pi's autocomplete provider so `$` and `$$` prefixes offer the
 * model list while the user is typing the model token.
 *
 * Prefixes without a leading run of one to two dollars fall through to the
 * wrapped provider unchanged. Completion values carry the dollar prefix, so
 * accepting a suggestion keeps it in place.
 *
 * @param getModels - Supplies the models to complete against at call time
 * @return: A factory that wraps the current autocomplete provider
 */
export function createBangModelCompletionFactory(
  getModels: () => Array<{ provider: string; model: string }>,
): (current: EditorAutocompleteProvider) => EditorAutocompleteProvider {
  return (current) => ({
    // pi's editor only auto-opens completions for a known trigger character
    // (defaults: "@" and "#"). Declaring "$" here makes typing a dollar sign
    // open the popup; pi_tui merges this into the editor's trigger set.
    triggerCharacters: ["$"],
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      const textBefore = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = BANG_MODEL_TYPED_PREFIX.exec(textBefore);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      // The regex anchors at the line start, so a space anywhere before the
      // cursor means the user is already typing the prompt; no completions.
      const items = completeModelArg(match[2], getModels());
      if (!items) {
        return null;
      }
      return {
        // A trailing space after the model name puts the cursor where the
        // prompt starts, so the user types immediately after accepting. The
        // space also ends the dollar-prefix token, keeping the popup closed.
        items: items.map((item) => ({
          ...item,
          value: `${match[1]}${item.value} `,
        })),
        prefix: textBefore,
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
  });
}

/**
 * Provider priority list - OAuth/subscription providers first (cheaper), then API-key providers
 */
const PROVIDER_PRIORITY = [
  // OAuth / Subscription providers (typically free/cheaper)
  "google-gemini-cli", // Google Gemini CLI - OAuth, free tier
  "github-copilot", // GitHub Copilot - subscription
  "kimi-sub", // Kimi subscription
  // API key providers
  "anthropic",
  "openai",
  "google",
  "zai",
  "openrouter",
  "azure-openai",
  "amazon-bedrock",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "vercel-ai-gateway",
];

/**
 * Resolve provider rank. Lower values are preferred.
 * Custom providers (not in built-in priority list) are preferred over built-in providers.
 */
function getProviderPriority(provider: string): number {
  const index = PROVIDER_PRIORITY.indexOf(provider.toLowerCase());
  return index === -1 ? -1 : index + 1;
}

/**
 * Compare two registry entries by provider priority, then provider name.
 */
function byProviderPriority(
  a: { provider: string; model: string },
  b: { provider: string; model: string },
): number {
  return (
    getProviderPriority(a.provider) - getProviderPriority(b.provider) ||
    a.provider.localeCompare(b.provider)
  );
}

/**
 * Resolve a model request to provider/model.
 *
 * Provider-prefixed requests resolve strictly within the named provider. Bare
 * names walk a priority ladder: the flavored models from pi settings first
 * (high/med/fast), then the session's scoped models (pi --models flag, or the
 * enabledModels list when the flag is absent), then the entire registry. The
 * fuzzy match runs only against the first non-empty group, so a configured
 * group always wins: a flavored model is returned when any flavored model is
 * set, and a scoped model is returned when any scoped model is set.
 *
 * @param modelName - The user's model request, bare or provider-prefixed
 * @param modelRegistry - Registry providing available models
 * @param scope - Ladder group overrides; groups are read from pi settings and
 * the pi argv when omitted. Passing a group's key with an empty list means the
 * group is unset and the tier is skipped.
 * @returns The full provider/model string or null if not found
 */
export function resolveModelWithProvider(
  modelName: string,
  modelRegistry: ModelRegistryLike,
  scope?: {
    /** Overrides the flavored-model group ids; pi settings are read when omitted */
    flavoredModelIds?: string[];
    /** Overrides the scoped-model patterns; pi's scope is read when omitted */
    scopedPatterns?: string[];
  },
): string | null {
  const availableModels = getAvailableModels(modelRegistry);
  if (availableModels.length === 0) {
    return null;
  }

  // If already has provider prefix, resolve strictly within that provider only.
  // Never fall back to a different provider — that causes false positives like
  // resolve_model("vyper/Qwen-35B") returning bighank/Qwen-35B.
  if (modelName.includes("/")) {
    // Split at the first slash only: model ids can themselves contain slashes
    // (e.g. "aws/anthropic/bedrock-claude-sonnet-5-5"). split("/", 2) would
    // truncate the result array instead of limiting splits and drop the tail.
    const slashIndex = modelName.indexOf("/");
    const providerPart = modelName.slice(0, slashIndex);
    const modelId = modelName.slice(slashIndex + 1).toLowerCase();
    const exists = availableModels.some(
      (m) =>
        m.provider.toLowerCase() === providerPart.toLowerCase() &&
        m.model.toLowerCase() === modelId,
    );
    if (exists) {
      return modelName;
    }
    // Try resolving model-id scoped to the named provider only.
    const providerModels = availableModels.filter(
      (m) => m.provider.toLowerCase() === providerPart.toLowerCase(),
    );
    if (providerModels.length > 0) {
      const scopedRegistry: ModelRegistryLike = {
        getAvailable: () =>
          providerModels.map((m) => ({ provider: m.provider, id: m.model })),
      };
      const scopedResult = resolveModelWithProvider(modelId, scopedRegistry);
      if (scopedResult) {
        return scopedResult;
      }
    }
    // No match within the specified provider — return null instead of searching across all providers.
    return null;
  }

  const lowerModelName = modelName.toLowerCase();

  // Resolution ladder: flavored models first, then the session's scoped
  // models, then the entire registry. Each group resolves with exact,
  // partial-token, and fuzzy matching; the first non-empty group wins and is
  // never bypassed. Group overrides act as testing hooks: an empty list means
  // the group is unset and pi settings are not consulted.
  const groups: Array<Array<{ provider: string; model: string }>> = [
    scope?.flavoredModelIds
      ? buildFlavoredModelGroup(availableModels, scope.flavoredModelIds)
      : getFlavoredModelGroup(availableModels),
    scope?.scopedPatterns
      ? buildScopedModelGroup(availableModels, scope.scopedPatterns)
      : getScopedModelGroup(availableModels),
    availableModels,
  ];
  for (const group of groups) {
    if (group.length === 0) {
      continue;
    }

    // Find exact matches (case-insensitive) and sort by provider priority
    const exactMatches = group.filter(
      (m) => m.model.toLowerCase() === lowerModelName,
    );
    if (exactMatches.length > 0) {
      exactMatches.sort(byProviderPriority);
      return `${exactMatches[0].provider}/${exactMatches[0].model}`;
    }

    const queryTokens = tokenizeForSearch(modelName);

    // Try partial/token match (model name contains all query tokens)
    const partialMatches = group
      .filter((m) => {
        const normalizedModel = normalizeForSearch(m.model);
        return queryTokens.every((token) => normalizedModel.includes(token));
      })
      .sort(byProviderPriority);
    if (partialMatches.length > 0) {
      return `${partialMatches[0].provider}/${partialMatches[0].model}`;
    }

    // Fall back to composite-aware token matching within this group only
    const topMatches = getTopModelsFromList(group, modelName, 1);
    if (topMatches.length > 0) {
      return topMatches[0].model;
    }
  }
  return null;
}

/**
 * Map flavored model ids to registry-available models.
 *
 * Flavored ids are pi settings' high/med/fast entries; each id matches either
 * the "provider/modelId" pair or the bare model id, case-insensitively.
 *
 * @param availableModels - Registry-available models
 * @param flavoredIds - Flavored model ids from pi settings
 * @returns The registry-available flavored models, deduplicated
 */
export function buildFlavoredModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
  flavoredIds: string[],
): Array<{ provider: string; model: string }> {
  const flavored = new Set(
    flavoredIds.map((id) => id.toLowerCase()).filter(Boolean),
  );
  if (flavored.size === 0) {
    return [];
  }
  const group: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  for (const entry of availableModels) {
    const fullId = `${entry.provider}/${entry.model}`.toLowerCase();
    if (!flavored.has(fullId) && !flavored.has(entry.model.toLowerCase())) {
      continue;
    }
    if (seen.has(fullId)) {
      continue;
    }
    seen.add(fullId);
    group.push(entry);
  }
  return group;
}

/**
 * Match a scoped-model pattern against a registry entry.
 *
 * Patterns are case-insensitive, support * and ? globs, and may end in a
 * ":thinking-level" suffix which is ignored for matching. pi's own
 * minimatch-based scope additionally supports char classes; this matcher
 * compares those characters literally.
 *
 * @param pattern - Scoped-model pattern from the pi session
 * @param entry - Registry entry to match
 * @returns True when the pattern matches the entry
 */
export function scopedPatternMatches(
  pattern: string,
  entry: { provider: string; model: string },
): boolean {
  let core = pattern;
  const colonIdx = core.lastIndexOf(":");
  if (colonIdx !== -1) {
    const suffix = core.substring(colonIdx + 1).toLowerCase();
    if (["off", "minimal", "low", "medium", "high"].includes(suffix)) {
      core = core.substring(0, colonIdx);
    }
  }
  const lowerCore = core.toLowerCase();
  const fullId = `${entry.provider}/${entry.model}`.toLowerCase();
  const modelId = entry.model.toLowerCase();
  if (lowerCore.includes("*") || lowerCore.includes("?")) {
    return (
      globMatchesPattern(lowerCore, fullId) ||
      globMatchesPattern(lowerCore, modelId)
    );
  }
  return fullId === lowerCore || modelId === lowerCore;
}

/** Convert a glob pattern with * and ? wildcards into a matcher function. */
function globMatchesPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return regex.test(value);
}

/**
 * Map scoped-model patterns to registry-available models.
 *
 * @param availableModels - Registry-available models
 * @param patterns - Scoped-model patterns from the pi session
 * @returns The registry-available scoped models, deduplicated
 */
export function buildScopedModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
  patterns: string[],
): Array<{ provider: string; model: string }> {
  if (patterns.length === 0) {
    return [];
  }
  const group: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  for (const entry of availableModels) {
    if (!patterns.some((pattern) => scopedPatternMatches(pattern, entry))) {
      continue;
    }
    const key = `${entry.provider}/${entry.model}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    group.push(entry);
  }
  return group;
}

/**
 * Build the flavored-model group: the high/med/fast flavor lists from pi
 * settings.json mapped to registry-available models.
 *
 * @param availableModels - Registry-available models
 * @returns Group models, or an empty group when no flavors are set
 */
function getFlavoredModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
): Array<{ provider: string; model: string }> {
  try {
    const flavors = flavoredModels.readFlavoredModels();
    return buildFlavoredModelGroup(availableModels, [
      ...flavors.high,
      ...flavors.med,
      ...flavors.fast,
    ]);
  } catch (_e) {
    // Malformed settings leave the group empty and the ladder falls through.
    return [];
  }
}

/**
 * Build the scoped-model group: the pi session's scoped models mapped to
 * registry-available models.
 *
 * @param availableModels - Registry-available models
 * @returns Group models, or an empty group when no scoped models are set
 */
function getScopedModelGroup(
  availableModels: Array<{ provider: string; model: string }>,
): Array<{ provider: string; model: string }> {
  return buildScopedModelGroup(availableModels, getScopedModelPatterns());
}

/**
 * Read the pi session's scoped model patterns.
 *
 * The scope always exists: pi resolves --models patterns when the session was
 * launched with the flag, and otherwise falls back to the enabledModels list
 * from pi settings.json.
 *
 * @returns The scoped-model patterns, or an empty array when none are configured
 */
function getScopedModelPatterns(): string[] {
  const argv = process.argv;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--models" && index + 1 < argv.length) {
      return argv[index + 1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  try {
    return flavoredModels.readEnabledModels();
  } catch (_e) {
    // Missing or malformed enabledModels leaves the scope empty.
    return [];
  }
}

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () =>
    Array<number>(cols).fill(0),
  );

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

/**
 * Normalize text for fuzzy matching by collapsing separators.
 */
function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Tokenize text for fuzzy matching.
 */
function tokenizeForSearch(value: string): string[] {
  return normalizeForSearch(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

const STOP_WORDS = new Set([
  "on",
  "the",
  "with",
  "for",
  "by",
  "in",
  "at",
  "to",
  "a",
  "an",
  "of",
  "and",
  "or",
]);

/**
 * Collapse a string to lowercase alphanumeric only (no spaces or separators).
 *
 * :param value: The string to collapse
 * :return: Collapsed lowercase alphanumeric string
 */
function collapse(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Tokenize a user query, filtering out stop words.
 *
 * :param value: The raw user query
 * :return: Array of meaningful query tokens (lowercase, alphanumeric only)
 */
function tokenizeQuery(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Split a token on letter/number boundaries.
 * E.g., "qwen35b" → ["qwen", "35", "b"], "bighank" → ["bighank"]
 *
 * :param token: The token to split
 * :return: Array of sub-parts (or the original token if no split points)
 */
function splitToken(token: string): string[] {
  return token
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .split(" ")
    .filter((p) => p.length > 0);
}

/**
 * Score how well a query token matches a collapsed candidate.
 *
 * Returns a score reflecting match quality. For composite tokens
 * (like "qwen35b"), this sums the lengths of all contiguous
 * sub-segments that are found as direct substrings. This rewards
 * candidates where more of the token's sub-parts are adjacent.
 *
 * :param token: A single query token
 * :param collapsed: The collapsed candidate string
 * :return: Match strength score, or 0 for no match
 */
function tokenMatchStrength(token: string, collapsed: string): number {
  if (collapsed.includes(token)) return token.length * 2;

  const parts = splitToken(token);
  if (parts.length <= 1) return 0;

  // Check all parts exist (composite match)
  if (!parts.every((part) => collapsed.includes(part))) return 0;

  // Sum lengths of all contiguous sub-segments found as direct substrings.
  // For "qwen35b" → ["qwen","35","b"]:
  //   sub-segments: "qwen"(4), "qwen35"(6), "qwen35b"(7), "35"(2), "35b"(3), "b"(1)
  //   Against "...qwen35coder35bnothinking": "qwen"✓, "qwen35"✓, "35"✓, "35b"✓, "b"✓ = 4+6+2+3+1 = 16
  //   Against "...qwen35coder122b": "qwen"✓, "qwen35"✓, "35"✓, "b"✓ = 4+6+2+1 = 13
  let score = 0;
  for (let i = 0; i < parts.length; i++) {
    let segment = "";
    for (let j = i; j < parts.length; j++) {
      segment += parts[j];
      if (collapsed.includes(segment)) {
        score += segment.length;
      }
    }
  }

  return score;
}

/**
 * Count how many query tokens match a collapsed candidate string.
 *
 * :param queryTokens: The tokenized user query
 * :param collapsed: The collapsed candidate string (lowercase alphanumeric)
 * :return: Number of query tokens that match (direct or composite)
 */
function countMatches(queryTokens: string[], collapsed: string): number {
  return queryTokens.filter((t) => tokenMatchStrength(t, collapsed) > 0).length;
}

/**
 * Count how many query tokens exactly match a word-boundary segment of the
 * model's base name (last slash-delimited component of the model ID).
 * Using only the base name avoids false positives from provider-namespace
 * prefixes in model IDs like "qwen/qwen3-coder-480b".
 * E.g., for base "qwen3coder-35b", segments are ["qwen3coder", "35b"]; token
 * "35b" is an exact segment match while "qwen35" is not.
 *
 * :param queryTokens: The tokenized user query
 * :param modelId: The raw model identifier (not collapsed)
 * :return: Number of query tokens that exactly match a model segment
 */
function countExactSegmentMatches(
  queryTokens: string[],
  modelId: string,
): number {
  const baseName = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  const segments = new Set(
    baseName
      .toLowerCase()
      .split(/[-_.\s]+/)
      .map((s) => s.replace(/[^a-z0-9]/g, "")),
  );
  return queryTokens.filter((t) => segments.has(t)).length;
}

/**
 * Sum of match strengths for all query tokens. Higher = better quality
 * matches (direct substring worth 2, composite split worth 1).
 *
 * :param queryTokens: The tokenized user query
 * :param collapsed: The collapsed candidate string
 * :return: Total match strength score
 */
function matchQuality(queryTokens: string[], collapsed: string): number {
  return queryTokens.reduce(
    (sum, t) => sum + tokenMatchStrength(t, collapsed),
    0,
  );
}

/**
 * Find top model matches from an explicit model list by substring relevance
 * and Levenshtein distance.
 *
 * Matching is done by collapsing "provider/model" into a single lowercase
 * alphanumeric string and checking whether each query token appears as a
 * substring. Tokens that are composites like "35b" or "qwen3" are also
 * split on letter/number boundaries so their parts can match individually.
 *
 * @param models - The models to search
 * @param modelName - The user's free-form query string
 * @param limit - Maximum number of results to return
 * @returns Array of { model, distance } sorted by relevance
 */
function getTopModelsFromList(
  models: Array<{ provider: string; model: string }>,
  modelName: string,
  limit = 5,
): Array<{ model: string; distance: number }> {
  const query = modelName.trim().toLowerCase();
  const queryTokens = tokenizeQuery(query);
  const normalizedQuery = normalizeForSearch(query);

  return models
    .map((m) => {
      const fullId = `${m.provider}/${m.model}`;
      const collapsedFull = collapse(fullId);
      const collapsedModel = collapse(m.model);

      const matchCount = countMatches(queryTokens, collapsedFull);
      const quality = matchQuality(queryTokens, collapsedFull);
      const exactSegmentMatches = countExactSegmentMatches(
        queryTokens,
        m.model,
      );
      const distance = Math.min(
        levenshteinDistance(query, m.model.toLowerCase()),
        levenshteinDistance(query, fullId.toLowerCase()),
        levenshteinDistance(normalizedQuery, normalizeForSearch(m.model)),
        levenshteinDistance(normalizedQuery, normalizeForSearch(fullId)),
      );
      const containsFullQuery =
        collapsedFull.includes(collapse(query)) ||
        collapsedModel.includes(collapse(query));
      const providerPriority = getProviderPriority(m.provider);

      return {
        model: fullId,
        matchCount,
        exactSegmentMatches,
        quality,
        distance,
        containsFullQuery,
        providerPriority,
      };
    })
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.exactSegmentMatches - a.exactSegmentMatches ||
        b.quality - a.quality ||
        Number(b.containsFullQuery) - Number(a.containsFullQuery) ||
        a.distance - b.distance ||
        a.providerPriority - b.providerPriority ||
        a.model.localeCompare(b.model),
    )
    .map(({ model, distance }) => ({ model, distance }))
    .slice(0, limit);
}

/**
 * Find top model matches by substring relevance and Levenshtein distance.
 *
 * @param modelName - The user's free-form query string
 * @param modelRegistry - Registry providing available models
 * @param limit - Maximum number of results to return
 * @returns Array of { model, distance } sorted by relevance
 */
export function getTopModelMatches(
  modelName: string,
  modelRegistry: ModelRegistryLike,
  limit = 5,
): Array<{ model: string; distance: number }> {
  return getTopModelsFromList(
    getAvailableModels(modelRegistry),
    modelName,
    limit,
  );
}


export default function (pi: ExtensionAPI) {
  // "$"-command completion can list available models before its handler
  // has ever run.
  let subModelRegistry: ModelRegistryLike | null = null;
  // Guards the one-time autocomplete-provider installation for "$" commands.
  let bangModelCompletionsInstalled = false;

  // Resolve the promise the "$" substitute command waits on when the run the
  // substitute prompt started reaches its end. The waiter is installed by the
  // input handler before it sends the prompt, so no agent_end can fire
  // unobserved in between; the agent is idle when the command runs, which
  // makes the next agent_end the turn's end.
  let subRunEndWaiter: (() => void) | null = null;
  pi.on("agent_end", () => {
    const waiter = subRunEndWaiter;
    if (waiter) {
      subRunEndWaiter = null;
      waiter();
      // The substitute run is over. If the trim flag is still armed here, the
      // run ended without a final-answer turn_end (abort, error, retry while
      // trailing tool calls) and the intermediate turns were already trimmed.
      // Disarm now and discard any drafts accumulated so far: the run
      // aborted or errored before settlement, so nothing is trimmed and
      // trimming can never reach turns of a later run or any context that
      // existed before the substitute turn started.
      trimNextTurnToLastMessage = false;
      trimProtectedEntryIds = null;
      pendingTrimTurns = [];
    }
  });

  // For the $$ (double-dollar) command: when this is set, the currently
  // running substitute turn should be trimmed after it finishes so that only
  // its final assistant output stays in session context. The turn_end handler
  // accumulates drafts for each finished tool-calling turn WITHOUT applying
  // them (the substitute model must see its own tool results while it works);
  // the agent_before_settle handler applies the accumulated drafts in one
  // shot once the run is fully done. A run that never settles (abort) keeps
  // its history: agent_end discards the drafts instead.
  let trimNextTurnToLastMessage = false;
  // Entry ids captured when the flag was armed: everything present before the
  // substitute prompt was sent. Drafts never target these ids, so turns that
  // predate the run are structurally untrimmable.
  let trimProtectedEntryIds: ReadonlySet<string> | null = null;
  // Draft-source records collected for turns of the armed run, applied at
  // settle. Kept as raw turn records so retried errors stay armed until the
  // run truly settles, and so dangling errored turns can be trimmed there.
  let pendingTrimTurns: TurnEndTrimEvent[] = [];
  pi.on("turn_end", (event) => {
    if (!trimNextTurnToLastMessage) {
      return;
    }
    // pi fires the turn_end boundary even for the interrupted turn itself,
    // as the run's final boundary. Flush everything then.
    const isAborted = event.outcome === "aborted";
    const anchoredToPreRunEntry =
      trimProtectedEntryIds?.has(event.messageEntryId) ?? false;
    if (!anchoredToPreRunEntry) {
      pendingTrimTurns.push({
        messageEntryId: event.messageEntryId,
        toolResultEntryIds: event.toolResultEntryIds,
        outcome: event.outcome ?? "completed",
      });
    }
    if (isAborted) {
      const entries = buildRunTrimDrafts(
        pendingTrimTurns,
        trimProtectedEntryIds,
      );
      pendingTrimTurns = [];
      trimNextTurnToLastMessage = false;
      trimProtectedEntryIds = null;
      return entries.length > 0 ? { entries } : undefined;
    }
    // No return value: drafts are withheld until the run settles. An errored
    // turn stays buffered because pi may retry it within the same run; the
    // settle boundary fires only after retries conclude.
  });
  pi.on("agent_before_settle", () => {
    if (!trimNextTurnToLastMessage || pendingTrimTurns.length === 0) {
      return;
    }
    const entries = buildRunTrimDrafts(pendingTrimTurns, trimProtectedEntryIds);
    pendingTrimTurns = [];
    trimNextTurnToLastMessage = false;
    trimProtectedEntryIds = null;
    return entries.length > 0 ? { entries } : undefined;
  });


  // Green model-switch notices: pi renders ctx.ui.notify(..., "info") in
  // dim gray, which is easy to miss (and looks like nothing happened). The
  // switch and restore messages instead go through a custom session entry
  // rendered with the theme's success (green) color. Older pi builds lack
  // entry renderers, so the registration is optional and the notice falls
  // back to plain console output.
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<ModelSwitchEntryData>(
      MODEL_SWITCH_ENTRY_TYPE,
      (entry, _options, theme) => {
        const data = entry.data ?? { message: "", timestamp: Date.now() };
        const container = new Container();
        const ts = new Date(data.timestamp)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("success", `✓ ${data.message}`) +
              theme.fg("dim", `  (${ts})`),
            1,
            0,
          ),
        );
        return container;
      },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    subModelRegistry ??= ctx.modelRegistry;
    if (!bangModelCompletionsInstalled) {
      bangModelCompletionsInstalled = true;
      (ctx.ui as EditorUIContext).addAutocompleteProvider?.(
        createBangModelCompletionFactory(() =>
          subModelRegistry ? getAvailableModels(subModelRegistry) : [],
        ),
      );
    }
  });

  pi.on("input", async (event, ctx) => {
    // Only typed input goes through the bang commands. Worker deliveries and
    // other extension-sourced messages flow through this same handler via
    // pi.sendUserMessage, and a report that happens to start with
    // "$<model> <prompt>" must reach the lead as ordinary text.
    if (event.source !== "interactive") {
      return { action: "continue" };
    }
    const parsed = parseBangModelCommand(event.text);
    if (!parsed) {
      return { action: "continue" };
    }
    subModelRegistry ??= ctx.modelRegistry;
    const args = `${parsed.modelRequest} ${parsed.prompt}`;
    await runSubCommand(args, ctx, parsed.kind === "sub-trimmed");
    return { action: "handled" };
  });

  /**
   * Handle "$<model> <prompt...>" (and "$$<model> <prompt...>"): switch to
   * a fuzzy-matched substitute model for exactly one turn, run the prompt,
   * and restore the original model afterwards. With `trimToLastTurn` ($$
   * double-dollar), the session is then trimmed to keep only the agent's
   * final output, dropping all the tool calls and intermediate results.
   *
   * @param args - Raw argument string: "<model name> <prompt...>"
   * @param ctx - Command context for the current session
   * @param trimToLastTurn - Whether to keep only the agent's final turn output
   */
  async function runSubCommand(
    args: string,
    ctx: ExtensionContext,
    trimToLastTurn = false,
  ): Promise<void> {
    const parsed = parseSubCommandArgs(args);
    if (!parsed) {
      instaNotify(
        ctx,
        `Usage: ${trimToLastTurn ? "$$" : "$"}<model name> <prompt...>`,
        "error",
      );
      return;
    }
    if (!ctx.isIdle()) {
      instaNotify(
        ctx,
        "$ needs an idle agent; wait for the current run to finish.",
        "error",
      );
      return;
    }
    const original = ctx.model;
    if (!original) {
      instaNotify(ctx, "No model is active in this session.", "error");
      return;
    }
    // Armed before the prompt is sent: the agent is idle, so the next
    // agent_end event marks the end of the substitute turn.
    const subTurnRunEndPromise = new Promise<void>((resolve) => {
      subRunEndWaiter = resolve;
    });
    // For $$ (trimToLastTurn), arm the turn-end trim so only the agent's
    // final output stays in context; tool calls and results are dropped.
    // Also snapshot every entry id that exists right now: the trim drafts
    // must never target entries that predate this run.
    if (trimToLastTurn) {
      trimNextTurnToLastMessage = true;
      trimProtectedEntryIds = new Set(
        ctx.sessionManager.getEntries().map((entry) => entry.id),
      );
    }
    await executeSubTurn(
      {
        originalModel: { provider: original.provider, model: original.id },
        resolve: (modelRequest) => {
          const full = resolveModelWithProvider(
            modelRequest,
            ctx.modelRegistry,
          );
          if (!full) {
            return null;
          }
          const slashIndex = full.indexOf("/");
          const found = ctx.modelRegistry.find(
            full.slice(0, slashIndex),
            full.slice(slashIndex + 1),
          );
          return found ? { provider: found.provider, model: found.id } : null;
        },
        setModel: async (ref) => {
          const found = ctx.modelRegistry.find(ref.provider, ref.model);
          if (!found) {
            return false;
          }
          return pi.setModel(found);
        },
        runPrompt: (prompt) => {
          pi.sendUserMessage(prompt);
          return Promise.resolve();
        },
        // ctx.waitForIdle() would resolve immediately here: the prompt is
        // queued asynchronously and the agent is still idle when it is
        // called. Instead, wait for the run this prompt starts to end via
        // the persistent agent_end listener. The guard above ensures the
        // agent was idle, so the next agent_end belongs to this turn. The
        // waiter was installed before runPrompt, so no agent_end can slip
        // past it.
        waitForIdle: () => subTurnRunEndPromise,
        notify: (message, level) =>
          level === "success"
            ? notifyModelSwitch(ctx, message)
            : instaNotify(ctx, message, level),
      },
      parsed.modelRequest,
      parsed.prompt,
    );
  }

  /**
   * Show a command notification in UI sessions; log to the console in
   * print-like sessions where ctx.ui.notify does nothing.
   *
   * @param ctx - Command context with the UI availability flag
   * @param message - The message to show or log
   * @param level - Notification level
   */
  function instaNotify(
    ctx: ExtensionContext,
    message: string,
    level: "info" | "error",
  ): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    } else {
      (level === "error" ? console.error : console.log)(message);
    }
  }


  /** Show a green model-switch notice: a themed session entry in UI
   * sessions, a plain console line in print-like sessions.
   *
   * @param ctx - Command context with the UI availability flag
   * @param message - The message to show or log
   */
  function notifyModelSwitch(ctx: ExtensionContext, message: string): void {
    if (!ctx.hasUI || typeof (pi as ExtensionAPI).appendEntry !== "function") {
      console.log(message);
      return;
    }
    pi.appendEntry<ModelSwitchEntryData>(MODEL_SWITCH_ENTRY_TYPE, {
      message,
      timestamp: Date.now(),
    });
  }
}
