export interface EligibleBookingRow {
  id: string;
  passenger_id: string;
  fare_quote_id: string;
  pickup_point_id: string;
  requested_type: string;
  min_group_preference: number;
  status: string;
  agreed_fare_ceiling_paise: number;
  max_wait_deadline: Date;
  created_at: Date;
  dest_lng: number;
  dest_lat: number;
  pickup_lng: number;
  pickup_lat: number;
}

export interface MatchingCycleSummary {
  batchId: string;
  pickupPointId: string;
  totalEligibleBookings: number;
  groupsFormedCount: number;
  formedGroupIds: string[];
  skippedReason?: string;
  startedAt: Date;
  completedAt: Date;
}
