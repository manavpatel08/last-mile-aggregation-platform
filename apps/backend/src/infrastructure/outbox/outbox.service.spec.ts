import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
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
  const validAttemptId = '55555555-5555-4555-a555-555555555555';

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
          groupVersion: 1,
        }),
      },
      dispatchAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          id: validAttemptId,
          status: 'ACTIVE',
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

  describe('validateDispatchOfferRejectedPayload', () => {
    it('should validate a correct DISPATCH_OFFER_REJECTED payload', () => {
      const payload = {
        offerId: validOfferId,
        rideGroupId: validGroupId,
        driverId: 'driver-1',
        groupVersion: 1,
        dispatchAttemptId: validAttemptId,
        reason: 'DRIVER_DECLINED',
        rejectedAt: new Date().toISOString(),
      };

      const result = service.validateDispatchOfferRejectedPayload(payload, validOfferId);
      expect(result.valid).toBe(true);
      expect(result.data?.offerId).toBe(validOfferId);
      expect(result.data?.dispatchAttemptId).toBe(validAttemptId);
    });

    it('should reject non-object or null payload', () => {
      expect(service.validateDispatchOfferRejectedPayload(null, validOfferId).valid).toBe(false);
      expect(service.validateDispatchOfferRejectedPayload('string', validOfferId).valid).toBe(false);
    });

    it('should reject payload when offerId is missing or does not match aggregateId', () => {
      expect(
        service.validateDispatchOfferRejectedPayload(
          { offerId: 'invalid-uuid', rideGroupId: validGroupId, dispatchAttemptId: validAttemptId, groupVersion: 1 },
          validOfferId,
        ).valid,
      ).toBe(false);

      expect(
        service.validateDispatchOfferRejectedPayload(
          { offerId: validOfferId, rideGroupId: validGroupId, dispatchAttemptId: validAttemptId, groupVersion: 1 },
          '99999999-9999-4999-a999-999999999999',
        ).valid,
      ).toBe(false);
    });

    it('should reject payload when dispatchAttemptId is missing or not a UUID', () => {
      const result = service.validateDispatchOfferRejectedPayload(
        { offerId: validOfferId, rideGroupId: validGroupId, dispatchAttemptId: 'not-a-uuid', groupVersion: 1 },
        validOfferId,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing valid dispatchAttemptId UUID');
    });
  });

  describe('validateDispatchOfferExpiredPayload', () => {
    it('should validate a correct DISPATCH_OFFER_EXPIRED payload', () => {
      const payload = {
        offerId: validOfferId,
        rideGroupId: validGroupId,
        driverId: 'driver-1',
        groupVersion: 1,
        dispatchAttemptId: validAttemptId,
        expiredAt: new Date().toISOString(),
      };

      const result = service.validateDispatchOfferExpiredPayload(payload, validOfferId);
      expect(result.valid).toBe(true);
      expect(result.data?.offerId).toBe(validOfferId);
      expect(result.data?.dispatchAttemptId).toBe(validAttemptId);
    });

    it('should reject non-object or null payload', () => {
      expect(service.validateDispatchOfferExpiredPayload(null, validOfferId).valid).toBe(false);
    });

    it('should reject payload when dispatchAttemptId is missing or not a UUID', () => {
      const result = service.validateDispatchOfferExpiredPayload(
        { offerId: validOfferId, rideGroupId: validGroupId, dispatchAttemptId: 'not-a-uuid', groupVersion: 1 },
        validOfferId,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing valid dispatchAttemptId UUID');
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

    it('Fix 2: should NOT mark DISPATCH_OFFER_CREATED as PUBLISHED if queue is not configured (leaves event retryable)', async () => {
      const mockEvent = {
        id: 'event-uuid-offer-no-queue',
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
        new ServiceUnavailableException({
          errorCode: 'QUEUE_NOT_AVAILABLE',
          message: 'Dispatch queue not configured; cannot schedule timeout for pending offer',
        }),
      );

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 1,
          lastError: expect.stringContaining('Dispatch queue not configured'),
        }),
      });
    });

    it('Fix 1: Rejection -> cascade fails due to OSRM outage -> OSRM recovers -> next offer created', async () => {
      const mockEvent = {
        id: 'event-uuid-reject-cascade',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: validOfferId,
        status: 'REJECTED',
        offeredAt: new Date(Date.now() - 5000),
      });

      // No existing subsequent offer or assignment
      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      // 1. Initial attempt: OSRM is down
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: false,
        reason: 'ROUTING_UNAVAILABLE',
        retryable: true,
        message: 'OSRM routing engine unavailable',
      });

      const summary1 = await service.processPendingEvents();

      expect(summary1.publishedCount).toBe(0);
      expect(summary1.retriedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: 1,
          lastError: expect.stringContaining('OSRM routing engine unavailable'),
        }),
      });

      // 2. Retry attempt: OSRM recovers, cascade succeeds
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        offerId: 'next-offer-uuid-2',
        driverId: 'driver-rank2',
      });

      const summary2 = await service.processPendingEvents();

      expect(summary2.publishedCount).toBe(1);
      expect(summary2.dispatchOfferRejectedHandledCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
        }),
      });
    });

    it('Fix 1: Expiry -> cascade fails temporarily -> subsequent retry succeeds', async () => {
      const mockEvent = {
        id: 'event-uuid-expire-cascade',
        event_type: 'DISPATCH_OFFER_EXPIRED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: validOfferId,
        status: 'EXPIRED',
        offeredAt: new Date(Date.now() - 25000),
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);

      // 1. Initial attempt: dispatch fails temporarily
      dispatchServiceMock.initiateDispatchForGroup.mockRejectedValueOnce(
        new ServiceUnavailableException('ROUTING_UNAVAILABLE'),
      );

      const summary1 = await service.processPendingEvents();

      expect(summary1.publishedCount).toBe(0);
      expect(summary1.retriedCount).toBe(1);

      // 2. Retry succeeds
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        offerId: 'next-offer-uuid-3',
        driverId: 'driver-rank3',
      });

      const summary2 = await service.processPendingEvents();

      expect(summary2.publishedCount).toBe(1);
      expect(summary2.dispatchOfferExpiredHandledCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
        }),
      });
    });

    it('Fix 1: Duplicate rejection-event delivery does not create duplicate offers or attempts', async () => {
      const mockEvent = {
        id: 'event-uuid-reject-dup',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: validOfferId,
        status: 'REJECTED',
        offeredAt: new Date(Date.now() - 5000),
      });

      // A pending offer was ALREADY created for this group (e.g. by direct cascade or earlier delivery)
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'next-offer-uuid-already-active',
        rideGroupId: validGroupId,
        status: 'PENDING',
      });

      const summary = await service.processPendingEvents();

      // Must acknowledge event WITHOUT calling dispatch again
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
        }),
      });
    });

    it('Fix 1: Duplicate expiry-event delivery does not create duplicate offers or attempts', async () => {
      const mockEvent = {
        id: 'event-uuid-expire-dup',
        event_type: 'DISPATCH_OFFER_EXPIRED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: validOfferId,
        status: 'EXPIRED',
        offeredAt: new Date(Date.now() - 25000),
      });

      // Driver was already assigned to the group
      prismaMock.driverAssignment.findFirst.mockResolvedValue({
        id: 'assignment-uuid-1',
        rideGroupId: validGroupId,
        status: 'RESERVED',
      });

      const summary = await service.processPendingEvents();

      // Must acknowledge event WITHOUT calling dispatch again
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
        }),
      });
    });

    it('Fix 1: Worker crash after next offer creation but before event acknowledgement is recovered safely', async () => {
      const mockEvent = {
        id: 'event-uuid-crash-recovery',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      const originalOfferDate = new Date(Date.now() - 10000);
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: validOfferId,
        status: 'REJECTED',
        offeredAt: originalOfferDate,
      });

      // Next offer was committed in DB before the crash occurred
      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'subsequent-offer-uuid',
        dispatchAttemptId: validAttemptId,
        offeredAt: new Date(Date.now() - 5000),
      });

      const summary = await service.processPendingEvents();

      // Recognizes subsequent offer in attempt, publishes event without creating duplicates
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(summary.publishedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
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

  describe('Targeted Review: Realtime Outbox Delivery Acknowledgment in Dispatch Cascade', () => {
    const validOfferId = '88888888-8888-4888-8888-888888888888';
    const validGroupId = '99999999-9999-4999-8999-999999999999';
    const validAttemptId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

    let realtimeServiceMock: any;
    let serviceWithRealtime: OutboxService;

    beforeEach(() => {
      realtimeServiceMock = {
        broadcastOutboxEvent: vi.fn(),
      };
      serviceWithRealtime = new OutboxService(
        prismaMock as unknown as PrismaService,
        dispatchServiceMock as unknown as DispatchService,
        realtimeServiceMock,
      );

      prismaMock.rideGroup.findUnique.mockResolvedValue({
        id: validGroupId,
        groupVersion: 1,
        status: 'DISPATCHING',
      });
      prismaMock.dispatchAttempt.findUnique.mockResolvedValue({
        id: validAttemptId,
        status: 'ACTIVE',
      });
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: validOfferId,
        status: 'REJECTED',
        offeredAt: new Date(Date.now() - 5000),
      });
    });

    it('awaits realtime broadcast and marks cascade event PUBLISHED only after successful delivery', async () => {
      const mockEvent = {
        id: 'event-cascade-success',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        offerId: 'new-offer-1',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockResolvedValueOnce(true);

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(1);
      expect(realtimeServiceMock.broadcastOutboxEvent).toHaveBeenCalledWith(mockEvent);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: expect.any(Date),
          lastError: null,
        },
      });
    });

    it('does not acknowledge cascade event as PUBLISHED when realtime broadcast rejects, leaving it retryable', async () => {
      const mockEvent = {
        id: 'event-cascade-broadcast-fail',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        offerId: 'new-offer-1',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockRejectedValueOnce(
        new Error('Socket transport network timeout'),
      );

      const summary = await serviceWithRealtime.processPendingEvents();

      // Must NOT be marked as published
      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(realtimeServiceMock.broadcastOutboxEvent).toHaveBeenCalledWith(mockEvent);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PENDING',
          retryCount: 2,
          lastError: 'Socket transport network timeout',
          publishedAt: expect.any(Date),
        },
      });
    });

    it('on retry when subsequent dispatch outcome already exists, awaits broadcast and safely marks PUBLISHED', async () => {
      const mockEvent = {
        id: 'event-cascade-subsequent-exists',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
        },
        retry_count: 2,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      // Subsequent offer already exists in DB from previous run
      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'subsequent-offer-1',
        rideGroupId: validGroupId,
        status: 'PENDING',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockResolvedValueOnce(true);

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(1);
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(realtimeServiceMock.broadcastOutboxEvent).toHaveBeenCalledWith(mockEvent);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PUBLISHED',
          publishedAt: expect.any(Date),
          lastError: null,
        },
      });
    });

    it('GROUP_FORMED: does not acknowledge event as PUBLISHED when realtime broadcast rejects in initial dispatch path, leaving it retryable', async () => {
      const mockEvent = {
        id: 'event-group-formed-fail',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: '22222222-2222-4222-a222-222222222222',
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

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findUnique.mockResolvedValue({
        id: 'new-offer-id',
        status: 'PENDING',
      });
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        offerId: 'new-offer-id',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockRejectedValueOnce(
        new Error('Socket transport disconnected during group.updated emission'),
      );

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(dispatchServiceMock.initiateDispatchForGroup).toHaveBeenCalledWith(validGroupId);
      expect(realtimeServiceMock.broadcastOutboxEvent).toHaveBeenCalledWith(mockEvent);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PENDING',
          retryCount: 1,
          lastError: 'Socket transport disconnected during group.updated emission',
          publishedAt: expect.any(Date),
        },
      });
    });

    it('GROUP_FORMED: on retry when durable dispatch outcome already exists, does not mark PUBLISHED if broadcast rejects, avoiding duplicate dispatch', async () => {
      const mockEvent = {
        id: 'event-group-formed-retry-broadcast-fail',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: '22222222-2222-4222-a222-222222222222',
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

      // Durable offer already exists from previous dispatch attempt
      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'existing-offer-uuid',
        rideGroupId: validGroupId,
        groupVersion: 1,
        status: 'PENDING',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockRejectedValueOnce(
        new Error('Redis adapter unavailable for socket room emission'),
      );

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      // Dispatch engine is NEVER re-triggered (idempotency preserved)
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(realtimeServiceMock.broadcastOutboxEvent).toHaveBeenCalledWith(mockEvent);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PENDING',
          retryCount: 2,
          lastError: 'Redis adapter unavailable for socket room emission',
          publishedAt: expect.any(Date),
        },
      });
    });

    it('GROUP_FORMED: marks event FAILED and never PUBLISHED when broadcast rejects and retry count reaches terminal limit', async () => {
      const mockEvent = {
        id: 'event-group-formed-terminal',
        event_type: 'GROUP_FORMED',
        aggregate_type: 'RIDE_GROUP',
        aggregate_id: validGroupId,
        payload: {
          rideGroupId: validGroupId,
          pickupPointId: '22222222-2222-4222-a222-222222222222',
          groupVersion: 1,
        },
        retry_count: 4, // 4 + 1 = 5 (MAX_OUTBOX_RETRIES)
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'existing-offer-uuid',
        rideGroupId: validGroupId,
        groupVersion: 1,
        status: 'PENDING',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockRejectedValueOnce(
        new Error('Fatal gateway serialization error'),
      );

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.failedCount).toBe(1);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'FAILED',
          retryCount: 5,
          lastError: 'Fatal gateway serialization error',
          publishedAt: expect.any(Date),
        },
      });
    });

    it('DISPATCH_OFFER_CREATED: does not acknowledge event as PUBLISHED when realtime broadcast rejects, leaving it retryable', async () => {
      const mockEvent = {
        id: 'event-offer-created-broadcast-fail',
        event_type: 'DISPATCH_OFFER_CREATED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
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
        scheduled: true,
        jobId: `dispatch-timeout-${validOfferId}`,
      });
      realtimeServiceMock.broadcastOutboxEvent.mockRejectedValueOnce(
        new Error('Socket transport connection reset'),
      );

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(dispatchServiceMock.scheduleOfferTimeout).toHaveBeenCalledWith(validOfferId);
      expect(realtimeServiceMock.broadcastOutboxEvent).toHaveBeenCalledWith(mockEvent);
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PENDING',
          retryCount: 1,
          lastError: 'Socket transport connection reset',
          publishedAt: expect.any(Date),
        },
      });
    });

    it('DISPATCH_OFFER_REJECTED: on retry when subsequent outcome exists, does not mark PUBLISHED if broadcast rejects', async () => {
      const mockEvent = {
        id: 'event-rejected-retry-fail',
        event_type: 'DISPATCH_OFFER_REJECTED',
        aggregate_type: 'DRIVER_DISPATCH_OFFER',
        aggregate_id: validOfferId,
        payload: {
          offerId: validOfferId,
          rideGroupId: validGroupId,
          driverId: 'driver-1',
          groupVersion: 1,
          dispatchAttemptId: validAttemptId,
        },
        retry_count: 2,
      };

      prismaMock.$transaction.mockImplementation(async (cb: any) => {
        const txMock = {
          $queryRaw: vi.fn().mockResolvedValue([mockEvent]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        };
        return cb(txMock);
      });

      prismaMock.driverAssignment.findFirst.mockResolvedValue(null);
      prismaMock.driverDispatchOffer.findFirst.mockResolvedValue({
        id: 'subsequent-offer-1',
        rideGroupId: validGroupId,
        status: 'PENDING',
      });
      realtimeServiceMock.broadcastOutboxEvent.mockRejectedValueOnce(
        new Error('Socket transport failure on retry'),
      );

      const summary = await serviceWithRealtime.processPendingEvents();

      expect(summary.publishedCount).toBe(0);
      expect(summary.retriedCount).toBe(1);
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: {
          status: 'PENDING',
          retryCount: 3,
          lastError: 'Socket transport failure on retry',
          publishedAt: expect.any(Date),
        },
      });
    });
  });
});
