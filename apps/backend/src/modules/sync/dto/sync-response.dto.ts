export interface SyncPassengerState {
  activeBooking: {
    id: string;
    status: string;
    passengerId: string;
    pickupPointId: string;
    dropoffAddress?: string | null;
    fareQuotePaise: number;
    createdAt: string;
    updatedAt: string;
    /** Group version when booking is member of active ride group; 1 if unmatched */
    entityVersion: number;
  } | null;
  activeGroup: {
    id: string;
    status: string;
    /** Authoritative PostgreSQL ride_groups.group_version */
    groupVersion: number;
    pickupPointId: string;
    memberCount: number;
  } | null;
  activeTrip: {
    id: string;
    status: string;
    /** Authoritative PostgreSQL ride_groups.group_version for the trip */
    tripVersion: number;
    activeDriverId: string;
    driverName?: string | null;
    vehicleNumber?: string | null;
    driverLocation: {
      latitude: number;
      longitude: number;
      updatedAt: string;
    } | null;
    etaSeconds?: number | null;
    currentStopOrder?: number;
    farePaise: number;
  } | null;
  outstandingCancellationFees: Array<{
    id: string;
    feeAmountPaise: number;
    reason: string;
    assessedAt: string;
  }>;
}

export interface SyncDriverState {
  driverProfile: {
    id: string;
    verificationStatus: string;
    operationalStatus: string;
    isOnline: boolean;
  };
  activeOffer: {
    id: string;
    rideGroupId: string;
    groupVersion: number;
    expiresAt: string;
    status: string;
  } | null;
  activeTrip: {
    id: string;
    status: string;
    tripVersion: number;
    rideGroupId: string;
    currentStopOrder?: number;
    passengerManifest: Array<{
      passengerId: string;
      bookingId: string;
      status: string;
      pickupOtp?: string;
    }>;
  } | null;
}

export interface SyncResponseDto {
  success: boolean;
  serverTimestamp: string;
  role: string;
  reconciled: boolean;
  passengerState?: SyncPassengerState | null;
  driverState?: SyncDriverState | null;
}
