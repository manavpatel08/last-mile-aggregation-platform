/**
 * Canonical booking statuses representing active bookings in the system.
 * Any passenger with a booking in one of these statuses is prohibited from
 * initiating an additional booking (Invariant 1: Exactly One Active Booking per Passenger).
 * Authoritative reference: docs/STATE_MACHINES.md Section 2.1
 */
export const CANONICAL_ACTIVE_BOOKING_STATUSES = [
  'REQUESTED',
  'MATCHING',
  'MATCHED',
  'DISPATCHING',
  'CONFIRMED',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'BOARDED',
  'IN_PROGRESS',
] as const;

export type ActiveBookingStatus =
  (typeof CANONICAL_ACTIVE_BOOKING_STATUSES)[number];

/**
 * Terminal statuses where a booking lifecycle has concluded.
 * Passengers with bookings in terminal states are eligible to initiate new ride bookings.
 */
export const TERMINAL_BOOKING_STATUSES = [
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'EXPIRED',
] as const;

export type TerminalBookingStatus = (typeof TERMINAL_BOOKING_STATUSES)[number];
