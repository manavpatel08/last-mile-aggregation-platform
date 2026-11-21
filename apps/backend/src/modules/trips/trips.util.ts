/**
 * Calculates individual waiting charges in paise for a passenger.
 *
 * Rules (docs/FARE_AND_CANCELLATION.md & docs/STATE_MACHINES.md):
 * - Waiting duration measured from trips.driver_arrived_at to trip_passengers.boarded_at.
 * - First five minutes (300 seconds) are free.
 * - Charge ₹5 (500 paise) per started minute over five minutes.
 * - Round upward using ceiling: ceil(T_i - 5).
 * - Maximum waiting charge is capped at ₹25 (2500 paise) per passenger.
 * - Monetary value stored as integer paise.
 *
 * Formula:
 * W_i = min(2500, 500 * ceil(max(0, T_i - 5)))
 *
 * @param driverArrivedAt Authoritative driver arrival timestamp
 * @param boardedAt Authoritative passenger boarding timestamp
 * @returns Waiting charge in paise (0 to 2500)
 */
export function calculateWaitingChargePaise(
  driverArrivedAt: Date | string | null | undefined,
  boardedAt: Date | string | null | undefined,
): number {
  if (!driverArrivedAt || !boardedAt) {
    return 0;
  }

  const arrivedMs = new Date(driverArrivedAt).getTime();
  const boardedMs = new Date(boardedAt).getTime();

  if (isNaN(arrivedMs) || isNaN(boardedMs) || boardedMs <= arrivedMs) {
    return 0;
  }

  const elapsedSec = (boardedMs - arrivedMs) / 1000;
  const elapsedMinutes = elapsedSec / 60;

  if (elapsedMinutes <= 5) {
    return 0;
  }

  const startedMinutesOver = Math.ceil(elapsedMinutes - 5);
  const chargeRupees = Math.min(25, startedMinutesOver * 5);
  return chargeRupees * 100; // in paise
}
