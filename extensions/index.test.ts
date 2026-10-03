import { describe, expect, it, beforeEach, vi } from "vitest";
import {
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
  type SubTurnDeps,
} from "./index";

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
