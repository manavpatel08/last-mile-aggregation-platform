export interface CandidateDriver {
  driverId: string;
  userId: string;
  licenseNumber: string;
  operationalStatus: string;
  vehicleCapacity: number;
  latitude: number;
  longitude: number;
  etaSec: number;
  distanceMeters?: number;
}

export interface DispatchResult {
  success: boolean;
  attemptId?: string;
  offerId?: string;
  driverId?: string;
  etaSec?: number;
  expiresAt?: Date;
  isExistingOffer?: boolean;
  isExistingAssignment?: boolean;
  reason?: string;
  message?: string;
  retryable?: boolean;
}

export interface DispatchTimeoutJobPayload {
  offerId: string;
  rideGroupId: string;
  driverId: string;
  groupVersion: number;
  dispatchAttemptId: string;
}

export interface PendingOfferSummary {
  offerId: string;
  dispatchAttemptId: string;
  rideGroupId: string;
  groupVersion: number;
  pickupPoint: {
    id: string;
    name: string;
  };
  passengerCount: number;
  totalEstimatedFare: string;
  totalDistanceMeters: number;
  totalDurationSec: number;
  offeredAt: string;
  expiresAt: string;
  remainingSeconds: number;
}

export interface AcceptOfferResponseData {
  assignmentId: string;
  tripId: string;
  rideGroupId: string;
  passengerCount: number;
  totalEstimatedFare: string;
  navigationRoute: {
    geometry: any;
    stops: Array<{
      stopOrder: number;
      stopType: string;
      latitude: number;
      longitude: number;
    }>;
  };
}

export const DRIVER_OFFER_TIMEOUT_SEC = 20;
export const DRIVER_OFFER_TIMEOUT_MS = DRIVER_OFFER_TIMEOUT_SEC * 1000;
export const DISPATCH_TIMEOUT_JOB_NAME = 'dispatch-timeout';
