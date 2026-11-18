import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service.js';
import type { HealthCheckResponse, ReadinessResponse } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<HealthCheckResponse> {
    const health = await this.healthService.getHealth();
    if (health.status !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const readiness = await this.healthService.getReadiness();
    if (readiness.status !== 'ready') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return readiness;
  }

  @Get('live')
  getLiveness(): { status: string; uptime: number; timestamp: string } {
    return this.healthService.getLiveness();
  }
}
