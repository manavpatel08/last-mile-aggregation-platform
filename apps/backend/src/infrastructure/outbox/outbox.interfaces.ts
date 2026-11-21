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

export interface OutboxProcessingSummary {
  processedCount: number;
  publishedCount: number;
  failedCount: number;
  retriedCount: number;
  groupFormedHandledCount: number;
}

export interface OutboxClaimedRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: any;
  retry_count: number;
}
