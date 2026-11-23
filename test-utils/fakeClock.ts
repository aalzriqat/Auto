import { vi } from "vitest";

const CLOCK_STEP_MS = 100;
const CLOCK_LIMIT_MS = 30_000;

/**
 * Awaits `work` while moving the fake clock forward in small steps until it settles.
 * Needs `vi.useFakeTimers()`. The Anthropic SDK retries a thrown fetch once (maxRetries 1) after
 * `sleep(0.5 s * (0.75..1.0 jitter))`, a setTimeout registered only after real async work
 * (key decryption, the scheduler). A fixed number of advances can run before that timer exists and
 * leave the test waiting on a clock nobody moves; stepping until the work settles cannot. The
 * limit stays below the SDK's 40 s request timeout and the 120 s draft expiry, so neither fires.
 */
export async function advanceUntilSettled<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  watched.catch(() => undefined);
  for (let elapsed = 0; !settled && elapsed < CLOCK_LIMIT_MS; elapsed += CLOCK_STEP_MS) {
    await vi.advanceTimersByTimeAsync(CLOCK_STEP_MS);
  }
  if (!settled) throw new Error(`the work did not settle within ${CLOCK_LIMIT_MS} ms of fake time`);
  return watched;
}
