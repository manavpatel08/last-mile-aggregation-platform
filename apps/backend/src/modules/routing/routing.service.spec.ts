import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RoutingService } from './routing.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

describe('RoutingService (Circuit Breaker, Fencing & Concurrency Review)', () => {
  let mockConfigService: ConfigService;
  let sharedRedisStore: Map<string, string>;
  let mockRedisService: RedisService;
  let routingService: RoutingService;

  beforeEach(() => {
    sharedRedisStore = new Map<string, string>();

    mockConfigService = {
      get: (key: string) => {
        if (key === 'routing.osrmBackendUrl' || key === 'osrm.backendUrl') {
          return 'http://127.0.0.1:5000';
        }
        return undefined;
      },
    } as unknown as ConfigService;

    const mockClient = {
      get: vi.fn(async (key: string) => sharedRedisStore.get(key) ?? null),
      set: vi.fn(async (key: string, val: string, ...args: any[]) => {
        if (args.includes('NX') && sharedRedisStore.has(key)) {
          return null;
        }
        sharedRedisStore.set(key, val);
        return 'OK';
      }),
      mset: vi.fn(async (dict: Record<string, string>) => {
        for (const [k, v] of Object.entries(dict)) {
          sharedRedisStore.set(k, v);
        }
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        let deleted = 0;
        for (const k of keys) {
          if (sharedRedisStore.delete(k)) deleted++;
        }
        return deleted;
      }),
      eval: vi.fn(async (script: string, numkeys: number, ...args: string[]) => {
        const keys = args.slice(0, numkeys);
        const scriptArgs = args.slice(numkeys);

        // 1. setCircuitBreakerState script
        if (script.includes('local state = ARGV[1]')) {
          const stateKey = keys[0];
          const failuresKey = keys[1];
          const openedAtKey = keys[2];
          const lockKey = keys[3];
          const genKey = keys[4];
          const firstAtKey = keys[5];

          const targetState = scriptArgs[0];
          const now = scriptArgs[1];
          const threshold = scriptArgs[2];

          sharedRedisStore.set(stateKey, targetState);
          const currentGen =
            parseInt(sharedRedisStore.get(genKey) ?? '1', 10) + 1;
          sharedRedisStore.set(genKey, String(currentGen));

          if (targetState === 'OPEN') {
            sharedRedisStore.set(failuresKey, threshold);
            sharedRedisStore.set(openedAtKey, now);
            sharedRedisStore.delete(lockKey);
            sharedRedisStore.delete(firstAtKey);
          } else if (targetState === 'CLOSED') {
            sharedRedisStore.set(failuresKey, '0');
            sharedRedisStore.delete(openedAtKey);
            sharedRedisStore.delete(lockKey);
            sharedRedisStore.delete(firstAtKey);
          } else if (targetState === 'HALF_OPEN') {
            sharedRedisStore.delete(lockKey);
          }
          return String(currentGen);
        }

        // 2. evaluateBreaker script
        if (script.includes("return {'ATTEMPT_ALLOWED'")) {
          const stateKey = keys[0];
          const openedAtKey = keys[1];
          const lockKey = keys[2];
          const genKey = keys[3];

          const now = parseInt(scriptArgs[0], 10);
          const cooldown = parseInt(scriptArgs[1], 10);
          const newProbeToken = scriptArgs[2];

          const state = sharedRedisStore.get(stateKey) ?? 'CLOSED';
          let gen = parseInt(sharedRedisStore.get(genKey) ?? '1', 10);

          if (state === 'OPEN') {
            const openedAt = parseInt(
              sharedRedisStore.get(openedAtKey) ?? '0',
              10,
            );
            if (now - openedAt >= cooldown) {
              if (sharedRedisStore.has(lockKey)) {
                return ['PROBE_BLOCKED', '', String(gen)];
              }
              gen++;
              sharedRedisStore.set(genKey, String(gen));
              sharedRedisStore.set(lockKey, newProbeToken);
              sharedRedisStore.set(stateKey, 'HALF_OPEN');
              return ['PROBE_ALLOWED', newProbeToken, String(gen)];
            } else {
              return ['COOLDOWN_ACTIVE', '', String(gen)];
            }
          } else if (state === 'HALF_OPEN') {
            if (sharedRedisStore.has(lockKey)) {
              return ['PROBE_BLOCKED', '', String(gen)];
            }
            gen++;
            sharedRedisStore.set(genKey, String(gen));
            sharedRedisStore.set(lockKey, newProbeToken);
            return ['PROBE_ALLOWED', newProbeToken, String(gen)];
          } else {
            return ['ATTEMPT_ALLOWED', '', String(gen)];
          }
        }

        // 3. recordSuccess script
        if (script.includes("return 'IGNORED_LATE_SUCCESS'")) {
          const stateKey = keys[0];
          const failuresKey = keys[1];
          const openedAtKey = keys[2];
          const lockKey = keys[3];
          const genKey = keys[4];
          const firstAtKey = keys[5];

          const isProbe = scriptArgs[0] === '1';
          const probeToken = scriptArgs[1];
          const expectedGen = parseInt(scriptArgs[2], 10);

          const state = sharedRedisStore.get(stateKey) ?? 'CLOSED';
          let currentGen = parseInt(sharedRedisStore.get(genKey) ?? '1', 10);

          if (isProbe) {
            const currentLock = sharedRedisStore.get(lockKey);
            if (
              state === 'HALF_OPEN' &&
              currentLock === probeToken &&
              currentGen === expectedGen
            ) {
              currentGen++;
              sharedRedisStore.set(stateKey, 'CLOSED');
              sharedRedisStore.set(failuresKey, '0');
              sharedRedisStore.set(genKey, String(currentGen));
              sharedRedisStore.delete(openedAtKey);
              sharedRedisStore.delete(lockKey);
              sharedRedisStore.delete(firstAtKey);
              return 'CLOSED';
            } else {
              return 'STALE_PROBE';
            }
          } else {
            if (state === 'CLOSED' && currentGen === expectedGen) {
              sharedRedisStore.set(failuresKey, '0');
              sharedRedisStore.delete(firstAtKey);
              return 'CLOSED';
            } else {
              return 'IGNORED_LATE_SUCCESS';
            }
          }
        }

        // 4. recordFailure script
        if (script.includes("return 'ALREADY_OPEN'")) {
          const stateKey = keys[0];
          const failuresKey = keys[1];
          const openedAtKey = keys[2];
          const lockKey = keys[3];
          const genKey = keys[4];
          const firstAtKey = keys[5];

          const now = parseInt(scriptArgs[0], 10);
          const threshold = parseInt(scriptArgs[1], 10);
          const windowMs = parseInt(scriptArgs[2], 10);
          const isProbe = scriptArgs[3] === '1';
          const probeToken = scriptArgs[4];
          const expectedGen = parseInt(scriptArgs[5], 10);

          const state = sharedRedisStore.get(stateKey) ?? 'CLOSED';
          let currentGen = parseInt(sharedRedisStore.get(genKey) ?? '1', 10);

          if (isProbe) {
            const currentLock = sharedRedisStore.get(lockKey);
            if (
              state === 'HALF_OPEN' &&
              currentLock === probeToken &&
              currentGen === expectedGen
            ) {
              currentGen++;
              sharedRedisStore.set(stateKey, 'OPEN');
              sharedRedisStore.set(openedAtKey, String(now));
              sharedRedisStore.set(genKey, String(currentGen));
              sharedRedisStore.set(failuresKey, String(threshold));
              sharedRedisStore.delete(lockKey);
              sharedRedisStore.delete(firstAtKey);
              return 'REOPENED';
            } else {
              return 'STALE_PROBE';
            }
          } else {
            if (state === 'OPEN') {
              return 'ALREADY_OPEN';
            } else if (state === 'HALF_OPEN') {
              return 'IGNORED_DURING_HALF_OPEN';
            } else {
              if (currentGen !== expectedGen) {
                return 'STALE_GENERATION';
              }
              const firstAt = parseInt(
                sharedRedisStore.get(firstAtKey) ?? '0',
                10,
              );
              let failures = parseInt(
                sharedRedisStore.get(failuresKey) ?? '0',
                10,
              );

              if (firstAt === 0 || now - firstAt > windowMs) {
                failures = 1;
                sharedRedisStore.set(failuresKey, '1');
                sharedRedisStore.set(firstAtKey, String(now));
              } else {
                failures++;
                sharedRedisStore.set(failuresKey, String(failures));
              }

              if (failures >= threshold) {
                currentGen++;
                sharedRedisStore.set(stateKey, 'OPEN');
                sharedRedisStore.set(openedAtKey, String(now));
                sharedRedisStore.set(genKey, String(currentGen));
                sharedRedisStore.delete(lockKey);
                sharedRedisStore.delete(firstAtKey);
                return 'OPENED';
              } else {
                return 'RECORDED';
              }
            }
          }
        }

        return 'ATTEMPT_ALLOWED';
      }),
    };

    mockRedisService = {
      getClient: () => mockClient,
      isHealthy: async () => true,
    } as unknown as RedisService;

    routingService = new RoutingService(mockConfigService, mockRedisService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with CLOSED circuit breaker state in Redis', async () => {
    expect(await routingService.getCircuitBreakerState()).toBe('CLOSED');
  });

  it('should return routed distance, duration, and geometry on successful OSRM route response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [
          {
            distance: 2450.6,
            duration: 350.2,
            geometry: {
              type: 'LineString',
              coordinates: [
                [72.6669, 23.1558],
                [72.67, 23.16],
              ],
            },
          },
        ],
      }),
    } as unknown as Response);

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    const result = await routingService.getRoute(origin, destination);

    expect(result.source).toBe('OSRM');
    expect(result.isFallback).toBe(false);
    expect(result.distanceMeters).toBe(2451);
    expect(result.durationSec).toBe(350);
    expect(result.geometry).toBeDefined();
    expect(await routingService.getCircuitBreakerState()).toBe('CLOSED');
  });

  it('should transition to OPEN circuit breaker state after 3 consecutive failures within failure window', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    // Failure 1
    await routingService.getRoute(origin, destination);
    expect(await routingService.getCircuitBreakerState()).toBe('CLOSED');
    expect(sharedRedisStore.get('cb:osrm:failures')).toBe('1');

    // Failure 2
    await routingService.getRoute(origin, destination);
    expect(await routingService.getCircuitBreakerState()).toBe('CLOSED');
    expect(sharedRedisStore.get('cb:osrm:failures')).toBe('2');

    // Failure 3 -> should trip to OPEN
    await routingService.getRoute(origin, destination);
    expect(await routingService.getCircuitBreakerState()).toBe('OPEN');
    expect(sharedRedisStore.get('cb:osrm:state')).toBe('OPEN');
    expect(sharedRedisStore.get('cb:osrm:failures')).toBe('3');
  });

  it('should reset failure window if failures occur more than 60s apart', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    // Failure 1 at t = 1000
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    await routingService.getRoute(origin, destination);
    expect(sharedRedisStore.get('cb:osrm:failures')).toBe('1');
    expect(sharedRedisStore.get('cb:osrm:first_failure_at')).toBe('1000');

    // Failure 2 at t = 20000 (within 60s window)
    vi.spyOn(Date, 'now').mockReturnValue(20000);
    await routingService.getRoute(origin, destination);
    expect(sharedRedisStore.get('cb:osrm:failures')).toBe('2');

    // Failure 3 at t = 85000 (75s after first failure, window expired!)
    vi.spyOn(Date, 'now').mockReturnValue(85000);
    await routingService.getRoute(origin, destination);

    // Failures counter resets to 1, breaker remains CLOSED
    expect(await routingService.getCircuitBreakerState()).toBe('CLOSED');
    expect(sharedRedisStore.get('cb:osrm:failures')).toBe('1');
    expect(sharedRedisStore.get('cb:osrm:first_failure_at')).toBe('85000');
  });

  it('FOCUS 1: should prevent a late success started before OPEN from closing the circuit', async () => {
    let resolveSlowFetch: (val: any) => void;
    const slowFetchPromise = new Promise((resolve) => {
      resolveSlowFetch = resolve;
    });

    // Request 1 starts when circuit is CLOSED
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => slowFetchPromise as any);

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    const slowReqPromise = routingService.getRoute(origin, destination);

    // In the meantime, 3 subsequent requests fail quickly, tripping the breaker to OPEN
    fetchSpy.mockRejectedValue(new Error('OSRM down'));
    await routingService.getRoute(origin, destination);
    await routingService.getRoute(origin, destination);
    await routingService.getRoute(origin, destination);

    expect(await routingService.getCircuitBreakerState()).toBe('OPEN');
    expect(sharedRedisStore.get('cb:osrm:state')).toBe('OPEN');

    // Now, Request 1 finally resolves successfully
    resolveSlowFetch!({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 1500, duration: 200, geometry: null }],
      }),
    });

    const slowResult = await slowReqPromise;
    expect(slowResult.source).toBe('OSRM');

    // CRITICAL INVARIANT: The late success must NOT close the circuit!
    expect(await routingService.getCircuitBreakerState()).toBe('OPEN');
    expect(sharedRedisStore.get('cb:osrm:state')).toBe('OPEN');
  });

  it('FOCUS 1: should prevent subsequent failures while OPEN from resetting the cooldown timer', async () => {
    await routingService.setCircuitBreakerState('OPEN');
    const originalOpenedAt = Date.now() - 10000;
    sharedRedisStore.set('cb:osrm:opened_at', String(originalOpenedAt));

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Another failure'));

    // A failure occurs while already OPEN
    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    // During cooldown, evaluateBreaker returns COOLDOWN_ACTIVE -> does not call fetch
    await routingService.getRoute(origin, destination);

    // Cooldown timestamp MUST NOT be updated/reset
    expect(sharedRedisStore.get('cb:osrm:opened_at')).toBe(String(originalOpenedAt));
  });

  it('FOCUS 1: should enforce HALF_OPEN probe ownership via compare-and-delete (stale probe rejection)', async () => {
    sharedRedisStore.set('cb:osrm:state', 'HALF_OPEN');
    sharedRedisStore.set('cb:osrm:generation', '5');
    // Lock held by active probe A
    sharedRedisStore.set('cb:osrm:probe_lock', 'probe-token-active-a');

    // Simulate stale probe B finishing with success after its lock expired and was reacquired by A
    const staleDecision = {
      allowed: true,
      isProbe: true,
      probeToken: 'probe-token-expired-b',
      generation: 4, // Stale generation
    };

    // Calling recordSuccess with stale decision
    await (routingService as any).recordSuccess(staleDecision);

    // Circuit breaker state remains HALF_OPEN, probe lock belongs to A, not deleted
    expect(sharedRedisStore.get('cb:osrm:state')).toBe('HALF_OPEN');
    expect(sharedRedisStore.get('cb:osrm:probe_lock')).toBe('probe-token-active-a');
  });

  it('should allow only one half-open probe across concurrent callers after cooldown', async () => {
    sharedRedisStore.set('cb:osrm:state', 'OPEN');
    sharedRedisStore.set('cb:osrm:opened_at', String(Date.now() - 31000));

    const instanceA = routingService;
    const instanceB = new RoutingService(mockConfigService, mockRedisService);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [{ distance: 1200, duration: 180, geometry: null }],
      }),
    } as unknown as Response);

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    // Instance A acquires probe lock and runs probe
    const resA = await instanceA.getRoute(origin, destination);
    expect(resA.source).toBe('OSRM');
    expect(resA.isFallback).toBe(false);

    // Instance B sees closed circuit
    expect(await instanceB.getCircuitBreakerState()).toBe('CLOSED');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should reopen circuit breaker and reset cooldown timestamp if half-open probe fails', async () => {
    sharedRedisStore.set('cb:osrm:state', 'OPEN');
    sharedRedisStore.set('cb:osrm:opened_at', String(Date.now() - 31000));

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Probe failed'));

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    const beforeCall = Date.now();
    const result = await routingService.getRoute(origin, destination);

    expect(result.source).toBe('FALLBACK');
    expect(result.isFallback).toBe(true);
    expect(await routingService.getCircuitBreakerState()).toBe('OPEN');
    expect(sharedRedisStore.get('cb:osrm:state')).toBe('OPEN');
    expect(
      Number(sharedRedisStore.get('cb:osrm:opened_at')),
    ).toBeGreaterThanOrEqual(beforeCall);
    expect(sharedRedisStore.has('cb:osrm:probe_lock')).toBe(false);
  });

  describe('FOCUS 2: Redis Outage Behavior (Degraded Mode Coverage)', () => {
    it('should operate safely in CLOSED state when Redis is unreachable', async () => {
      const brokenRedis = {
        getClient: () => {
          throw new Error('Redis connection refused');
        },
      } as unknown as RedisService;

      const degradedService = new RoutingService(mockConfigService, brokenRedis);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ distance: 2000, duration: 300, geometry: null }],
        }),
      } as unknown as Response);

      const origin = { latitude: 23.1558, longitude: 72.6669 };
      const destination = { latitude: 23.16, longitude: 72.67 };

      const result = await degradedService.getRoute(origin, destination);
      expect(result.source).toBe('OSRM');
      expect(await degradedService.getCircuitBreakerState()).toBe('CLOSED');
    });

    it('should transition to OPEN locally and fast-fallback during Redis outage', async () => {
      const brokenRedis = {
        getClient: () => {
          throw new Error('Redis connection dropped');
        },
      } as unknown as RedisService;

      const degradedService = new RoutingService(mockConfigService, brokenRedis);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OSRM down'));

      const origin = { latitude: 23.1558, longitude: 72.6669 };
      const destination = { latitude: 23.16, longitude: 72.67 };

      // 3 consecutive failures locally
      await degradedService.getRoute(origin, destination);
      await degradedService.getRoute(origin, destination);
      await degradedService.getRoute(origin, destination);

      expect(await degradedService.getCircuitBreakerState()).toBe('OPEN');

      // 4th request during cooldown fast-falls back without calling fetch
      fetchSpy.mockClear();
      const res = await degradedService.getRoute(origin, destination);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.source).toBe('FALLBACK');
      expect(res.isFallback).toBe(true);
    });

    it('should enforce single local probe in-flight during degraded mode HALF_OPEN', async () => {
      const brokenRedis = {
        getClient: () => {
          throw new Error('Redis down');
        },
      } as unknown as RedisService;

      const degradedService = new RoutingService(mockConfigService, brokenRedis);
      await degradedService.setCircuitBreakerState('HALF_OPEN');

      let resolveFetch: (val: any) => void;
      const hangingPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => hangingPromise as any);

      const origin = { latitude: 23.1558, longitude: 72.6669 };
      const destination = { latitude: 23.16, longitude: 72.67 };

      // Request 1 starts probe
      const probe1 = degradedService.getRoute(origin, destination);

      // Concurrent Request 2 within the same process is blocked and fast-falls back
      const probe2 = await degradedService.getRoute(origin, destination);
      expect(probe2.source).toBe('FALLBACK');
      expect(probe2.isFallback).toBe(true);

      // Resolve probe 1
      resolveFetch!({
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ distance: 1000, duration: 120, geometry: null }],
        }),
      });

      const probe1Res = await probe1;
      expect(probe1Res.source).toBe('OSRM');
      expect(await degradedService.getCircuitBreakerState()).toBe('CLOSED');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('PART A1: should allow repeated successful OSRM requests without throttling when Redis is unavailable', async () => {
      const brokenRedis = {
        getClient: () => {
          throw new Error('Redis down');
        },
      } as unknown as RedisService;

      const degradedService = new RoutingService(mockConfigService, brokenRedis);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ distance: 1500, duration: 180, geometry: null }],
        }),
      } as unknown as Response);

      const origin = { latitude: 23.1558, longitude: 72.6669 };
      const destination = { latitude: 23.16, longitude: 72.67 };

      // 10 repeated successful requests while Redis is down
      for (let i = 0; i < 10; i++) {
        const res = await degradedService.getRoute(origin, destination);
        expect(res.source).toBe('OSRM');
        expect(res.isFallback).toBe(false);
      }

      // Proves that when OSRM is healthy, requests are not throttled
      expect(fetchSpy).toHaveBeenCalledTimes(10);
      expect(await degradedService.getCircuitBreakerState()).toBe('CLOSED');
    });

    it('PART A1: should bound OSRM request rate to at most 1 probe per 30 seconds when Redis and OSRM are both failing', async () => {
      const brokenRedis = {
        getClient: () => {
          throw new Error('Redis down');
        },
      } as unknown as RedisService;

      const degradedService = new RoutingService(mockConfigService, brokenRedis);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OSRM dead'));

      const origin = { latitude: 23.1558, longitude: 72.6669 };
      const destination = { latitude: 23.16, longitude: 72.67 };

      // 3 failures trip to OPEN
      await degradedService.getRoute(origin, destination);
      await degradedService.getRoute(origin, destination);
      await degradedService.getRoute(origin, destination);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(await degradedService.getCircuitBreakerState()).toBe('OPEN');

      // Next 20 calls during 30s cooldown must fast-fallback locally with 0 OSRM calls
      for (let i = 0; i < 20; i++) {
        const res = await degradedService.getRoute(origin, destination);
        expect(res.source).toBe('FALLBACK');
        expect(res.isFallback).toBe(true);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(3); // Still 3, zero additional calls!

      // Cooldown elapses (simulate 31 seconds later)
      (degradedService as any).localCbOpenedAt = Date.now() - 31000;

      // 1 probe allowed
      const probeRes = await degradedService.getRoute(origin, destination);
      expect(probeRes.source).toBe('FALLBACK');
      expect(fetchSpy).toHaveBeenCalledTimes(4); // Exactly 1 probe call

      // Probe failed -> breaker re-opens and restarts cooldown
      expect(await degradedService.getCircuitBreakerState()).toBe('OPEN');

      // Subsequent 10 calls during the new cooldown must again fast-fallback
      for (let i = 0; i < 10; i++) {
        await degradedService.getRoute(origin, destination);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(4); // Still 4!
    });

    it('PART A1: should synchronize local state and prevent bypassing shared OPEN state when Redis recovers', async () => {
      // Instance was running locally in CLOSED state while Redis was down
      const recoveringService = routingService;

      // Meanwhile, Redis had state = 'OPEN' set with active cooldown
      sharedRedisStore.set('cb:osrm:state', 'OPEN');
      sharedRedisStore.set('cb:osrm:opened_at', String(Date.now())); // Cooldown active!

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const origin = { latitude: 23.1558, longitude: 72.6669 };
      const destination = { latitude: 23.16, longitude: 72.67 };

      // Request occurs after Redis connection is restored
      const res = await recoveringService.getRoute(origin, destination);

      // Must fast-fallback: process CANNOT bypass shared OPEN state
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.source).toBe('FALLBACK');
      expect(res.isFallback).toBe(true);

      // Local state is now synchronized to OPEN
      expect(await recoveringService.getCircuitBreakerState()).toBe('OPEN');
    });
  });

  describe('PART A2: Routing Authority & Matching/Detour Fallback Safety', () => {
    it('should throw ServiceUnavailableException in production if route result is a fallback', () => {
      const prodConfig = {
        get: (key: string) => (key === 'demoMode' ? false : undefined),
      } as unknown as ConfigService;

      const service = new RoutingService(prodConfig, mockRedisService);

      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        expect(() =>
          service.assertAuthoritativeRoute(
            { isFallback: true, source: 'FALLBACK' },
            'Matching Engine',
          ),
        ).toThrowError(/Matching Engine requires authoritative road-network routing/);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should allow fallback route when demoMode is enabled without throwing', () => {
      const demoConfig = {
        get: (key: string) => (key === 'demoMode' ? true : undefined),
      } as unknown as ConfigService;

      const service = new RoutingService(demoConfig, mockRedisService);

      expect(() =>
        service.assertAuthoritativeRoute(
          { isFallback: true, source: 'FALLBACK' },
          'Detour Validation',
        ),
      ).not.toThrow();
    });

    it('should allow authoritative OSRM route in production without throwing', () => {
      const prodConfig = {
        get: (key: string) => (key === 'demoMode' ? false : undefined),
      } as unknown as ConfigService;

      const service = new RoutingService(prodConfig, mockRedisService);

      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        expect(() =>
          service.assertAuthoritativeRoute(
            { isFallback: false, source: 'OSRM' },
            'Permutation Solver',
          ),
        ).not.toThrow();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('FOCUS 4: OSRM Request Failure Handling & Edge Cases', () => {
    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.16, longitude: 72.67 };

    it('should handle HTTP 500 error gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as unknown as Response);

      const result = await routingService.getRoute(origin, destination);
      expect(result.source).toBe('FALLBACK');
      expect(result.isFallback).toBe(true);
    });

    it('should handle malformed JSON gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      } as unknown as Response);

      const result = await routingService.getRoute(origin, destination);
      expect(result.source).toBe('FALLBACK');
      expect(result.isFallback).toBe(true);
    });

    it('should reject invalid metrics (NaN, negative, null) from OSRM and fall back', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [
            {
              distance: NaN,
              duration: -50,
              geometry: null,
            },
          ],
        }),
      } as unknown as Response);

      const result = await routingService.getRoute(origin, destination);
      expect(result.source).toBe('FALLBACK');
      expect(result.isFallback).toBe(true);
      expect(result.distanceMeters).toBeGreaterThan(0);
    });

    it('should fast-fallback when input coordinates are invalid without calling OSRM', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const invalidOrigin = { latitude: 120.0, longitude: 72.6669 };
      const validDest = { latitude: 23.16, longitude: 72.67 };

      const result = await routingService.getRoute(invalidOrigin, validDest);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.source).toBe('FALLBACK');
      expect(result.isFallback).toBe(true);
    });
  });

  describe('getTravelTimeMatrix', () => {
    it('should return valid matrix from OSRM table on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'Ok',
          durations: [
            [0, 180.2],
            [175.4, 0],
          ],
          distances: [
            [0, 1200.5],
            [1190.1, 0],
          ],
        }),
      } as unknown as Response);

      const coords = [
        { latitude: 23.1558, longitude: 72.6669 },
        { latitude: 23.16, longitude: 72.67 },
      ];

      const result = await routingService.getTravelTimeMatrix(coords);
      expect(result.source).toBe('OSRM');
      expect(result.isFallback).toBe(false);
      expect(result.durations).toEqual([
        [0, 180],
        [175, 0],
      ]);
    });

    it('should fallback when OSRM table returns null or unroutable cells', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'Ok',
          durations: [
            [0, null],
            [null, 0],
          ],
        }),
      } as unknown as Response);

      const coords = [
        { latitude: 23.1558, longitude: 72.6669 },
        { latitude: 23.16, longitude: 72.67 },
      ];

      const result = await routingService.getTravelTimeMatrix(coords);
      expect(result.source).toBe('FALLBACK');
      expect(result.isFallback).toBe(true);
      expect(result.durations[0][1]).toBeGreaterThan(0);
    });

    it('should handle empty or invalid coordinates array safely', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await routingService.getTravelTimeMatrix([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.source).toBe('FALLBACK');
      expect(result.isFallback).toBe(true);
      expect(result.durations).toEqual([]);
    });
  });
});
