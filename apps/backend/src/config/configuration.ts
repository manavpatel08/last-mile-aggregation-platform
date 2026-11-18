export default () => ({
  environment: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://lastmile_app@127.0.0.1:5432/lastmile_db?schema=public',
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  routing: {
    osrmBackendUrl: process.env.OSRM_BACKEND_URL || 'http://127.0.0.1:5000',
  },
  jwt: {
    accessSecret:
      process.env.JWT_ACCESS_SECRET ||
      'dev-access-secret-minimum-32-chars-long-placeholder!',
    accessExpiry: parseInt(process.env.JWT_ACCESS_EXPIRY ?? '900', 10),
    refreshTokenMaxDays: parseInt(
      process.env.REFRESH_TOKEN_MAX_DAYS ?? '30',
      10,
    ),
  },
  google: {
    clientIdIos: process.env.GOOGLE_CLIENT_ID_IOS || '',
    clientIdAndroid: process.env.GOOGLE_CLIENT_ID_ANDROID || '',
    clientIdWeb: process.env.GOOGLE_CLIENT_ID_WEB || '',
  },
  matching: {
    batchIntervalMs: parseInt(
      process.env.MATCHING_BATCH_INTERVAL_MS ?? '60000',
      10,
    ),
    maxWaitDeadlineMs: parseInt(
      process.env.MAX_SHARED_WAIT_DEADLINE_MS ?? '120000',
      10,
    ),
    driverOfferTimeoutSec: parseInt(
      process.env.DRIVER_OFFER_TIMEOUT_SEC ?? '20',
      10,
    ),
    maxDetourPercent: parseFloat(process.env.MAX_DETOUR_PERCENT ?? '25.0'),
  },
  tariff: {
    baseFarePaise: parseInt(process.env.BASE_FARE_PAISE ?? '2000', 10),
    perKmRatePaise: parseInt(process.env.PER_KM_RATE_PAISE ?? '1000', 10),
  },
  demoMode: process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1',
});
