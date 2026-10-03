import { describe, expect, it, beforeEach, vi } from "vitest";
import extension, {
  completeModelArg,
  createBangModelCompletionFactory,
  getTopModelMatches,
  parseBangModelCommand,
  clearModelsCache,
  resolveModelWithProvider,
  scopedPatternMatches,
  executeSubTurn,
  parseSubCommandArgs,
  buildTrimToLastTurnDrafts,
  buildRunTrimDrafts,
  type SubTurnDeps,
  type TurnEndTrimEvent,
} from "./index";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("buildTrimToLastTurnDrafts", () => {
  it("returns null for the final answer turn (no tool results)", () => {
    expect(
      buildTrimToLastTurnDrafts({ messageEntryId: "a1", toolResultEntryIds: [] }),
    ).toBeNull();
  });

  it("omits the assistant message and its tool results for a tool-calling turn", () => {
    expect(
      buildTrimToLastTurnDrafts({
        messageEntryId: "a1",
        toolResultEntryIds: ["t1", "t2"],
      }),
    ).toEqual([
      { type: "context_edit", targetId: "a1", replacement: null },
      { type: "context_edit", targetId: "t1", replacement: null },
      { type: "context_edit", targetId: "t2", replacement: null },
    ]);
  });

  it("filters protected entry ids out of the drafts", () => {
    expect(
      buildTrimToLastTurnDrafts(
        { messageEntryId: "a1", toolResultEntryIds: ["t1", "old"] },
        new Set(["old"]),
      ),
    ).toEqual([
      { type: "context_edit", targetId: "a1", replacement: null },
      { type: "context_edit", targetId: "t1", replacement: null },
    ]);
  });

  it("voids the drafts when the turn's assistant entry is protected", () => {
    expect(
      buildTrimToLastTurnDrafts(
        { messageEntryId: "old", toolResultEntryIds: ["t1"] },
        new Set(["old"]),
      ),
    ).toBeNull();
  });
});

describe("buildRunTrimDrafts", () => {
  const ctxEdit = (targetId: string) => ({
    type: "context_edit" as const,
    targetId,
    replacement: null,
  });

  it("returns nothing for an empty turn list", () => {
    expect(buildRunTrimDrafts([])).toEqual([]);
  });

  it("trims tool turns entirely and keeps completed final answers", () => {
    const turns: TurnEndTrimEvent[] = [
      { messageEntryId: "a1", toolResultEntryIds: ["t1"], outcome: "completed" },
      { messageEntryId: "a2", toolResultEntryIds: [], outcome: "completed" },
    ];
    expect(buildRunTrimDrafts(turns)).toEqual([ctxEdit("a1"), ctxEdit("t1")]);
  });

  it("treats a missing outcome as completed (older pi builds)", () => {
    const turns: TurnEndTrimEvent[] = [
      { messageEntryId: "a1", toolResultEntryIds: ["t1"] },
      { messageEntryId: "a2", toolResultEntryIds: [] },
    ];
    expect(buildRunTrimDrafts(turns)).toEqual([ctxEdit("a1"), ctxEdit("t1")]);
  });

  it("trims the dangling assistant message of aborted and errored turns", () => {
    const turns: TurnEndTrimEvent[] = [
      { messageEntryId: "a1", toolResultEntryIds: [], outcome: "aborted" },
      { messageEntryId: "a2", toolResultEntryIds: [], outcome: "error" },
      { messageEntryId: "a3", toolResultEntryIds: [], outcome: "completed" },
    ];
    expect(buildRunTrimDrafts(turns)).toEqual([
      ctxEdit("a1"),
      ctxEdit("a2"),
    ]);
  });

  it("trims tool results of an aborted turn that already ran tools", () => {
    const turns: TurnEndTrimEvent[] = [
      { messageEntryId: "a1", toolResultEntryIds: ["t1"], outcome: "aborted" },
    ];
    expect(buildRunTrimDrafts(turns)).toEqual([ctxEdit("a1"), ctxEdit("t1")]);
  });

  it("trims tool results of an errored turn alongside its message at settle", () => {
    const turns: TurnEndTrimEvent[] = [
      { messageEntryId: "a1", toolResultEntryIds: ["t1"], outcome: "error" },
    ];
    expect(buildRunTrimDrafts(turns)).toEqual([ctxEdit("a1"), ctxEdit("t1")]);
  });

  it("ignores turns anchored to protected entries and filters protected tool results", () => {
    const turns: TurnEndTrimEvent[] = [
      { messageEntryId: "old", toolResultEntryIds: ["t0"], outcome: "completed" },
      { messageEntryId: "a1", toolResultEntryIds: ["old", "t1"], outcome: "completed" },
      { messageEntryId: "a2", toolResultEntryIds: [], outcome: "aborted" },
    ];
    expect(
      buildRunTrimDrafts(turns, new Set(["old"])),
    ).toEqual([ctxEdit("a1"), ctxEdit("t1"), ctxEdit("a2")]);
  });
});

