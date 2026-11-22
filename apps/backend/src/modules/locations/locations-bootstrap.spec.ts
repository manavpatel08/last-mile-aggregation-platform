import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationsService } from './locations.service.js';

describe('LocationsService — Admin Provisioning Security (Stage 11 Task 2)', () => {
  let prismaMock: any;

  beforeEach(() => {
    prismaMock = {
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
  });

  it('5a. Admin provisioning is disabled in production even if DEMO_MODE is set', async () => {
    const prodConfig = new ConfigService({
      environment: 'production',
      DEMO_MODE: true,
      demoMode: true,
    });

    const service = new LocationsService(prismaMock, prodConfig);
    await service.bootstrapDefaults();

    // Must call $executeRaw only ONCE for authoritative production defaults
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);

    // Verify the executed query did NOT contain admin@pdeu.ac.in
    const executedSql = JSON.stringify(prismaMock.$executeRaw.mock.calls[0]);
    expect(executedSql).not.toContain('admin@pdeu.ac.in');
    expect(executedSql).not.toContain('PDEU Demo Station');
  });

  it('5b. Admin provisioning is disabled when DEMO_MODE is false or undefined', async () => {
    const devConfig = new ConfigService({
      environment: 'development',
      DEMO_MODE: false,
      demoMode: false,
    });

    const service = new LocationsService(prismaMock, devConfig);
    await service.bootstrapDefaults();

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);

    const executedSql = JSON.stringify(prismaMock.$executeRaw.mock.calls[0]);
    expect(executedSql).not.toContain('admin@pdeu.ac.in');
    expect(executedSql).not.toContain('PDEU Demo Station');
  });

  it('5c. Admin provisioning and PDEU Demo Station are enabled in non-production with DEMO_MODE=true', async () => {
    const demoConfig = new ConfigService({
      environment: 'development',
      DEMO_MODE: true,
      demoMode: true,
    });

    const service = new LocationsService(prismaMock, demoConfig);
    await service.bootstrapDefaults();

    // Must call $executeRaw TWICE: once for standard defaults and once for demo admin & demo station
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);

    const demoSql = JSON.stringify(prismaMock.$executeRaw.mock.calls[1]);
    expect(demoSql).toContain('admin@pdeu.ac.in');
    expect(demoSql).toContain('PDEU Demo Station');
  });
});
