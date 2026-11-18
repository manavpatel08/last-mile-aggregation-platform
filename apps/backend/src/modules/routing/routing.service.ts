import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RouteResult {
  distanceMeters: number;
  durationSec: number;
  geometry?: unknown;
  source: 'OSRM' | 'FALLBACK';
  isFallback: boolean;
}

export interface TableMatrixResult {
  durations: number[][]; // Durations in seconds between points
  distances?: number[][]; // Distances in meters
  source: 'OSRM' | 'FALLBACK';
  isFallback: boolean;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly osrmUrl: string;

  // Circuit Breaker state
  private cbState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private cbFailureCount = 0;
  private cbLastFailureTime = 0;
  private readonly cbCooldownMs = 30000;
  private readonly cbFailureThreshold = 3;

  constructor(private readonly configService: ConfigService) {
    this.osrmUrl =
      this.configService.get<string>('routing.osrmBackendUrl') ||
      this.configService.get<string>('osrm.backendUrl') ||
      'http://127.0.0.1:5000';
  }

  getCircuitBreakerState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    return this.cbState;
  }

  setCircuitBreakerState(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
    this.cbState = state;
    if (state === 'OPEN') {
      this.cbLastFailureTime = Date.now();
      this.cbFailureCount = this.cbFailureThreshold;
    } else if (state === 'CLOSED') {
      this.cbFailureCount = 0;
      this.cbLastFailureTime = 0;
    }
  }

  resetCircuitBreaker(): void {
    this.cbState = 'CLOSED';
    this.cbFailureCount = 0;
    this.cbLastFailureTime = 0;
  }

  private recordFailure(): void {
    this.cbFailureCount++;
    this.cbLastFailureTime = Date.now();
    if (
      this.cbFailureCount >= this.cbFailureThreshold ||
      this.cbState === 'HALF_OPEN'
    ) {
      this.cbState = 'OPEN';
      this.logger.warn(
        `OSRM routing failures exceeded threshold (${this.cbFailureCount}). Circuit breaker moved to OPEN state.`,
      );
    }
  }

  /**
   * Request direct road route from origin to destination.
   * Calls OSRM /route/v1 with 1500ms timeout; gracefully falls back to
   * geodesic road-network approximation if OSRM is unavailable.
   */
  async getRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ): Promise<RouteResult> {
    if (this.cbState === 'OPEN') {
      const now = Date.now();
      if (now - this.cbLastFailureTime >= this.cbCooldownMs) {
        this.logger.log('Circuit breaker entering HALF_OPEN probe state');
        this.cbState = 'HALF_OPEN';
      } else {
        this.logger.warn(
          'OSRM circuit breaker is OPEN; fast-falling back to geodesic approximation',
        );
        return this.calculateGeodesicFallback(origin, destination);
      }
    }

    const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url = `${this.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as {
          code: string;
          routes: Array<{
            distance: number;
            duration: number;
            geometry: unknown;
          }>;
        };

        if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
          this.cbFailureCount = 0;
          this.cbState = 'CLOSED';
          const route = data.routes[0];
          return {
            distanceMeters: Math.round(route.distance),
            durationSec: Math.round(route.duration),
            geometry: route.geometry,
            source: 'OSRM',
            isFallback: false,
          };
        }
      }
      this.recordFailure();
    } catch {
      this.recordFailure();
    }

    this.logger.warn(
      'OSRM routing unavailable; geodesic fallback calculation utilized.',
    );
    return this.calculateGeodesicFallback(origin, destination);
  }

  /**
   * Compute (k+1) x (k+1) duration matrix for permutation solver.
   * Calls OSRM /table/v1; falls back to pairwise geodesic computation if unavailable.
   */
  async getTravelTimeMatrix(
    coordinates: Array<{ latitude: number; longitude: number }>,
  ): Promise<TableMatrixResult> {
    if (this.cbState === 'OPEN') {
      const now = Date.now();
      if (now - this.cbLastFailureTime >= this.cbCooldownMs) {
        this.logger.log('Circuit breaker entering HALF_OPEN probe state');
        this.cbState = 'HALF_OPEN';
      } else {
        this.logger.warn(
          'OSRM circuit breaker is OPEN; fast-falling back to pairwise geodesic approximation',
        );
        return this.calculatePairwiseFallback(coordinates);
      }
    }

    const coordsStr = coordinates
      .map((c) => `${c.longitude},${c.latitude}`)
      .join(';');
    const url = `${this.osrmUrl}/table/v1/driving/${coordsStr}?annotations=duration,distance`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as {
          code: string;
          durations: number[][];
          distances?: number[][];
        };

        if (data.code === 'Ok' && data.durations) {
          this.cbFailureCount = 0;
          this.cbState = 'CLOSED';
          return {
            durations: data.durations.map((row) =>
              row.map((val) => Math.round(val)),
            ),
            distances: data.distances?.map((row) =>
              row.map((val) => Math.round(val)),
            ),
            source: 'OSRM',
            isFallback: false,
          };
        }
      }
      this.recordFailure();
    } catch {
      this.recordFailure();
    }

    this.logger.warn(
      'OSRM routing matrix unavailable; geodesic pairwise fallback calculation utilized.',
    );
    return this.calculatePairwiseFallback(coordinates);
  }

  private calculatePairwiseFallback(
    coordinates: Array<{ latitude: number; longitude: number }>,
  ): TableMatrixResult {
    const n = coordinates.length;
    const durations: number[][] = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => 0),
    );
    const distances: number[][] = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => 0),
    );

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          durations[i][j] = 0;
          distances[i][j] = 0;
        } else {
          const res = this.calculateGeodesicFallback(
            coordinates[i],
            coordinates[j],
          );
          durations[i][j] = res.durationSec;
          distances[i][j] = res.distanceMeters;
        }
      }
    }

    return { durations, distances, source: 'FALLBACK', isFallback: true };
  }

  /**
   * Fallback road distance and duration calculation using Haversine formula
   * with 1.25x road factor and 25 km/h average e-rickshaw speed (~6.94 m/s).
   */
  calculateGeodesicFallback(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ): RouteResult {
    const earthRadiusMeters = 6371000;
    const toRadians = (deg: number) => (deg * Math.PI) / 180;

    const lat1 = toRadians(origin.latitude);
    const lat2 = toRadians(destination.latitude);
    const deltaLat = toRadians(destination.latitude - origin.latitude);
    const deltaLon = toRadians(destination.longitude - origin.longitude);

    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(deltaLon / 2) *
        Math.sin(deltaLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const straightLineMeters = earthRadiusMeters * c;

    // Road network winding factor (1.25x straight-line distance in urban corridor)
    const roadDistanceMeters = Math.max(
      100,
      Math.round(straightLineMeters * 1.25),
    );

    // E-rickshaw average speed: 25 km/h = 6.944 m/s
    const durationSec = Math.max(
      30,
      Math.round(roadDistanceMeters / 6.944),
    );

    return {
      distanceMeters: roadDistanceMeters,
      durationSec,
      geometry: null,
      source: 'FALLBACK',
      isFallback: true,
    };
  }
}
