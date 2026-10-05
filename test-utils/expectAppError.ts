import { expect } from "vitest";

/**
 * Asserts that `attempt` was refused with the given structured code AND the exact message (a plain
 * `toThrow(message)` would still pass on a different code). Fails when the call resolves, so a
 * refusal can never be an accident of a passing call.
 */
export async function expectAppError(attempt: Promise<unknown>, code: string, message: string): Promise<void> {
  const error = await attempt.then(
    () => {
      throw new Error(`expected a ${code} refusal but the call resolved`);
    },
    (caught: unknown) => caught as { data?: { code?: string; message?: string } }
  );
  expect(error?.data?.code).toBe(code);
  expect(error?.data?.message).toBe(message);
}
