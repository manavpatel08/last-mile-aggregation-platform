import { ConfigService } from '@nestjs/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisService } from './redis.service.js';

describe('RedisService (Redis Integration)', () => {
  let redisService: RedisService;
  let configService: ConfigService;

  beforeAll(() => {
    configService = new ConfigService({
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: 6379,
    });
    redisService = new RedisService(configService);
    redisService.onModuleInit();
  });

  afterAll(async () => {
    await redisService.onModuleDestroy();
  });

  it('should successfully ping Redis', async () => {
    const pong = await redisService.ping();
    expect(pong).toBe('PONG');
  });

  it('should report healthy status for isHealthy()', async () => {
    const healthy = await redisService.isHealthy();
    expect(healthy).toBe(true);
  });

  it('should store and retrieve ephemeral driver GPS with TTL', async () => {
    const testDriverId = `test-driver-${Date.now()}`;
    const gpsData = { lat: 23.1567, lng: 72.6621 };

    await redisService.setEphemeralGps(testDriverId, gpsData);

    const retrieved = await redisService.getEphemeralGps(testDriverId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.lat).toBeCloseTo(23.1567);
    expect(retrieved?.lng).toBeCloseTo(72.6621);

    // Verify key has a positive TTL (<= 30s)
    const client = redisService.getClient();
    const ttl = await client.ttl(`driver:gps:${testDriverId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);

    // Clean up
    await client.del(`driver:gps:${testDriverId}`);
  });
});