describe("getTopModelMatches", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  it('returns qwen3-coder-480b for "qwen 480b" queries', () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "abuntu", id: "Qwen35Coder-122B" },
        { provider: "abuntu", id: "qwen3-coder-480b" },
        { provider: "openai", id: "o1" },
        { provider: "openai", id: "o3" },
        { provider: "openrouter", id: "openai/o1" },
        { provider: "openrouter", id: "openai/o3" },
        { provider: "openrouter", id: "qwen/qwq-32b" },
        { provider: "openrouter", id: "qwen/qwen3-coder-480b" },
      ],
    };

    const matches = getTopModelMatches("qwen 480b", modelRegistry, 5);
    const models = matches.map((match) => match.model);

    expect(models[0]).toBe("abuntu/qwen3-coder-480b");
    expect(models).toContain("abuntu/qwen3-coder-480b");
    expect(models).toContain("openrouter/qwen/qwen3-coder-480b");
    expect(models.indexOf("openrouter/qwen/qwen3-coder-480b")).toBeLessThan(
      models.indexOf("openrouter/qwen/qwq-32b"),
    );
  });

  describe("bighank/Qwen35Coder-35B-NoThinking matching", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "bighank", id: "Qwen35Coder-35B-NoThinking" },
        { provider: "bighank", id: "Qwen35Coder-122B" },
        { provider: "openrouter", id: "qwen/qwen3-coder-480b" },
        { provider: "abuntu", id: "some-other-model" },
      ],
    };

    it('returns bighank/Qwen35Coder-35B-NoThinking for "bighank qwen3 35b"', () => {
      const matches = getTopModelMatches("bighank qwen3 35b", modelRegistry, 5);
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });

    it('returns bighank/Qwen35Coder-35B-NoThinking for "bighank qwen 35b"', () => {
      const matches = getTopModelMatches("bighank qwen 35b", modelRegistry, 5);
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });

    it('returns bighank/Qwen35Coder-35B-NoThinking for "qwen35b on bighank"', () => {
      const matches = getTopModelMatches(
        "qwen35b on bighank",
        modelRegistry,
        5,
      );
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });

    it('returns bighank/Qwen35Coder-35B-NoThinking for "qwen 35b bighank"', () => {
      const matches = getTopModelMatches("qwen 35b bighank", modelRegistry, 5);
      expect(matches[0].model).toBe("bighank/Qwen35Coder-35B-NoThinking");
    });
  });
});

describe("resolveModelWithProvider", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  it("returns null when provider prefix is specified but provider not in registry", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "openrouter", id: "qwen3coder-35b" },
        { provider: "abuntu", id: "qwen3-coder-480b" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "bighank/qwen3coder-35b",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBeNull();
  });

  it('resolves "bighank/Qwen35 35b" to bighank/qwen3coder-35b via composite token matching', () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "bighank", id: "qwen3coder-35b" },
        { provider: "bighank", id: "Qwen35Coder-122B" },
        { provider: "openrouter", id: "qwen/qwen3-coder-480b" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "bighank/Qwen35 35b",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBe("bighank/qwen3coder-35b");
  });

  it("returns as-is when provider/model exists in registry", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "bighank", id: "qwen3coder-35b" },
        { provider: "openrouter", id: "qwen3coder-35b" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "bighank/qwen3coder-35b",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBe("bighank/qwen3coder-35b");
  });

  it("exact-matches a model id that contains slashes", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "inference", id: "aws/anthropic/bedrock-claude-sonnet-5-5" },
        { provider: "spark", id: "spark/model" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "inference/aws/anthropic/bedrock-claude-sonnet-5-5",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBe("inference/aws/anthropic/bedrock-claude-sonnet-5-5");
  });

  it("returns null when a multi-slash model id is missing from the named provider", () => {
    const modelRegistry = {
      getAvailable: () => [
        { provider: "inference", id: "aws/anthropic/bedrock-claude-sonnet-5-5" },
        { provider: "spark", id: "spark/model" },
      ],
    };
    const resolved = resolveModelWithProvider(
      "inference/aws/anthropic/bedrock-claude-sonnet-5-6",
      modelRegistry,
      { flavoredModelIds: [], scopedPatterns: [] },
    );
    expect(resolved).toBeNull();
  });
});

