import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import configuration from '../../config/configuration.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

describe('HealthController', () => {
  let controller: HealthController;
  let prismaMock: { isHealthy: ReturnType<typeof vi.fn>; verifyPostGIS: ReturnType<typeof vi.fn> };
  let redisMock: { isHealthy: ReturnType<typeof vi.fn> };

  const createMockResponse = () => {
    return {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
    };
  };

  beforeEach(async () => {
    prismaMock = {
      isHealthy: vi.fn().mockResolvedValue(true),
      verifyPostGIS: vi.fn().mockResolvedValue('3.7 USE_GEOS=1 USE_PROJ=1 USE_STATS=1'),
    };

    redisMock = {
      isHealthy: vi.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [configuration],
        }),
      ],
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getHealth()', () => {
    it('should return ok when both database and redis are healthy', async () => {
      const mockRes = createMockResponse();
      const result = await controller.getHealth(mockRes as any);

      expect(result.status).toBe('ok');
      expect(result.services.api).toBe('healthy');
      expect(result.services.database).toBe('healthy');
      expect(result.services.redis).toBe('healthy');
      expect(result.services.postgis).toContain('3.7');
      expect(mockRes.statusCode).toBe(200);
    });

    it('should return degraded and HTTP 503 when Redis is unhealthy', async () => {
      redisMock.isHealthy.mockResolvedValue(false);
      const mockRes = createMockResponse();
      const result = await controller.getHealth(mockRes as any);

      expect(result.status).toBe('degraded');
      expect(result.services.database).toBe('healthy');
      expect(result.services.redis).toBe('unhealthy');
      expect(mockRes.statusCode).toBe(503);
    });

    it('should return error and HTTP 503 when both database and Redis are unhealthy', async () => {
      prismaMock.isHealthy.mockResolvedValue(false);
      redisMock.isHealthy.mockResolvedValue(false);
      const mockRes = createMockResponse();
      const result = await controller.getHealth(mockRes as any);

      expect(result.status).toBe('error');
      expect(result.services.database).toBe('unhealthy');
      expect(result.services.redis).toBe('unhealthy');
      expect(mockRes.statusCode).toBe(503);
    });
  });

  describe('getReadiness()', () => {
    it('should return ready and status 200 when all dependencies are connected', async () => {
      const mockRes = createMockResponse();
      const result = await controller.getReadiness(mockRes as any);

      expect(result.status).toBe('ready');
      expect(result.database).toBe('connected');
      expect(result.redis).toBe('connected');
      expect(mockRes.statusCode).toBe(200);
    });

    it('should return not_ready and HTTP 503 when database is disconnected', async () => {
      prismaMock.isHealthy.mockResolvedValue(false);
      const mockRes = createMockResponse();
      const result = await controller.getReadiness(mockRes as any);

      expect(result.status).toBe('not_ready');
      expect(result.database).toBe('disconnected');
      expect(mockRes.statusCode).toBe(503);
    });
  });

  describe('getLiveness()', () => {
    it('should return live status', () => {
      const result = controller.getLiveness();
      expect(result.status).toBe('live');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(Date.parse(result.timestamp)).not.toBeNaN();
    });
  });
});
