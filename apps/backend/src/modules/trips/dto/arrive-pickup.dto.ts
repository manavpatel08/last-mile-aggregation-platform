/**
 * DTO for driver arrival at pickup hub (POST /api/v1/trips/:id/arrive-pickup).
 *
 * NOTE: Frontend-supplied coordinates are strictly rejected / ignored for arrival authorization.
 * The server exclusively evaluates the authoritative, server-recorded GPS fix
 * stored in Redis (telemetry TTL <= 30 seconds) within the 150m PDEU geofence.
 * The request body for this endpoint is intentionally empty.
 */
export class ArrivePickupDto {}
