import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RoutingService } from './routing.service.js';

describe('RoutingService (Circuit Breaker & Fallback Safety)', () => {
  let routingService: RoutingService;
  let mockConfigService: ConfigService;

  beforeEach(() => {
    mockConfigService = {
      get: (key: string) => {
        if (key === 'routing.osrmBackendUrl' || key === 'osrm.backendUrl') {
          return 'http://127.0.0.1:5000';
        }
        return undefined;
      },
    } as unknown as ConfigService;

    routingService = new RoutingService(mockConfigService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with CLOSED circuit breaker state', () => {
    expect(routingService.getCircuitBreakerState()).toBe('CLOSED');
  });

  it('should return geodesic fallback with isFallback=true when OSRM is unreachable', async () => {
    // Mock global fetch to reject (simulating offline OSRM)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.1600, longitude: 72.6700 };

    const result = await routingService.getRoute(origin, destination);

    expect(result.source).toBe('FALLBACK');
    expect(result.isFallback).toBe(true);
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(result.durationSec).toBeGreaterThan(0);
  });

  it('should transition to OPEN circuit breaker state after 3 consecutive failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.1600, longitude: 72.6700 };

    // Failure 1
    await routingService.getRoute(origin, destination);
    expect(routingService.getCircuitBreakerState()).toBe('CLOSED');

    // Failure 2
    await routingService.getRoute(origin, destination);
    expect(routingService.getCircuitBreakerState()).toBe('CLOSED');

    // Failure 3 -> should trip to OPEN
    await routingService.getRoute(origin, destination);
    expect(routingService.getCircuitBreakerState()).toBe('OPEN');
  });

  it('should fast-fallback when circuit breaker is OPEN without calling fetch', async () => {
    routingService.setCircuitBreakerState('OPEN');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.1600, longitude: 72.6700 };

    const result = await routingService.getRoute(origin, destination);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.source).toBe('FALLBACK');
    expect(result.isFallback).toBe(true);
  });

  it('should recover from HALF_OPEN to CLOSED upon successful OSRM response', async () => {
    routingService.setCircuitBreakerState('HALF_OPEN');

    // Mock successful OSRM response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [
          {
            distance: 1500,
            duration: 216,
            geometry: { type: 'LineString', coordinates: [] },
          },
        ],
      }),
    } as unknown as Response);

    const origin = { latitude: 23.1558, longitude: 72.6669 };
    const destination = { latitude: 23.1600, longitude: 72.6700 };

    const result = await routingService.getRoute(origin, destination);

    expect(result.source).toBe('OSRM');
    expect(result.isFallback).toBe(false);
    expect(result.distanceMeters).toBe(1500);
    expect(result.durationSec).toBe(216);
    expect(routingService.getCircuitBreakerState()).toBe('CLOSED');
  });
});