describe("resolveModelWithProvider resolution ladder", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  const registry = {
    getAvailable: () => [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "bighank", id: "Qwen35Coder-35B" },
      { provider: "openai", id: "gpt-5" },
    ],
  };

  it("returns a flavored model even when the request names a non-flavored model", () => {
    const resolved = resolveModelWithProvider("Qwen35Coder-35B", registry, {
      flavoredModelIds: ["anthropic/claude-sonnet-4-5"],
      scopedPatterns: [],
    });
    expect(resolved).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns a scoped model when no flavored models are set", () => {
    const resolved = resolveModelWithProvider("gpt-5", registry, {
      flavoredModelIds: [],
      scopedPatterns: ["bighank/*"],
    });
    expect(resolved).toBe("bighank/Qwen35Coder-35B");
  });

  it("fuzzy-matches the entire registry when neither group is set", () => {
    const resolved = resolveModelWithProvider("gpt5", registry, {
      flavoredModelIds: [],
      scopedPatterns: [],
    });
    expect(resolved).toBe("openai/gpt-5");
  });
});

describe("scopedPatternMatches", () => {
  const entry = { provider: "github-copilot", model: "gpt-4o" };

  it("matches provider-prefixed patterns case-insensitively", () => {
    expect(scopedPatternMatches("github-copilot/gpt-4o", entry)).toBe(true);
    expect(scopedPatternMatches("GITHUB-COPILOT/GPT-4O", entry)).toBe(true);
    expect(scopedPatternMatches("openai/gpt-4o", entry)).toBe(false);
  });

  it("supports * and ? globs against the pair and the bare id", () => {
    expect(scopedPatternMatches("github-copilot/*", entry)).toBe(true);
    expect(scopedPatternMatches("*gpt-4o", entry)).toBe(true);
    expect(scopedPatternMatches("github-copilot/gpt-?o", entry)).toBe(true);
    expect(scopedPatternMatches("github-copilot/gpt-?x", entry)).toBe(false);
  });

  it("ignores a :thinking-level suffix while matching", () => {
    expect(scopedPatternMatches("github-copilot/gpt-4o:high", entry)).toBe(
      true,
    );
    expect(scopedPatternMatches("github-copilot/gpt-4o:xhigh", entry)).toBe(
      false,
    );
  });
});

