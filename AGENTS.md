# pi-oneturnagent

One-turn model substitution extension for pi coding agent (pi ≥ 0.99.1, @earendil-works).

## Commands

- `$<model> <prompt...>` (one dollar): fuzzy-matches the model through `resolveModelWithProvider`, switches the session with `pi.setModel`, runs exactly one turn via `pi.sendUserMessage`, waits for idle, then restores the original model (restoration runs in a `finally` block, so an error or abort still restores). Parsing and orchestration live in the exported `parseSubCommandArgs` and `executeSubTurn` helpers in `extensions/index.ts`.
- `$$<model> <prompt...>` (two dollars): the same substitute turn, plus a trim. `runSubCommand` arms a `trimNextTurnToLastMessage` flag before the prompt is sent. `turn_end` handlers accumulate `context_edit` drafts (via `buildTrimToLastTurnDrafts`) for each finished tool-calling turn — the assistant message (`messageEntryId`) and tool results (`toolResultEntryIds`) — but return nothing, so the substitute model keeps its own tool results for the rest of the run. The `agent_before_settle` handler applies all accumulated drafts in one shot when the run has fully finished; the final answer (a turn with no tool results) gets no draft and is kept. A run protected snapshot: `runSubCommand` captures the session's pre-run entry ids and passes them as `protectedEntryIds`, so drafts filter them out and void any turn anchored to one. If the run aborts, pi fires the cut-off turn's own `turn_end` with `outcome: "aborted"` (added to `TurnEndTrimEvent`): the handler flushes all buffered turns via `buildRunTrimDrafts` — tool turns lose their message plus results, dangling aborted/errored turns lose their assistant message, completed final answers are kept — right there and disarms. An errored turn instead stays buffered because pi may retry it within the same run; the settle flush waits until retries conclude. A command handler cannot mutate the session directly — `ctx.sessionManager` is a `ReadonlySessionManager` — so trimming must go through the boundary-event drafts, never `appendContextEdit`.
- Three or more dollars is ordinary text: `BANG_MODEL_INPUT` = `/^(\${1,2})(\S+)\s+(\S.*)$/` only matches one or two dollars, and `MODEL_REQUEST_LIKE` rejects dollar amounts (`$100 note`) so they flow through to the model untouched.

## Model resolution

`resolveModelWithProvider` walks a ladder: flavored models (pi settings high/med/fast) → scoped models (`--models` argv patterns or `enabledModels`) → full registry. Provider-prefixed requests resolve strictly within the named provider. Multi-slash model ids (for example `inference/aws/anthropic/bedrock-claude-sonnet-5-5`) are supported: the provider is the component before the first slash and the model id is the full remainder, sliced with `indexOf` (never `split("/", 2)`, which truncates the result array). Fuzzy matching: exact → partial tokens → composite-aware scoring (`tokenMatchStrength`) → Levenshtein (`getTopModelsFromList`). Provider priority favors OAuth/subscription providers. Group overrides (`scope` param) act as testing hooks.

The model list for completions comes from the in-process registry with a 60-second cache (`clearModelsCache` resets it; tests must call it in `beforeEach`).

## Autocomplete

`createBangModelCompletionFactory` wraps pi's editor provider: `$` is a trigger character, `BANG_MODEL_TYPED_PREFIX` matches one or two dollars at line start, and completion values keep the dollar prefix with a trailing space so the cursor lands where the prompt starts. `addAutocompleteProvider` is missing from the vendored peer types, so the install site casts through `EditorUIContext`.

## Green model-switch notices

`notifyModelSwitch` appends a `pi-oneturnagent/model-switch` custom entry; `registerEntryRenderer` renders it in the theme's success color. Older pi builds lack entry renderers, so both the registration and `pi.appendEntry` checks are feature-detected with console fallback.

## Verify

- `npm run typecheck` (`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`) must exit 0.
- `npm test` (vitest) — 55 tests across `extensions/index.test.ts` and `src/utils/flavoredModels.test.ts`.
- Requires pi-coding-agent ≥ 0.99.1: the `$$` trim needs the `turn_end` boundary-draft API (`BoundaryResult` / `messageEntryId` / `toolResultEntryIds` in `dist/core/extensions/types.d.ts`); confirm field names there if the API drifts.
