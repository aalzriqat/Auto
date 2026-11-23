export type ReservationAttempt = {
  idempotencyKey: string;
  expiresByDuration: Map<number, number>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function reservationAttemptFor(
  attempts: Map<string, ReservationAttempt>,
  vehicleId: string,
  holdDays: number | undefined,
) {
  let attempt = attempts.get(vehicleId);
  if (!attempt) {
    attempt = {
      idempotencyKey: `vehicle-reservation:${crypto.randomUUID()}`,
      expiresByDuration: new Map(),
    };
    attempts.set(vehicleId, attempt);
  }
  let expiresAt: number | undefined;
  if (holdDays !== undefined && holdDays > 0) {
    expiresAt = attempt.expiresByDuration.get(holdDays) ?? Date.now() + holdDays * DAY_MS;
    attempt.expiresByDuration.set(holdDays, expiresAt);
  }
  return { idempotencyKey: attempt.idempotencyKey, expiresAt };
}
