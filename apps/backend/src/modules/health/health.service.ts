import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
  services: {
    api: 'healthy' | 'unhealthy';
    database: 'healthy' | 'unhealthy';
    redis: 'healthy' | 'unhealthy';
    postgis?: string | null;
  };
}

export interface ReadinessResponse {
  status: 'ready' | 'not_ready';
  database: 'connected' | 'disconnected';
  redis: 'connected' | 'disconnected';
  timestamp: string;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async getHealth(): Promise<HealthCheckResponse> {
    const [dbHealthy, redisHealthy, postgisVersion] = await Promise.all([
      this.prismaService.isHealthy(),
      this.redisService.isHealthy(),
      this.prismaService.verifyPostGIS(),
    ]);

    let overallStatus: 'ok' | 'degraded' | 'error' = 'ok';
    if (!dbHealthy && !redisHealthy) {
      overallStatus = 'error';
    } else if (!dbHealthy || !redisHealthy) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime() * 100) / 100,
      environment: this.configService.get<string>('environment', 'development'),
      version: '0.0.1',
      services: {
        api: 'healthy',
        database: dbHealthy ? 'healthy' : 'unhealthy',
        redis: redisHealthy ? 'healthy' : 'unhealthy',
        postgis: postgisVersion,
      },
    };
  }

  async getReadiness(): Promise<ReadinessResponse> {
    const [dbHealthy, redisHealthy] = await Promise.all([
      this.prismaService.isHealthy(),
      this.redisService.isHealthy(),
    ]);

    const isReady = dbHealthy && redisHealthy;

    return {
      status: isReady ? 'ready' : 'not_ready',
      database: dbHealthy ? 'connected' : 'disconnected',
      redis: redisHealthy ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    };
  }

  getLiveness(): { status: string; uptime: number; timestamp: string } {
    return {
      status: 'live',
      uptime: Math.round(process.uptime() * 100) / 100,
      timestamp: new Date().toISOString(),
    };
  }
}
