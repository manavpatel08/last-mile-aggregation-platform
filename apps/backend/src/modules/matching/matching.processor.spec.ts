import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { MatchingProcessor, MATCHING_JOB_PERIODIC } from './matching.processor.js';
import { MatchingService } from './matching.service.js';
import type { Job, Queue } from 'bullmq';

describe('MatchingProcessor (BullMQ Worker)', () => {
  let processor: MatchingProcessor;
  let matchingService: MatchingService;
  let matchingQueue: Queue;
  let upsertSchedulerMock: Mock;
  let addMock: Mock;
  let processCycleMock: Mock;

  beforeEach(() => {
    processCycleMock = vi.fn();
    upsertSchedulerMock = vi.fn().mockResolvedValue({});
    addMock = vi.fn().mockResolvedValue({ id: 'job-123' });

    matchingService = {
      processMatchingCycle: processCycleMock,
    } as unknown as MatchingService;

    matchingQueue = {
      upsertJobScheduler: upsertSchedulerMock,
      add: addMock,
    } as unknown as Queue;

    processor = new MatchingProcessor(matchingService, matchingQueue);
  });

  describe('onModuleInit (Scheduler Registration)', () => {
    it('should configure repeatable 60-second periodic matching job scheduler', async () => {
      await processor.onModuleInit();

      expect(upsertSchedulerMock).toHaveBeenCalledWith(
        'periodic-matching-pdeu-scheduler',
        { every: 60000 },
        expect.objectContaining({
          name: MATCHING_JOB_PERIODIC,
          data: { pickupPointName: 'PDEU Main Gate', triggeredBy: 'scheduler' },
        }),
      );
    });
  });

  describe('process (Worker Execution)', () => {
    it('should process periodic job and return matching summary', async () => {
      const mockSummary = {
        batchId: 'batch-abc',
        pickupPointId: 'pickup-123',
        totalEligibleBookings: 4,
        groupsFormedCount: 1,
        formedGroupIds: ['group-1'],
        startedAt: new Date(),
        completedAt: new Date(),
      };

      processCycleMock.mockResolvedValue(mockSummary);

      const job = {
        id: 'job-1',
        name: MATCHING_JOB_PERIODIC,
        data: { pickupPointName: 'PDEU Main Gate' },
      } as Job;

      const result = await processor.process(job);
      expect(result).toEqual(mockSummary);
      expect(processCycleMock).toHaveBeenCalledWith('PDEU Main Gate');
    });

    it('should handle skipped cycles gracefully when lease is held by another worker', async () => {
      processCycleMock.mockResolvedValue(null);

      const job = {
        id: 'job-2',
        name: MATCHING_JOB_PERIODIC,
        data: { pickupPointName: 'PDEU Main Gate' },
      } as Job;

      const result = await processor.process(job);
      expect(result).toBeNull();
    });
  });

  describe('triggerImmediateMatching (On-Demand Trigger)', () => {
    it('should enqueue on-demand matching job immediately', async () => {
      const job = await processor.triggerImmediateMatching('PDEU Main Gate');
      expect(addMock).toHaveBeenCalledWith(
        'on-demand-matching',
        { pickupPointName: 'PDEU Main Gate', triggeredBy: 'manual-trigger' },
        expect.objectContaining({ removeOnComplete: true }),
      );
      expect(job.id).toBe('job-123');
    });
  });
});
