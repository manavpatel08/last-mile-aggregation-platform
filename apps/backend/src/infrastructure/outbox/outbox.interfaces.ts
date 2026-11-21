export const SUPPORTED_OUTBOX_EVENT_TYPES = [
  'GROUP_FORMED',
  'DISPATCH_OFFER_CREATED',
] as const;

export type SupportedOutboxEventType =
  (typeof SUPPORTED_OUTBOX_EVENT_TYPES)[number];

export interface GroupFormedPayload {
  rideGroupId: string;
  pickupPointId: string;
  groupVersion: number;
  status?: string;
  memberBookingIds?: string[];
  totalSharedFarePaise?: number;
  totalRouteDistanceMeters?: number;
  totalRouteDurationSec?: number;
}

export interface DispatchOfferCreatedPayload {
  offerId: string;
  rideGroupId?: string;
  driverId?: string;
  groupVersion?: number;
  dispatchAttemptId?: string;
  expiresAt?: string;
}

export interface OutboxProcessingSummary {
  processedCount: number;
  publishedCount: number;
  failedCount: number;
  retriedCount: number;
  groupFormedHandledCount: number;
  dispatchOfferCreatedHandledCount?: number;
}

export interface OutboxClaimedRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  retry_count: number;
}
