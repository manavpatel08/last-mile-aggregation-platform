import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { RoutingService } from './routing.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

describe('RoutingService (Real Distributed Multi-Instance Redis Integration)', () => {
  let redisClientA: Redis;
  let redisClientB: Redis;
  let redisClientC: Redis;

  let serviceA: RoutingService;
  let serviceB: RoutingService;
  let serviceC: RoutingService;

  const mockConfigService = {
    get: (key: string) => {
      if (key === 'routing.osrmBackendUrl' || key === 'osrm.backendUrl') {
        return 'http://127.0.0.1:5000';
      }
      return undefined;
    },
  } as unknown as ConfigService;

  beforeEach(async () => {
    // Create 3 independent real Redis clients to localhost:6379
    redisClientA = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
    redisClientB = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
    redisClientC = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });

    // Clean up all circuit-breaker keys before each test
    await redisClientA.del(
      'cb:osrm:state',
      'cb:osrm:failures',
      'cb:osrm:first_failure_at',
      'cb:osrm:opened_at',
      'cb:osrm:probe_lock',
      'cb:osrm:generation',
    );

    const redisServiceA = {
      getClient: () => redisClientA,
      isHealthy: async () => true,
    } as unknown as RedisService;

    const redisServiceB = {
      getClient: () => redisClientB,
      isHealthy: async () => true,
    } as unknown as RedisService;

    const redisServiceC = {
      getClient: () => redisClientC,
      isHealthy: async () => true,
    } as unknown as RedisService;

    serviceA = new RoutingService(mockConfigService, redisServiceA);
    serviceB = new RoutingService(mockConfigService, redisServiceB);
    serviceC = new RoutingService(mockConfigService, redisServiceC);
  });

  afterAll(async () => {
    await redisClientA?.quit();
    await redisClientB?.quit();
    await redisClientC?.quit();
  });

  it('FOCUS 3: Shared OPEN/CLOSED state is instantly visible across independent instances via Redis', async () => {
    expect(await serviceA.getCircuitBreakerState()).toBe('CLOSED');
    expect(await serviceB.getCircuitBreakerState()).toBe('CLOSED');

    // Instance A sets circuit breaker to OPEN
    await serviceA.setCircuitBreakerState('OPEN');

    // Instance B and C must see OPEN immediately
    expect(await serviceB.getCircuitBreakerState()).toBe('OPEN');
    expect(await serviceC.getCircuitBreakerState()).toBe('OPEN');

    // Instance C resets to CLOSED
    await serviceC.setCircuitBreakerState('CLOSED');

    // Instance A and B must see CLOSED immediately
    expect(await serviceA.getCircuitBreakerState()).toBe('CLOSED');
    expect(await serviceB.getCircuitBreakerState()).toBe('CLOSED');
  });

  it('FOCUS 3: Exactly one HALF_OPEN probe wins across instances; others do not issue OSRM requests', async () => {
    // Set circuit breaker OPEN with cooldown elapsed (31 seconds ago)
    await redisClientA.mset({
      'cb:osrm:state': 'OPEN',
      'cb:osrm:opened_at': String(Date.now() - 31000),
      'cb:osrm:failures': '3',
      'cb:osrm:generation': '2',
    });

    let resolveFetch: (val: any) => void;
    const probeFetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => probeFetchPromise as any);

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    // Fire requests concurrently across instance A, instance B, and instance C
    const reqA = serviceA.getRoute(origin, destination);
    const reqB = serviceB.getRoute(origin, destination);
    const reqC = serviceC.getRoute(origin, destination);

    // Instances that do not win probe lock will resolve immediately with fallback
    // Exactly ONE instance wins the probe lock and awaits OSRM
    const results = await Promise.all([
      // We know at least two should resolve immediately without waiting for OSRM
      Promise.race([reqB, new Promise((r) => setTimeout(() => r('TIMEOUT'), 500))]),
      Promise.race([reqC, new Promise((r) => setTimeout(() => r('TIMEOUT'), 500))]),
    ]);

    // Check that at least one of the concurrent callers fast-fell back immediately
    const immediateFallbacks = results.filter(
      (r: any) => typeof r === 'object' && r.source === 'FALLBACK' && r.isFallback === true,
    );
    expect(immediateFallbacks.length).toBeGreaterThanOrEqual(1);

    // Resolve the single in-flight probe successfully
    resolveFetch!({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 2000, duration: 250, geometry: null }],
      }),
    });

    const resA = await reqA;
    const resB = await reqB;
    const resC = await reqC;

    const allResults = [resA, resB, resC];
    const osrmSuccesses = allResults.filter((r) => r.source === 'OSRM');
    const fastFallbacks = allResults.filter((r) => r.source === 'FALLBACK');

    // Exactly one winner executed the OSRM probe
    expect(osrmSuccesses.length).toBe(1);
    expect(fastFallbacks.length).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // After the winning probe succeeded, all instances see CLOSED state
    expect(await serviceA.getCircuitBreakerState()).toBe('CLOSED');
    expect(await serviceB.getCircuitBreakerState()).toBe('CLOSED');
    expect(await serviceC.getCircuitBreakerState()).toBe('CLOSED');
  });

  it('FOCUS 3: Stale / late probe completion cannot overwrite newer breaker state across instances', async () => {
    // Breaker is HALF_OPEN with probe lock belonging to instance A
    const gen = 10;
    const tokenA = 'probe-token-instance-a';
    await redisClientA.mset({
      'cb:osrm:state': 'HALF_OPEN',
      'cb:osrm:generation': String(gen),
      'cb:osrm:probe_lock': tokenA,
    });

    // Suppose probe lock expired in Redis and Instance B acquired a newer probe (gen 11)
    await redisClientB.mset({
      'cb:osrm:state': 'OPEN', // Instance B's probe failed and reopened circuit at gen 11
      'cb:osrm:generation': '11',
      'cb:osrm:opened_at': String(Date.now()),
      'cb:osrm:failures': '3',
    });
    await redisClientB.del('cb:osrm:probe_lock');

    // Now, Instance A's stale probe tries to record success from gen 10
    const staleDecision = {
      allowed: true,
      isProbe: true,
      probeToken: tokenA,
      generation: gen,
    };

    await (serviceA as any).recordSuccess(staleDecision);

    // Breaker MUST remain OPEN! Instance A cannot overwrite newer generation 11
    expect(await serviceB.getCircuitBreakerState()).toBe('OPEN');
    expect(await redisClientB.get('cb:osrm:state')).toBe('OPEN');
    expect(await redisClientB.get('cb:osrm:generation')).toBe('11');
  });

  it('FOCUS 3: Late success from Instance A cannot overwrite OPEN state tripped by Instance B', async () => {
    let fetchStartedResolve: () => void;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });

    let resolveSlowFetch: (val: any) => void;
    const slowFetchPromise = new Promise((resolve) => {
      resolveSlowFetch = resolve;
    });

    // Instance A starts request when circuit is CLOSED
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
      fetchStartedResolve();
      return slowFetchPromise as any;
    });

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    const reqAPromise = serviceA.getRoute(origin, destination);

    // Wait until Instance A has actually evaluated the breaker and called fetch
    await fetchStartedPromise;

    // Instance B encounters 3 consecutive failures
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OSRM network failure'));
    await serviceB.getRoute(origin, destination);
    await serviceB.getRoute(origin, destination);
    await serviceB.getRoute(origin, destination);

    // Circuit is now OPEN in Redis
    expect(await serviceB.getCircuitBreakerState()).toBe('OPEN');
    expect(await redisClientA.get('cb:osrm:state')).toBe('OPEN');

    // Now Instance A's request finally resolves successfully
    resolveSlowFetch!({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 1800, duration: 220, geometry: null }],
      }),
    });

    const resA = await reqAPromise;
    expect(resA.source).toBe('OSRM');

    // State in Redis MUST remain OPEN! Instance A's late success is ignored!
    expect(await serviceA.getCircuitBreakerState()).toBe('OPEN');
    expect(await serviceB.getCircuitBreakerState()).toBe('OPEN');
    expect(await redisClientB.get('cb:osrm:state')).toBe('OPEN');
  });
});
