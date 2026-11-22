import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulationService } from './simulation.service.js';

describe('Matching Isolation — Dedicated Demo Pickup Point (Stage 11 Task 4)', () => {
  let service: SimulationService;
  let prismaMock: any;
  let matchingServiceMock: any;
  let dispatchServiceMock: any;
  let faresServiceMock: any;
  let bookingsServiceMock: any;
  let authServiceMock: any;
  let driversServiceMock: any;
  let configService: ConfigService;

  const DEMO_STATION_ID = '00000000-0000-0000-0000-000000000099';
  const MAIN_GATE_ID = '00000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    configService = new ConfigService({
      environment: 'development',
      DEMO_MODE: true,
      demoMode: true,
    });

    prismaMock = {
      pickupPoint: {
        findFirst: vi.fn(),
      },
      driverProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'driver-profile-demo',
          verificationStatus: 'APPROVED',
          vehicles: [{ id: 'veh-1', makeModel: 'Mahindra Treo' }],
        }),
      },
    };

    matchingServiceMock = {
      processMatchingCycle: vi.fn().mockResolvedValue({
        batchId: 'batch-1',
        pickupPointId: DEMO_STATION_ID,
        groupsFormedCount: 1,
        formedGroupIds: ['group-demo-1'],
      }),
    };

    dispatchServiceMock = {
      initiateDispatchForGroup: vi.fn().mockResolvedValue({ offerId: 'offer-1' }),
    };

    faresServiceMock = {
      generateQuote: vi.fn().mockResolvedValue({ quoteId: 'quote-1' }),
    };

    bookingsServiceMock = {
      createBooking: vi.fn().mockResolvedValue({
        bookingId: 'booking-1',
        status: 'REQUESTED',
      }),
    };

    authServiceMock = {
      authenticateWithGoogle: vi.fn().mockImplementation((token: string) => {
        if (token.includes('passenger1')) {
          return { user: { id: 'pax-1-id', email: 'demo.passenger1@pdeu.ac.in' }, accessToken: 'token-1' };
        }
        if (token.includes('passenger2')) {
          return { user: { id: 'pax-2-id', email: 'demo.passenger2@pdeu.ac.in' }, accessToken: 'token-2' };
        }
        return { user: { id: 'driver-id', email: 'demo.driver@pdeu.ac.in' }, accessToken: 'token-drv' };
      }),
    };

    driversServiceMock = {
      onboardDriver: vi.fn(),
      approveDriver: vi.fn(),
      updateDriverOperationalStatus: vi.fn(),
      recordDriverLocation: vi.fn(),
    };

    service = new SimulationService(
      prismaMock,
      matchingServiceMock,
      dispatchServiceMock,
      {} as any, // tripsService
      driversServiceMock,
      bookingsServiceMock,
      faresServiceMock,
      authServiceMock,
      {} as any, // redisService
      configService,
      {} as any, // realtimeGateway
    );
  });

  it('8. Simulation creates bookings strictly at dedicated PDEU Demo Station', async () => {
    // When pickup points exist
    prismaMock.pickupPoint.findFirst.mockImplementation(({ where }: any) => {
      if (where.name === 'PDEU Demo Station') {
        return Promise.resolve({ id: DEMO_STATION_ID, name: 'PDEU Demo Station', isActive: true });
      }
      if (where.name === 'PDEU Main Gate') {
        return Promise.resolve({ id: MAIN_GATE_ID, name: 'PDEU Main Gate', isActive: true });
      }
      return Promise.resolve(null);
    });

    const res = await service.createDemoBookings();

    expect(res.pickupPointId).toBe(DEMO_STATION_ID);
    expect(res.pickupPointName).toBe('PDEU Demo Station');

    // Both quotes generated must use DEMO_STATION_ID, isolating them from MAIN_GATE_ID
    expect(faresServiceMock.generateQuote).toHaveBeenCalledWith(
      'pax-1-id',
      expect.objectContaining({ pickupPointId: DEMO_STATION_ID }),
    );
    expect(faresServiceMock.generateQuote).toHaveBeenCalledWith(
      'pax-2-id',
      expect.objectContaining({ pickupPointId: DEMO_STATION_ID }),
    );
  });

  it('8b. Simulation triggerMatching executes matching cycle isolated to PDEU Demo Station', async () => {
    prismaMock.pickupPoint.findFirst.mockResolvedValue({
      id: DEMO_STATION_ID,
      name: 'PDEU Demo Station',
      isActive: true,
    });

    const res = await service.triggerMatching();

    // Verify matching is triggered specifically for PDEU Demo Station with its dedicated lease key
    expect(matchingServiceMock.processMatchingCycle).toHaveBeenCalledWith(
      'PDEU Demo Station',
      'lease:matching:pdeu-demo-station',
    );

    // Verify dispatch is initiated immediately for formed demo group
    expect(dispatchServiceMock.initiateDispatchForGroup).toHaveBeenCalledWith('group-demo-1');
    expect(res?.groupsFormedCount).toBe(1);
  });

  it('8c. createDemoBookings strictly fails with NotFoundException if PDEU Demo Station does not exist (no fallback to Main Gate)', async () => {
    // Only PDEU Main Gate exists in DB
    prismaMock.pickupPoint.findFirst.mockImplementation(({ where }: any) => {
      if (where.name === 'PDEU Main Gate') {
        return Promise.resolve({ id: MAIN_GATE_ID, name: 'PDEU Main Gate', isActive: true });
      }
      return Promise.resolve(null);
    });

    await expect(service.createDemoBookings()).rejects.toThrowError(
      'PDEU Demo Station pickup hub not found in database',
    );

    // Fares service must NOT be called for quotes
    expect(faresServiceMock.generateQuote).not.toHaveBeenCalled();
  });

  it('8d. triggerMatching strictly fails with NotFoundException if PDEU Demo Station does not exist', async () => {
    // Only PDEU Main Gate exists in DB
    prismaMock.pickupPoint.findFirst.mockImplementation(({ where }: any) => {
      if (where.name === 'PDEU Main Gate') {
        return Promise.resolve({ id: MAIN_GATE_ID, name: 'PDEU Main Gate', isActive: true });
      }
      return Promise.resolve(null);
    });

    await expect(service.triggerMatching()).rejects.toThrowError(
      'Pickup hub [PDEU Demo Station] not found in database',
    );

    // Matching cycle must NOT be triggered
    expect(matchingServiceMock.processMatchingCycle).not.toHaveBeenCalled();
  });

  it('8e. triggerMatching strictly throws ServiceUnavailableException when matching was skipped due to ROUTING_UNAVAILABLE', async () => {
    prismaMock.pickupPoint.findFirst.mockResolvedValue({
      id: DEMO_STATION_ID,
      name: 'PDEU Demo Station',
      isActive: true,
    });

    matchingServiceMock.processMatchingCycle.mockResolvedValue({
      batchId: 'batch-1',
      pickupPointId: DEMO_STATION_ID,
      groupsFormedCount: 0,
      formedGroupIds: [],
      skippedReason: 'ROUTING_UNAVAILABLE',
    });

    await expect(service.triggerMatching()).rejects.toThrowError(
      'Matching engine requires authoritative road-network routing, but local OSRM routing service is unavailable on port 5000. Launch OSRM (or configure OSRM_BACKEND_URL) to form ride groups.',
    );

    // Dispatch initiation must NOT be called for empty groups
    expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
  });
});
