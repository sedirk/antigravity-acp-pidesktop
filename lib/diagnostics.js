'use strict';

// Numeric-only, bounded diagnostics. Never retain prompts, tool payloads or reports.
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const now = () => performance.now();
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const opaque = value => value ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : '';

function createTurnDiagnostics(log, { sessionId = '', key = '', clock = now } = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const session = opaque(sessionId), lane = opaque(key), started = clock();
  let step = 0, dispatches = 0, waitingAt = null, parkedAt = null, lastRaw = null;
  let lastContext = '', closed = false;
  const elapsed = since => number(Math.max(0, clock() - since));
  function emit(event, values) {
    if (closed) return;
    try { log(`[acp-diag] ${JSON.stringify({ v: 1, trace: id, session, lane, step, event, ...values })}`); }
    catch { /* Diagnostics must never fail a request. */ }
  }
  function progress(kind) {
    if (closed || waitingAt === null || !['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(kind)) return;
    emit('first_progress', { kind, waitMs: elapsed(waitingAt) });
    waitingAt = null;
  }
  return {
    id,
    dispatch() {
      waitingAt = clock();
      emit('dispatch', { attempt: ++dispatches });
    },
    progress,
    park(reportedUsed, toolCount) {
      progress('tool_call'); // MCP can call a tool without a preceding ACP tool_call event.
      parkedAt = clock();
      emit('park', { reportedUsed: number(reportedUsed), toolCount: number(toolCount) });
    },
    startResume: () => clock(),
    resume(resumeStarted, throttleMs, toolCount, reportedUsed) {
      const at = clock();
      step += 1;
      waitingAt = at;
      emit('resume', {
        hostRoundTripMs: parkedAt === null ? null : number(Math.max(0, resumeStarted - parkedAt)),
        localResumeMs: number(Math.max(0, at - resumeStarted)),
        throttleMs: number(throttleMs), toolCount: number(toolCount), reportedUsed: number(reportedUsed),
      });
      parkedAt = null;
    },
    context({ rawUsed, rawSize, beforeUsed, pendingBefore, reportedUsed, pendingAfter, accepted }) {
      const raw = number(rawUsed), reported = number(reportedUsed), before = number(beforeUsed);
      const values = {
        rawUsed: raw, rawSize: number(rawSize), beforeUsed: before, pendingBefore: number(pendingBefore),
        reportedUsed: reported, pendingAfter: number(pendingAfter), accepted: accepted === true,
        previousRawUsed: lastRaw,
        normalized: accepted === true && raw !== null && raw > 0 && raw !== reported,
        rawDrop: accepted === true && raw > 0 && lastRaw >= 16384 && raw < lastRaw * 0.6,
        reportedDrop: reported !== null && before >= 16384 && reported < before * 0.6,
      };
      const signature = JSON.stringify(values);
      if (signature !== lastContext) emit('context', values);
      lastContext = signature;
      if (accepted && raw > 0) lastRaw = raw;
    },
    final({ rawInputTokens, rawCachedReadTokens, beforeUsed, pendingBefore, reportedUsed, alignedFromStep }) {
      emit('context_final', {
        rawInputTokens: number(rawInputTokens), rawCachedReadTokens: number(rawCachedReadTokens),
        beforeUsed: number(beforeUsed), pendingBefore: number(pendingBefore), reportedUsed: number(reportedUsed),
        alignedFromStep: alignedFromStep === true,
      });
    },
    end(status) {
      if (closed) return;
      emit('end', {
        status: ['complete', 'cancelled', 'error'].includes(status) ? status : 'error',
        elapsedMs: elapsed(started), waitingForProgress: waitingAt !== null,
        waitMs: waitingAt === null ? null : elapsed(waitingAt),
      });
      closed = true;
    },
  };
}

module.exports = { createTurnDiagnostics, now };