describe("completeModelArg", () => {
  const models = [
    { provider: "anthropic", model: "claude-opus-4" },
    { provider: "anthropic", model: "claude-sonnet-4.5" },
    { provider: "openai", model: "gpt-5" },
  ];

  it("completes by model name substring", () => {
    expect(completeModelArg("opus", models)).toEqual([
      { label: "anthropic/claude-opus-4", value: "anthropic/claude-opus-4" },
    ]);
  });

  it("completes by provider substring", () => {
    expect(completeModelArg("anth", models)).toHaveLength(2);
  });

  it("narrowers by provider prefix before the slash", () => {
    expect(completeModelArg("openai/g", models)).toEqual([
      { label: "openai/gpt-5", value: "openai/gpt-5" },
    ]);
  });

  it("matches provider and model case-insensitively", () => {
    expect(completeModelArg("OpenAI/GPT", models)).toEqual([
      { label: "openai/gpt-5", value: "openai/gpt-5" },
    ]);
  });

  it("offers every model for an empty prefix", () => {
    expect(completeModelArg("", models)).toHaveLength(3);
  });

  it("suppresses completions once the prompt is being typed", () => {
    expect(completeModelArg("opus write a haiku", models)).toBeNull();
    expect(completeModelArg("openai/gpt-5 do the thing", models)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(completeModelArg("_nomatch", models)).toBeNull();
    expect(completeModelArg("nothing/gpt", models)).toBeNull();
  });

  it("caps the entry count at maxItems", () => {
    expect(completeModelArg("", models, 2)).toHaveLength(2);
  });
});

describe("parseBangModelCommand", () => {
  it("maps one dollar to the substitute-turn command", () => {
    expect(parseBangModelCommand("$opus-4 write a haiku")).toEqual({
      kind: "sub",
      modelRequest: "opus-4",
      prompt: "write a haiku",
    });
  });

  it("maps two dollars to the trimmed substitute-turn command", () => {
    expect(parseBangModelCommand("$$openai/gpt-5 do the thing")).toEqual({
      kind: "sub-trimmed",
      modelRequest: "openai/gpt-5",
      prompt: "do the thing",
    });
  });

  it("treats three dollars as ordinary text (read-only worker removed)", () => {
    expect(parseBangModelCommand("$$$nemotron audit the schema")).toBeNull();
  });

  it("leaves dollar amounts as ordinary text", () => {
    expect(parseBangModelCommand("$100 budget note")).toBeNull();
    expect(parseBangModelCommand("$$100 total")).toBeNull();
  });

  it("rejects missing or blank prompts", () => {
    expect(parseBangModelCommand("$opus-4")).toBeNull();
    expect(parseBangModelCommand("$opus-4   ")).toBeNull();
  });

  it("rejects missing model tokens", () => {
    expect(parseBangModelCommand("$ write a haiku")).toBeNull();
  });

  it("treats four or more dollars as ordinary text", () => {
    expect(parseBangModelCommand("$$$$$ money money money")).toBeNull();
  });
});

describe("createBangModelCompletionFactory", () => {
  const models = [
    { provider: "anthropic", model: "claude-opus-4" },
    { provider: "openai", model: "gpt-5" },
  ];

  function makeCurrent() {
    return {
      getSuggestions: vi.fn().mockResolvedValue(null),
      applyCompletion: vi.fn(),
    };
  }

  function suggestionsFor(
    provider: ReturnType<typeof makeCurrent>,
    typed: string,
  ) {
    const wrapped = createBangModelCompletionFactory(() => models)(provider);
    return wrapped.getSuggestions([typed], 0, typed.length, {
      signal: new AbortController().signal,
    });
  }

  it("offers models with the dollar prefix retained in values", async () => {
    const provider = makeCurrent();
    const result = await suggestionsFor(provider, "$op");
    expect(result?.prefix).toBe("$op");
    expect(result?.items[0].value).toBe("$anthropic/claude-opus-4 ");
    expect(provider.getSuggestions).not.toHaveBeenCalled();
  });

  it("keeps two dollar prefixes intact and treats three as text", async () => {
    await expect(suggestionsFor(makeCurrent(), "$$gpt")).resolves.toMatchObject(
      {
        items: [{ value: "$$openai/gpt-5 " }],
      },
    );
    // Three dollars no longer opens completions; it passes through to the
    // wrapped provider (which here resolves null).
    await expect(suggestionsFor(makeCurrent(), "$$$gpt")).resolves.toBeNull();
  });

  it("falls through to the wrapped provider for other text", async () => {
    const provider = makeCurrent();
    const result = await suggestionsFor(provider, "plain message");
    expect(result).toBeNull();
    expect(provider.getSuggestions).toHaveBeenCalled();
  });

  it("declares $ as a trigger character so the editor opens the popup", () => {
    const wrapped = createBangModelCompletionFactory(() => models)(
      makeCurrent(),
    );
    expect(wrapped.triggerCharacters).toEqual(["$"]);
  });

  it("suppresses completions once the prompt has started", async () => {
    expect(
      await suggestionsFor(makeCurrent(), "$opus-4 write a haiku"),
    ).toBeNull();
  });
});


describe("parseSubCommandArgs", () => {
  it("splits the model request from the prompt", () => {
    expect(
      parseSubCommandArgs("opus-4 write a haiku about queues"),
    ).toEqual({
      modelRequest: "opus-4",
      prompt: "write a haiku about queues",
    });
  });

  it("keeps extra whitespace out of the prompt", () => {
    expect(parseSubCommandArgs("  gpt-5    do the thing  ")).toEqual({
      modelRequest: "gpt-5",
      prompt: "do the thing",
    });
  });

  it("rejects input without a prompt", () => {
    expect(parseSubCommandArgs("opus-4")).toBeNull();
    expect(parseSubCommandArgs("   ")).toBeNull();
    expect(parseSubCommandArgs("")).toBeNull();
  });
});

describe("runSubCommand trim harness (default export wiring)", () => {
  function makeHarness(overrides: Record<string, unknown> = {}) {
    const events: Record<
      string,
      Array<(event: unknown, ctx: unknown) => unknown>
    > = {};

    const pi = {
      on: (type: string, handler: (event: unknown) => unknown) => {
        (events[type] ??= []).push(handler);
      },
      setModel: async () => true,
      sendUserMessage: () => {},
      appendEntry: () => {},
    };

    const ctx = {
      modelRegistry: {
        getAvailable: () => [{ provider: "openai", id: "gpt-5" }],
        find: (provider: string, model: string) => ({ provider, id: model }),
      },
      isIdle: () => true,
      model: { provider: "anthropic", id: "claude-opus-4" },
      hasUI: false,
      ui: { notify: () => {} },
      sessionManager: { getEntries: () => [] },
      ...overrides,
    };

    extension(pi as unknown as ExtensionAPI);

    function emit(
      type: string,
      event: Record<string, unknown>,
    ): Promise<unknown[]> {
      return Promise.all(
        (events[type] ?? []).map((handler) => handler(event, ctx)),
      );
    }

    return {
      emit,
      run: (text: string) =>
        emit("input", { text, source: "interactive" }),
    };
  }

  it("applies the trim once at settle, after the run has finished", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    // While the run works, finished tool turns are only buffered: the model
    // keeps seeing its own tool results.
    const intermediate = await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });
    expect(intermediate.every((result) => result === undefined)).toBe(true);

    const second = await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: ["t2"],
      outcome: "completed",
    });
    expect(second.every((result) => result === undefined)).toBe(true);

    // The final answer turn is kept (no draft for it).
    await emit("turn_end", {
      messageEntryId: "a3",
      toolResultEntryIds: [],
      outcome: "completed",
    });

    // At settle the whole run's cleanup is applied in one shot.
    const settle = await emit("agent_before_settle", {});
    expect(settle).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
        { type: "context_edit", targetId: "a2", replacement: null },
        { type: "context_edit", targetId: "t2", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;

    // After the run (and its settle) the trim is fully disarmed: a later
    // turn_end is never trimmed.
    const later = await emit("turn_end", {
      messageEntryId: "a4",
      toolResultEntryIds: ["t4"],
    });
    expect(later).not.toContainEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ targetId: "a4" }),
        ]),
      }),
    );
  });

  it("flushes the whole run's cleanup at the aborted turn itself", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    // One intermediate turn completes and buffers its draft.
    const buffered = await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });
    expect(buffered.every((result) => result === undefined)).toBe(true);

    // You interrupt: the cut-off turn fires its own turn_end with outcome
    // "aborted" and no tool results. All buffered drafts flush right there,
    // plus the cut-off assistant message, and the trim disarms.
    const aborted = await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: [],
      outcome: "aborted",
    });
    expect(aborted).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
        { type: "context_edit", targetId: "a2", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;

    // Nothing further is trimmed: a later run's turns are untouched.
    const later = await emit("turn_end", {
      messageEntryId: "a3",
      toolResultEntryIds: ["t3"],
      outcome: "completed",
    });
    expect(later.every((result) => result === undefined)).toBe(true);
  });

  it("keeps a turn when no trim was armed", async () => {
    const { emit } = makeHarness();
    const results = await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
    });
    expect(results.every((result) => result === undefined)).toBe(true);
  });

  it("trims an errored run at settle, keeping the model armed through retries", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });

    // The provider errors on the next turn. pi may retry within the run, so
    // nothing flushes here.
    const failed = await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: [],
      outcome: "error",
    });
    expect(failed.every((result) => result === undefined)).toBe(true);

    // The run settles (retries exhausted): everything buffers flushes, and
    // the failed turn's dangling message is trimmed with the rest.
    const settle = await emit("agent_before_settle", {});
    expect(settle).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
        { type: "context_edit", targetId: "a2", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;
  });

  it("stays armed through retries and trims the whole run at settle", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });

    // A retryable error buffers but does not flush or disarm.
    await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: [],
      outcome: "error",
    });

    // pi retries: the retry's turns are trimmed like any other.
    await emit("turn_end", {
      messageEntryId: "a3",
      toolResultEntryIds: ["t3"],
      outcome: "completed",
    });

    // Final answer.
    await emit("turn_end", {
      messageEntryId: "a4",
      toolResultEntryIds: [],
      outcome: "completed",
    });

    const settle = await emit("agent_before_settle", {});
    expect(settle).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
        { type: "context_edit", targetId: "a2", replacement: null },
        { type: "context_edit", targetId: "a3", replacement: null },
        { type: "context_edit", targetId: "t3", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;
  });

  it("never trims entries that existed before the run started", async () => {
    const { emit, run } = makeHarness({
      sessionManager: {
        getEntries: () => [{ id: "old" } as { id: string }],
      },
    });
    const runPromise = run("$$gpt-5 do the thing");

    // A turn_end somehow anchored to a pre-run entry: the draft is voided.
    const anchored = await emit("turn_end", {
      messageEntryId: "old",
      toolResultEntryIds: ["t1"],
    });
    expect(anchored.every((result) => result === undefined)).toBe(true);

    // A run turn that references a pre-run tool-result id: only the run's
    // own entries appear in the drafts. The drafts are withheld at turn_end
    // and become visible only at settle.
    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["old", "t1"],
    });
    const settle = await emit("agent_before_settle", {});
    expect(settle).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;
  });

  it("trims nothing when the run is one answer with no tool calls", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 write a haiku");

    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: [],
      outcome: "completed",
    });
    const settle = await emit("agent_before_settle", {});
    expect(settle.every((result) => result === undefined)).toBe(true);

    await emit("agent_end", {});
    await runPromise;
  });

  it("trims only the cut-off message when you interrupt during the first turn", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    const aborted = await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: [],
      outcome: "aborted",
    });
    expect(aborted).toContainEqual({
      entries: [{ type: "context_edit", targetId: "a1", replacement: null }],
    });

    await emit("agent_end", {});
    await runPromise;

    const later = await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: ["t2"],
      outcome: "completed",
    });
    expect(later.every((result) => result === undefined)).toBe(true);
  });

  it("includes an aborted tool turn's results in the flush", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });
    // The second turn's tools finished running, then the user interrupts
    // before the next model request.
    const aborted = await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: ["t2"],
      outcome: "aborted",
    });
    expect(aborted).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
        { type: "context_edit", targetId: "a2", replacement: null },
        { type: "context_edit", targetId: "t2", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;
  });

  it("discards buffered drafts in the agent_end fallback and disarms", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    // A completed turn buffered, then the run ends without a settle boundary
    // or an abort boundary (pathological pi behavior). The fallback discards
    // the buffer rather than trimming something half-applied.
    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });
    await emit("agent_end", {});
    await runPromise;

    const later = await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: ["t2"],
      outcome: "completed",
    });
    expect(later.every((result) => result === undefined)).toBe(true);
  });

  it("trims each run's own turns across two successive $$ commands", async () => {
    const { emit, run } = makeHarness();
    const firstRun = run("$$gpt-5 do the thing");

    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });
    await emit("agent_before_settle", {});
    await emit("agent_end", {});
    await firstRun;

    // Second run: the first run's leftovers are now pre-run entries and the
    // second run's own turns trim normally.
    const secondRun = run("$$gpt-5 do it again");
    await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: ["t2"],
      outcome: "completed",
    });
    const settle = await emit("agent_before_settle", {});
    expect(settle).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a2", replacement: null },
        { type: "context_edit", targetId: "t2", replacement: null },
      ],
    });
    await emit("agent_end", {});
    await secondRun;
  });

  it("disarms on abort even when the cut-off turn belongs to a pre-run entry", async () => {
    const { emit, run } = makeHarness({
      sessionManager: {
        getEntries: () => [{ id: "old" } as { id: string }],
      },
    });
    const runPromise = run("$$gpt-5 do the thing");

    // Pathological: pi anchors the aborted turn to a pre-run entry. Nothing
    // is buffered for it, but the run is over and the trim disarms cleanly.
    const aborted = await emit("turn_end", {
      messageEntryId: "old",
      toolResultEntryIds: [],
      outcome: "aborted",
    });
    expect(aborted.every((result) => result === undefined)).toBe(true);

    await emit("agent_end", {});
    await runPromise;

    const later = await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
      outcome: "completed",
    });
    expect(later.every((result) => result === undefined)).toBe(true);
  });

  it("treats a turn_end without an outcome field as completed", async () => {
    const { emit, run } = makeHarness();
    const runPromise = run("$$gpt-5 do the thing");

    // Older pi builds omit outcome: tool turns still trim at settle, and a
    // no-tool-results turn counts as the final answer.
    await emit("turn_end", {
      messageEntryId: "a1",
      toolResultEntryIds: ["t1"],
    });
    await emit("turn_end", {
      messageEntryId: "a2",
      toolResultEntryIds: [],
    });
    const settle = await emit("agent_before_settle", {});
    expect(settle).toContainEqual({
      entries: [
        { type: "context_edit", targetId: "a1", replacement: null },
        { type: "context_edit", targetId: "t1", replacement: null },
      ],
    });

    await emit("agent_end", {});
    await runPromise;
  });
});

