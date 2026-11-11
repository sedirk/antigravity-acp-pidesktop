# Streaming repair audit (unreleased)

## Confirmed defects in 1.5.10 source

- `agent_message_chunk` counting was nested inside `tool_call`: round text always remained zero. Tool-using turns therefore triggered fresh-session replay even when text was streamed. Runtime tool limits cannot be inferred from those logs.
- Automatic replay closed the original session and passed tool titles, not tool results, into a new session. Removed rather than attempting to reconstruct execution from titles. Empty responses now fail explicitly and preserve the session.
- Gateway `port` had no declaration. Existing tests never exercised listening or health.
- Context fallback was global and updated from the wrong event. Context is now kept only with its owning session. Output remains estimated; `estimated` is always true.
- Synthetic tool progress was streamed as reasoning but omitted from final reasoning content. The host overwrites the delta text with that final content. Final reasoning now preserves the streamed progress. This is progress, not model reasoning.
- Responses final output ordering disagreed with streamed output indexes. Corrected. Interrupted streams now use `response.incomplete`, not `response.completed` with an incomplete body.
- Disconnected queued requests could still run and could cancel a different active request using the same session. Cancellation is now attached to the owning active prompt; queued cancelled requests are skipped.
- HTTP timeout configuration was inside the request callback. Moved to server initialization; requestTimeout is a request-body timeout, not a model-response timeout.

## Dynamic usage limitation

The extracted PI-Desktop Responses parser (`openai-responses-shared-CMVdy1yT.js`, finalizeResponse lines 436-450; terminal dispatch 635-637) reads usage only on response.completed/incomplete. Sending additional response.in_progress or invented usage events will not update that parser. Do not fake terminal events to refresh usage.

The extracted Chat Completions parser accepts usage on individual chunks (openai-completions-BB2GFjCe.js lines 380-388). The gateway now emits intermediate usage for that endpoint; mock HTTP tests verify this. No provider settings were changed. Live UI behavior of the repaired build remains unverified.

ACP used/size is cumulative session occupancy, not measured per-request billing. The compatibility input token field uses that occupancy when available, and output tokens are estimated. Totals and tokens/s are not native model throughput measurements. Missing usage is not evidence of lost session history.

## Verification

- Existing offline tests: `node test/run-tests.js` (20 suites).
- New behavioral HTTP tests: `node test/gateway-regression.js` (9 cases), using mock ACP and real local HTTP/SSE, no Google account calls.
- Syntax check and git diff whitespace check.
- A real geminitest run was launched against the installed 1.5.10, NOT this source. Its result cannot validate the repaired build.

## Remaining acceptance work

- Official plugin check/package and installation of the repaired build, then successful geminitest final report through the host. No release is justified before this.
- Responses live occupancy requires host parser support or a separately user-approved switch to Chat Completions; gateway-only custom events are insufficient for the inspected parser.
- Hard RPC timeout can still release the prompt lock before the runtime confirms cancellation. Runtime epoch/timeout recovery and same-conversation preparation races need dedicated tests and implementation.
- Model switching within an existing host conversation only forwards the latest user text on a cache hit; intervening other-model turns need a history reconciliation design.
- Empty/missing ACP stop reasons are logged but do not prove a final answer was produced. Raw event ordering and delayed notifications still need runtime investigation.

No installed plugin, credentials, registry, database, provider settings, or unrelated project files were changed.

## Root cause confirmed (1.5.12)

ACP requests from the agent and responses to the client share one id space. The runtime numbers
`session/request_permission` from 0 upward while the gateway's `session/prompt` typically holds id 4 or 5.
The old dispatcher matched any message by id, so a permission request with the same id resolved the
in-flight prompt with `undefined`: the turn ended with zero text and no `stopReason`, and the permission
request was never answered, leaving the runtime blocked. Raw probe evidence:

- read-only task (no permissions): 12/12 files read, 1593 chars, `stopReason=end_turn`, no late events.
- write task: permissions 0,1,2,3 answered; the fifth request (id 4 == prompt id 4) collided; turn returned
  empty and the follow-up prompt hung until timeout.

Fix: only messages without `method` are treated as responses. Empty turns are nudged in the same session
(twice, 90 s idle cap) instead of replaying in a fresh one. Cancel now gives a 20 s grace, then abandons
the RPC and discards the unusable session.
