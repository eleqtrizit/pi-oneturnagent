# pi-oneturnagent

One-turn model substitution for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

- **`$<model> <prompt>`** — switch the session to a fuzzy-matched substitute model, run exactly one turn with your prompt, then restore the original model. The original model is restored even on error or abort (restoration runs in a `finally` block).
- **`$$<model> <prompt>`** — the same one-turn substitution, but afterwards the session is trimmed so **only the agent's final output stays in context**: tool calls, tool results, and intermediate assistant turns are dropped via `context_edit` entries emitted from the `turn_end` handler. Carry the answer forward without the noise.
- Three or more dollars (`$$$...`) is ordinary text, as are dollar amounts like `$100 budget note` — anything that does not parse as a model command flows through untouched.

While typing, an autocomplete provider offers model completions after `$` and `$$` (the editor opens the popup on the `$` trigger character).

## Model resolution

Bare model names resolve through a priority ladder (each group falls back to the next only when empty):

1. **Flavored models** — the `enabledModelsHigh` / `enabledModelsMed` / `enabledModelsFast` lists from pi's `settings.json`
2. **Scoped models** — pi's `--models` flag patterns, or the `enabledModels` list when the flag is absent
3. **The full registry** — every model pi has available

Provider-prefixed requests (`openai/gpt-5`) resolve strictly within the named provider and never fall back to another provider. Fuzzy matching supports composite tokens (`qwen35b` → `Qwen35Coder-35B`), partial names (`haiku`), Levenshtein distance, and provider priority (OAuth/subscription providers first).

## Install

```bash
npm install
```

Requires pi ≥ 0.99.1 (`@earendil-works/pi-coding-agent` peer). The `$$` trim relies on the `turn_end` boundary-draft API introduced after 0.84.

## Test

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

## How the `$$` trim works

A pi extension command handler cannot mutate session history (`ctx.sessionManager` is a `ReadonlySessionManager`). Trimming therefore runs through the supported boundary-event path: `runSubCommand` arms a `trimNextTurnToLastMessage` flag before the substitute turn's prompt is sent, and a `turn_end` handler returns `context_edit` draft entries (`replacement: null`) that omit each intermediate tool-calling turn's assistant message and tool results from model context. A turn with no tool results is the final answer: it is kept and the flag disarms. See `buildTrimToLastTurnDrafts` in `extensions/index.ts`.

## Files

```
extensions/index.ts   The extension: parsing, one-turn execution, trim, autocomplete, entry renderer
extensions/index.test.ts
src/utils/flavoredModels.ts   Flavor-categorized model-list I/O for the resolution ladder
```
