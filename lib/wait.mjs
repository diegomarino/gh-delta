// Bounded worker wait loop. The CLI supplies one complete, lock-scoped tick;
// this module owns only timing, accumulation, heartbeat, and signal handling.
// Keeping that seam explicit makes it impossible for the sleep to inherit a
// detector lock.

/**
 * Repeat `tick` until it matches, expires, fails, or receives SIGTERM.
 * `tick` may be synchronous because detector ticks deliberately are.
 */
export async function runBoundedWait({
  timeoutMs,
  intervalMs,
  maxIntervalMs = Infinity,
  backoff,
  settleMs = 0,
  tick,
  matches,
  now,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  touchHeartbeat,
  heartbeatFile,
  heartbeatFileFor,
  progress = false,
  onProgress,
  isSignaled = () => false,
  handleSignals = true,
}) {
  const deltas = [];
  const errors = [];
  const warnings = [];
  const progressLines = [];
  let iterations = 0;
  let delay = intervalMs;
  let reason = 'timeout';
  let code = 0;
  let lastReport = null;
  let settleDeadline = null;
  let settleReason = null;
  let receivedSignal = false;
  let wakeForSignal;
  const signalWake = new Promise((resolve) => {
    wakeForSignal = resolve;
  });
  const signalHandler = () => {
    receivedSignal = true;
    wakeForSignal();
  };
  const started = clock();
  if (handleSignals) process.once('SIGTERM', signalHandler);

  try {
    if (heartbeatFile) {
      try {
        touchHeartbeat(heartbeatFile);
      } catch (error) {
        errors.push({ kind: 'io', message: String(error?.message ?? error) });
        reason = 'error';
        code = 1;
      }
    }
    while (true) {
      if (code === 1) break;
      if (settleDeadline !== null && clock() >= settleDeadline) {
        reason = settleReason;
        code = 10;
        break;
      }
      if (iterations > 0 && clock() - started >= timeoutMs && settleDeadline === null) break;
      const result = tick();
      iterations++;
      const report = result.report ?? {};
      lastReport = report;
      const failure = report.error
        ? { kind: report.kind, message: report.error }
        : report.results?.[0]?.error;
      if (failure) errors.push(failure);
      else deltas.push(...(report.deltas ?? []));
      warnings.push(...(result.warnings ?? []));

      const heartbeatPath = heartbeatFileFor?.(report) ?? heartbeatFile;
      if (heartbeatPath) {
        try {
          touchHeartbeat(heartbeatPath);
        } catch (error) {
          errors.push({ kind: 'io', message: String(error?.message ?? error) });
          code = 1;
          reason = 'error';
        }
      }
      if (progress) {
        const line = `${JSON.stringify({ type: 'tick', at: now(), deltas: report.deltas?.length ?? 0 })}\n`;
        progressLines.push(line);
        onProgress?.(line);
      }

      if (receivedSignal || isSignaled()) {
        reason = 'signal';
        code = 0;
        break;
      }
      if (result.code === 2 || result.code === 1 || code === 1) {
        code ||= result.code;
        reason = 'error';
        break;
      }
      if (settleDeadline !== null) {
        if (clock() >= settleDeadline) {
          reason = settleReason;
          code = 10;
          break;
        }
        await Promise.race([sleep(Math.min(delay, settleDeadline - clock())), signalWake]);
        if (receivedSignal || isSignaled()) {
          reason = 'signal';
          code = 0;
          break;
        }
        delay = Math.min(maxIntervalMs, Math.ceil(delay * backoff));
        continue;
      }
      const match = matches(report, iterations);
      if (match) {
        if (!settleMs) {
          reason = match;
          code = 10;
          break;
        }
        settleReason = match;
        settleDeadline = clock() + settleMs;
        await Promise.race([sleep(Math.min(delay, settleDeadline - clock())), signalWake]);
        if (receivedSignal || isSignaled()) {
          reason = 'signal';
          code = 0;
          break;
        }
        delay = Math.min(maxIntervalMs, Math.ceil(delay * backoff));
        continue;
      }
      const elapsed = clock() - started;
      if (elapsed >= timeoutMs) break;
      await Promise.race([sleep(Math.min(delay, timeoutMs - elapsed)), signalWake]);
      if (receivedSignal || isSignaled()) {
        reason = 'signal';
        code = 0;
        break;
      }
      delay = Math.min(maxIntervalMs, Math.ceil(delay * backoff));
    }
  } finally {
    if (handleSignals) process.removeListener('SIGTERM', signalHandler);
  }
  return {
    code,
    reason,
    iterations,
    deltas,
    errors,
    warnings,
    lastReport,
    progress: progressLines.length ? `${progressLines.join('\n')}\n` : '',
  };
}
