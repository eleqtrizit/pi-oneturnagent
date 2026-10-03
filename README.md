# pi-oneturnagent

**One-turn model substitution for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).**

- **`$<model> <prompt>`** — switch the session to a fuzzy-matched substitute model, run exactly one turn with your prompt, then restore the original model. The original model is restored even on error or abort (restoration runs in a `finally` block).
- **`$$<model> <prompt>`** — the same one-turn substitution, but afterwards the session is trimmed so **only the agent's final output stays in context**: tool calls, tool results, and intermediate assistant turns are dropped via `context_edit` entries emitted from the `turn_end` handler. Carry the answer forward without the noise.
- Three or more dollars (`$$$...`) is ordinary text, as are dollar amounts like `$100 budget note` — anything that does not parse as a model command flows through untouched.

While typing, an autocomplete provider offers model completions after `$` and `$$` (the editor opens the popup on the `$` trigger character).

## Quickstart

```bash
pi install https://github.com/eleqtrizit/pi-oneturnagent
```

Requires pi ≥ 0.99.1 (`@earendil-works/pi-coding-agent` peer). The `$$` trim relies on the `turn_end` boundary-draft API introduced after 0.84.

## Quick Start

Use simple phrasing in the chat window to run one turn with a different model:

```
$opus write a haiku about queues
```

```
$claude-3.5 review the auth module and list any security concerns
```

```
$openai/gpt-5 refactor the parsing code in src/utils/paths.ts
```

Use `$$` when you want only the final answer kept in context (tool calls trimmed):

```
$$qwen3-coder find all TODOs in the repo and propose fixes
```

```
$$gpt-5 audit the schema and report breaking changes
```

Bare model names resolve automatically — `haiku`, `qwen35b`, `claude-3.5` all match through the same fuzzy matching as `resolve_model`, with autocomplete while typing.

## Model Resolution

Bare model names walk a priority ladder (each group falls back to the next only when empty):

- **Flavored models** - the `enabledModelsHigh` / `enabledModelsMed` / `enabledModelsFast` lists from pi's settings.json
- **Scoped models** - pi's `--models` flag patterns, or the `enabledModels` list when the flag is absent
- **The full registry** - every model pi has available

- Provider-prefixed requests (`openai/gpt-5`) resolve strictly within the named provider and never fall back to another provider
- Smart fuzzy matching with Levenshtein distance and composite tokens (`qwen35b` → `Qwen35Coder-35B`)
- Provider priority (OAuth/subscription first, then API-key providers)
- Supports partial names like "haiku", "qwen3-coder", "claude-3.5"

## Test

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

## How the `$$` trim works

A pi extension command handler cannot mutate session history (`ctx.sessionManager` is a `ReadonlySessionManager`). Trimming therefore runs through the supported boundary-event path: `runSubCommand` arms a `trimNextTurnToLastMessage` flag before the substitute turn's prompt is sent. A `turn_end` handler buffers `context_edit` drafts (`replacement: null`) for each finished tool-calling turn, omitting its assistant message and tool results, without applying them: the substitute model keeps seeing its own tool results while it works. When the run has fully finished, an `agent_before_settle` handler applies all the buffered drafts in one shot, so only the final answer stays in model context (the final answer turn, having no tool results, gets no draft). Two safety rails: `runSubCommand` snapshots the session's pre-run entry ids and passes them as `protectedEntryIds` to `buildTrimToLastTurnDrafts`, which filters protected ids out of drafts and voids drafts anchored to one; and if the run aborts, pi fires the cut-off turn's own `turn_end` with `outcome: "aborted"`; the handler then flushes every buffered turn through `buildRunTrimDrafts` in that boundary and disarms, so an interrupted run also loses its tool-call chatter (and only that). An errored turn stays buffered because pi may retry it inside the same run; the flush waits for the settle boundary after retries conclude, and the failed turn's dangling message is trimmed there too. See `buildTrimToLastTurnDrafts` and `buildRunTrimDrafts` in `extensions/index.ts`.

## Files

```
extensions/index.ts   The extension: parsing, one-turn execution, trim, autocomplete, entry renderer
extensions/index.test.ts
src/utils/flavoredModels.ts   Flavor-categorized model-list I/O for the resolution ladder
```