describe("executeSubTurn", () => {
  const originalModel = { provider: "anthropic", model: "claude-opus-4" };

  function makeDeps(
    overrides: Partial<SubTurnDeps> = {},
  ): SubTurnDeps & {
    setModelCalls: Array<{ provider: string; model: string }>;
  } {
    const setModelCalls: Array<{ provider: string; model: string }> = [];
    const deps: SubTurnDeps = {
      originalModel,
      resolve: () => ({ provider: "openai", model: "gpt-5" }),
      setModel: async (ref) => {
        setModelCalls.push(ref);
        return true;
      },
      runPrompt: async () => {},
      waitForIdle: async () => {},
      notify: () => {},
      ...overrides,
    };
    return { ...deps, setModelCalls };
  }

  it("switches to the substitute, runs the prompt, then restores", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      setModel: async (ref) => {
        order.push(`set:${ref.model}`);
        return true;
      },
      runPrompt: async () => {
        order.push("prompt");
      },
      waitForIdle: async () => {
        order.push("idle");
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(order).toEqual(["set:gpt-5", "prompt", "idle", "set:claude-opus-4"]);
  });

  it("aborts without switching when resolution fails", async () => {
    const deps = makeDeps({
      resolve: () => null,
      runPrompt: async () => {
        throw new Error("prompt must not run");
      },
    });
    await executeSubTurn(deps, "nonexistent", "do the thing");
    expect(deps.setModelCalls).toEqual([]);
  });

  it("aborts without prompting when the provider is not authenticated", async () => {
    const setModelCalls: Array<{ provider: string; model: string }> = [];
    const deps = makeDeps({
      setModel: async (ref) => {
        setModelCalls.push(ref);
        return false;
      },
      runPrompt: async () => {
        throw new Error("prompt must not run");
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(setModelCalls).toEqual([{ provider: "openai", model: "gpt-5" }]);
  });

  it("restores the original model when the prompt run throws", async () => {
    const deps = makeDeps({
      runPrompt: async () => {
        throw new Error("model exploded");
      },
    });
    await expect(
      executeSubTurn(deps, "gpt-5", "do the thing"),
    ).rejects.toThrow("model exploded");
    expect(deps.setModelCalls).toEqual([
      { provider: "openai", model: "gpt-5" },
      { provider: "anthropic", model: "claude-opus-4" },
    ]);
  });

  it("notifies on each phase", async () => {
    const notifications: Array<{ message: string; level: string }> = [];
    const deps = makeDeps({
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(notifications.map((n) => n.level)).toEqual([
      "success",
      "success",
    ]);
    expect(notifications[1].message).toContain("claude-opus-4");
  });

  it("reports errors without prompting when setModel throws", async () => {
    const notifications: Array<{ message: string; level: string }> = [];
    const deps = makeDeps({
      setModel: async () => {
        throw new Error("registry exploded");
      },
      runPrompt: async () => {
        throw new Error("prompt must not run");
      },
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(notifications).toEqual([
      { level: "error", message: expect.stringContaining("registry exploded") },
    ]);
  });

  it("restores the original model when the restore switch throws", async () => {
    const setModelCalls: string[] = [];
    const deps = makeDeps({
      setModel: async (ref) => {
        setModelCalls.push(ref.model);
        if (ref.model === "claude-opus-4") {
          throw new Error("restore blew up");
        }
        return true;
      },
    });
    await executeSubTurn(deps, "gpt-5", "do the thing");
    expect(setModelCalls).toEqual(["gpt-5", "claude-opus-4"]);
  });
});
