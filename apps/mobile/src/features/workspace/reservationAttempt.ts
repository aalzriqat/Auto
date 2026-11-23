export type ReservationAttempt = {
  vehicleId: string;
  idempotencyKey: string;
  expiries: Array<{ holdDays: number; expiresAt: number }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function reservationAttemptKey(attempts: ReservationAttempt[], vehicleId: string): string {
  const previous = attempts.find((attempt) => attempt.vehicleId === vehicleId);
  if (previous) return previous.idempotencyKey;

  const idempotencyKey = `vehicle-reservation:${crypto.randomUUID()}`;
  attempts.push({ vehicleId, idempotencyKey, expiries: [] });
  return idempotencyKey;
}

export function reservationAttemptExpiry(
  attempts: ReservationAttempt[],
  vehicleId: string,
  holdDays: number | undefined,
): number | undefined {
  if (holdDays !== undefined && holdDays > 0) {
    const attempt = attempts.find((entry) => entry.vehicleId === vehicleId);
    if (!attempt) throw new Error("Reservation attempt was not initialized.");

    const previous = attempt.expiries.find((entry) => entry.holdDays === holdDays);
    if (previous) return previous.expiresAt;

    const expiresAt = Date.now() + holdDays * DAY_MS;
    attempt.expiries.push({ holdDays, expiresAt });
    return expiresAt;
  }
  return undefined;
}

export function retireReservationAttempt(attempts: ReservationAttempt[], vehicleId: string): void {
  const index = attempts.findIndex((attempt) => attempt.vehicleId === vehicleId);
  if (index >= 0) attempts.splice(index, 1);
}
