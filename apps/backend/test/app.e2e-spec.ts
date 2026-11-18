import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('App & Health Endpoints (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health (GET) - full system health check', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.services.api).toBe('healthy');
    expect(res.body.services.database).toBe('healthy');
    expect(res.body.services.redis).toBe('healthy');
    expect(res.body.services.postgis).toBeDefined();
    expect(res.body.environment).toBeDefined();
    expect(res.body.version).toBe('0.0.1');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('/health/ready (GET) - readiness check for DB and Redis', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('connected');
    expect(res.body.redis).toBe('connected');
  });

  it('/health/live (GET) - liveness check for process', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);

    expect(res.body.status).toBe('live');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});
