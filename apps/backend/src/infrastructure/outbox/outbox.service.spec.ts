import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OutboxService } from './outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DispatchService } from '../../modules/dispatch/dispatch.service.js';

describe('OutboxService', () => {
  let service: OutboxService;
  let prismaMock: any;
  let dispatchServiceMock: any;

  const validGroupId = '11111111-1111-4111-a111-111111111111';
  const validPickupPointId = '22222222-2222-4222-a222-222222222222';
  const validOfferId = '33333333-3333-4333-a333-333333333333';

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      outboxEvent: {
        update: vi.fn().mockResolvedValue({}),
      },
      driverAssignment: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      driverDispatchOffer: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({
          id: validOfferId,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 20000),
        }),
      },
      rideGroup: {
        findUnique: vi.fn().mockResolvedValue({
          id: validGroupId,
          status: 'READY_FOR_DISPATCH',
        }),
      },
    };

    dispatchServiceMock = {
      initiateDispatchForGroup: vi.fn().mockResolvedValue({
        success: true,
        offerId: validOfferId,
        driverId: 'driver-1',
      }),
      scheduleOfferTimeout: vi.fn().mockResolvedValue({
        scheduled: true,
        jobId: `dispatch-timeout-${validOfferId}`,
      }),
    };

    service = new OutboxService(
      prismaMock as unknown as PrismaService,
      dispatchServiceMock as unknown as DispatchService,
    );
  });

  describe('validateGroupFormedPayload', () => {
    it('should validate a correct GROUP_FORMED payload', () => {
      const payload = {
        rideGroupId: validGroupId,
        pickupPointId: validPickupPointId,
        groupVersion: 1,
        status: 'READY_FOR_DISPATCH',
      };

      const result = service.validateGroupFormedPayload(payload, validGroupId);
      expect(result.valid).toBe(true);
      expect(result.data?.rideGroupId).toBe(validGroupId);
      expect(result.data?.groupVersion).toBe(1);
    });

    it('should reject non-object or null payloads', () => {
      expect(service.validateGroupFormedPayload(null, validGroupId).valid).toBe(false);
      expect(service.validateGroupFormedPayload('string', validGroupId).valid).toBe(false);
      expect(service.validateGroupFormedPayload([], validGroupId).valid).toBe(false);
    });

    it('should reject payload when rideGroupId is missing or not a UUID', () => {
      const payload = {
        rideGroupId: 'not-a-uuid',
        pickupPointId: validPickupPointId,
        groupVersion: 1,
      };
      const result = service.validateGroupFormedPayload(payload, validGroupId);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing valid rideGroupId UUID');
    });

    it('should reject payload when rideGroupId does not match aggregateId', () => {
      const mismatchedGroupId = '99999999-9999-4999-a999-999999999999';
      const payload = {
        rideGroupId: mismatchedGroupId,
        pickupPointId: validPickupPointId,
        groupVersion: 1,
      };
      const result = service.validateGroupFormedPayload(payload, validGroupId);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not match aggregateId');
    });

    it('should reject payload when pickupPointId is missing or not a UUID', () => {
      const payload = {
        rideGroupId: validGroupId,
        pickupPointId: 'invalid-pickup',
        groupVersion: 1,
      };
      const result = service.validateGroupFormedPayload(payload, validGroupId);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing valid pickupPointId UUID');
    });

    it('should reject payload when groupVersion is less than 1 or not integer', () => {
      expect(
        service.validateGroupFormedPayload(
          { rideGroupId: validGroupId, pickupPointId: validPickupPointId, groupVersion: 0 },
          validGroupId,
        ).valid,
      ).toBe(false);

      expect(
        service.validateGroupFormedPayload(
          { rideGroupId: validGroupId, pickupPointId: validPickupPointId, groupVersion: 1.5 },
          validGroupId,
        ).valid,
      ).toBe(false);
    });
  });

  describe('validateDispatchOfferCreatedPayload', () => {
    it('should validate a correct DISPATCH_OFFER_CREATED payload', () => {
      const payload = {
        offerId: validOfferId,
        rideGroupId: validGroupId,
        driverId: 'driver-1',
        groupVersion: 1,
      };

      const result = service.validateDispatchOfferCreatedPayload(payload, validOfferId);
      expect(result.valid).toBe(true);
      expect(result.data?.offerId).toBe(validOfferId);
    });

    it('should reject payload when offerId is missing or not a UUID', () => {
      const result = service.validateDispatchOfferCreatedPayload(
        { offerId: 'invalid' },
        validOfferId,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing valid offerId UUID');
    });

    it('should reject payload when offerId does not match aggregateId', () => {
      const result = service.validateDispatchOfferCreatedPayload(
        { offerId: validOfferId },
        '99999999-9999-4999-a999-999999999999',
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not match aggregateId');
    });
  });

  describe('processPendingEvents', () => {
    it('should return zero counts when no pending events exist', async () => {
      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          $executeRaw: vi.fn(),
        };
        return cb(txMock);
      });

      const summary = await service.processPendingEvents();
      expect(summary.processedCount).toBe(0);
      expect(summary.publishedCount).toBe(0);
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
    });

    it('should claim and process valid GROUP_FORMED event, verifying durable DB outcome before acknowledging', async () => {
      const mockEvent = {
        id: 'event-uuid-1',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      const summary = await service.processPendingEvents();

      expect(summary.processedCount).toBe(1);
      expect(summary.publishedCount).toBe(1);
      expect(summary.groupFormedHandledCount).toBe(1);
      expect(dispatchServiceMock.initiateDispatchForGroup).toHaveBeenCalledWith(validGroupId);
      expect(prismaMock.driverDispatchOffer.findUnique).toHaveBeenCalledWith({
        where: { id: validOfferId },
      });
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
        }),
      });
    });

    it('should NOT acknowledge GROUP_FORMED if dispatch reported offer was not durably found in DB', async () => {
      const mockEvent = {
        id: 'event-uuid-phantom',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      // Offer missing in database
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValueOnce(null);

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 1,
          lastError: expect.stringContaining('not found in database'),
        }),
      });
    });

    it('should NOT acknowledge GROUP_FORMED if dispatch returns retryable failure (ROUTING_UNAVAILABLE)', async () => {
      const mockEvent = {
        id: 'event-uuid-routing-fail',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: false,
        reason: 'ROUTING_UNAVAILABLE',
        retryable: true,
        message: 'OSRM routing engine unavailable',
      });

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 1,
          lastError: 'OSRM routing engine unavailable',
        }),
      });
    });

    it('should NOT acknowledge GROUP_FORMED if dispatch returns retryable failure (FLEET_EXHAUSTED)', async () => {
      const mockEvent = {
        id: 'event-uuid-fleet-fail',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: false,
        reason: 'FLEET_EXHAUSTED',
        retryable: true,
        message: 'All eligible candidate drivers have been exhausted',
      });

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 1,
          lastError: 'All eligible candidate drivers have been exhausted',
        }),
      });
    });

    it('should acknowledge GROUP_FORMED if group is already assigned or terminal (INVALID_GROUP_STATUS)', async () => {
      const mockEvent = {
        id: 'event-uuid-already-assigned',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: false,
        reason: 'INVALID_GROUP_STATUS',
        message: "Ride group status is 'DRIVER_ASSIGNED'",
      });

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });

    it('should handle duplicate GROUP_FORMED delivery idempotently', async () => {
      const mockEvent = {
        id: 'event-uuid-dup',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        isExistingOffer: true,
        offerId: validOfferId,
      });

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });

    it('Scenario 2: should acknowledge GROUP_FORMED when offer was created and accepted before acknowledgement', async () => {
      const mockEvent = {
        id: 'event-uuid-offer-accepted',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      // Assignment exists because driver already accepted the offer
      prismaMock.driverAssignment.findFirst.mockResolvedValueOnce({
        id: 'assignment-uuid-1',
        rideGroupId: validGroupId,
        driverId: 'driver-1',
        status: 'RESERVED',
      });
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValueOnce({
        id: validOfferId,
        rideGroupId: validGroupId,
        groupVersion: 1,
        status: 'ACCEPTED',
      });

      const summary = await service.processPendingEvents();

      // Verified: dispatchService is NOT called again (no duplicate offers or attempts)
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });

    it('Scenario 2: should acknowledge GROUP_FORMED when offer was created and expired or withdrawn before acknowledgement', async () => {
      const mockEvent = {
        id: 'event-uuid-offer-expired',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      // Offer exists for group/version with EXPIRED status
      prismaMock.driverAssignment.findFirst.mockResolvedValueOnce(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValueOnce({
        id: validOfferId,
        rideGroupId: validGroupId,
        groupVersion: 1,
        status: 'EXPIRED',
      });

      const summary = await service.processPendingEvents();

      // Verified: dispatchService is NOT called again
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });

    it('Scenario 2: should recognize existing durable offer on duplicate GROUP_FORMED delivery and avoid duplicate attempts', async () => {
      const mockEvent = {
        id: 'event-uuid-dup-check',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      // Existing durable offer in PENDING
      prismaMock.driverAssignment.findFirst.mockResolvedValueOnce(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValueOnce({
        id: validOfferId,
        rideGroupId: validGroupId,
        groupVersion: 1,
        status: 'PENDING',
      });

      const summary = await service.processPendingEvents();

      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });

    it('should process DISPATCH_OFFER_CREATED by scheduling durable timeout job', async () => {
      const mockEvent = {
        id: 'event-uuid-offer',
        event_type: 'DISPATCH_OFFER_CREATED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      const summary = await service.processPendingEvents();

      expect(summary.processedCount).toBe(1);
      expect(summary.publishedCount).toBe(1);
      expect(summary.dispatchOfferCreatedHandledCount).toBe(1);
      expect(dispatchServiceMock.scheduleOfferTimeout).toHaveBeenCalledWith(validOfferId);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
        }),
      });
    });

    it('should NOT mark DISPATCH_OFFER_CREATED as PUBLISHED if queue.add throws (leaves event retryable)', async () => {
      const mockEvent = {
        id: 'event-uuid-offer-fail',
        event_type: 'DISPATCH_OFFER_CREATED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.scheduleOfferTimeout.mockRejectedValueOnce(
        new Error('Redis connection refused'),
      );

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 1,
          lastError: 'Redis connection refused',
        }),
      });
    });

    it('should mark DISPATCH_OFFER_CREATED as PUBLISHED if offer is already terminal (no-op scheduling)', async () => {
      const mockEvent = {
        id: 'event-uuid-offer-terminal',
        event_type: 'DISPATCH_OFFER_CREATED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.scheduleOfferTimeout.mockResolvedValueOnce({
        scheduled: false,
        reason: 'OFFER_STATUS_ACCEPTED',
      });

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });

    it('should NOT mark unsupported event types as PUBLISHED and unclaim them back to PENDING', async () => {
      const mockEvent = {
        id: 'event-uuid-unsupported',
        event_type: 'BOOKING_CREATED',
        aggregate_type: 'BOOKING',
        aggregate_id: '44444444-4444-4444-a444-444444444444',
        payload: { bookingId: '44444444-4444-4444-a444-444444444444' },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      const summary = await service.processPendingEvents(50, { eventType: 'BOOKING_CREATED' });

      // Must NOT be acknowledged as published
      expect(summary.publishedCount).toBe(0);
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(dispatchServiceMock.scheduleOfferTimeout).not.toHaveBeenCalled();
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PENDING',
          publishedAt: null,
        },
      });
    });

    it('should mark event FAILED when payload is malformed without calling dispatch', async () => {
      const mockEvent = {
        id: 'event-uuid-bad',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: 'invalid-id',
        },
        retry_count: 0,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      const summary = await service.processPendingEvents();

      expect(summary.failedCount).toBe(1);
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('missing valid rideGroupId UUID'),
        }),
      });
    });

    it('should retry transient dispatch failures up to max retries before terminal failure', async () => {
      const mockEvent = {
        id: 'event-uuid-retry',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 1,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.initiateDispatchForGroup.mockRejectedValueOnce(
        new Error('PostgreSQL connection drop'),
      );

      const summary = await service.processPendingEvents();

      expect(summary.retriedCount).toBe(1);
      expect(summary.failedCount).toBe(0);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 2,
          lastError: 'PostgreSQL connection drop',
        }),
      });
    });

    it('should mark event terminal FAILED when retry count reaches threshold (5)', async () => {
      const mockEvent = {
        id: 'event-uuid-terminal',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: validPickupPointId,
          groupVersion: 1,
        },
        retry_count: 4, // 4 + 1 = 5 (terminal)
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      dispatchServiceMock.initiateDispatchForGroup.mockRejectedValueOnce(
        new Error('Fatal unrecoverable error'),
      );

      const summary = await service.processPendingEvents();

      expect(summary.failedCount).toBe(1);
      expect(summary.retriedCount).toBe(0);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'FAILED',
          retryCount: 5,
          lastError: 'Fatal unrecoverable error',
        }),
      });
    });
  });
});
