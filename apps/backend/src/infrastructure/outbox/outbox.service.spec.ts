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

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      outboxEvent: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    dispatchServiceMock = {
      initiateDispatchForGroup: vi.fn().mockResolvedValue({
        success: true,
        offerId: 'offer-1',
        driverId: 'driver-1',
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
      const mismatchedGroupId = '33333333-3333-4333-a333-333333333333';
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

    it('should claim and process valid GROUP_FORMED event, initiating dispatch', async () => {
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
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
          lastError: null,
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

      // Existing offer detected by DispatchService
      dispatchServiceMock.initiateDispatchForGroup.mockResolvedValueOnce({
        success: true,
        isExistingOffer: true,
        offerId: 'existing-offer-id',
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

    it('should mark other non-GROUP_FORMED events as PUBLISHED', async () => {
      const mockEvent = {
        id: 'event-uuid-other',
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

      const summary = await service.processPendingEvents();

      expect(summary.publishedCount).toBe(1);
      expect(dispatchServiceMock.initiateDispatchForGroup).not.toHaveBeenCalled();
      expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
        where: { id: mockEvent.id },
        data: expect.objectContaining({
          status: 'PUBLISHED',
        }),
      });
    });
  });
});
