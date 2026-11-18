export const APP_NAME = 'last-mile-backend';
export const API_PREFIX = 'api/v1';

export const QUEUES = {
  MATCHING: 'matching-queue',
  DISPATCH: 'dispatch-queue',
  OUTBOX: 'outbox-queue',
  NOTIFICATIONS: 'notifications-queue',
} as const;

export const CACHE_KEYS = {
  DRIVER_GPS_PREFIX: 'driver:gps:',
  ZONE_MATCHING_LEASE: 'lease:matching:',
  SOCKET_TICKET_PREFIX: 'socket_ticket:',
} as const;
