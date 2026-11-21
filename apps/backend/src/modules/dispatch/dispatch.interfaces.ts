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
  reason?: string;
  message?: string;
}

export const DRIVER_OFFER_TIMEOUT_SEC = 20;
export const DRIVER_OFFER_TIMEOUT_MS = DRIVER_OFFER_TIMEOUT_SEC * 1000;
