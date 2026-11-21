import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  OutboxProcessor,
  OUTBOX_JOB_POLL,
} from './outbox.processor.js';
import { OutboxService } from './outbox.service.js';

describe('OutboxProcessor', () => {
  let processor: OutboxProcessor;
  let outboxServiceMock: any;
  let queueMock: any;

  beforeEach(() => {
    outboxServiceMock = {
      processPendingEvents: vi.fn().mockResolvedValue({
        processedCount: 2,
        publishedCount: 2,
        failedCount: 0,
        retriedCount: 0,
        groupFormedHandledCount: 1,
      }),
    };

    queueMock = {
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    };

    processor = new OutboxProcessor(
      outboxServiceMock as unknown as OutboxService,
      queueMock,
    );
  });

  it('should delegate poll-outbox-events job to OutboxService.processPendingEvents()', async () => {
    const jobMock = {
      id: 'job-outbox-1',
      name: OUTBOX_JOB_POLL,
      data: {},
    } as any;

    const result = await processor.process(jobMock);

    expect(outboxServiceMock.processPendingEvents).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      processedCount: 2,
      publishedCount: 2,
    });
  });

  it('should return null and warn for unrecognized jobs on outbox-queue', async () => {
    const jobMock = {
      id: 'job-unknown',
      name: 'unexpected-job',
      data: {},
    } as any;

    const result = await processor.process(jobMock);

    expect(result).toBeNull();
    expect(outboxServiceMock.processPendingEvents).not.toHaveBeenCalled();
  });

  it('should configure repeatable job scheduler on queue during onModuleInit', async () => {
    await processor.onModuleInit();

    expect(queueMock.upsertJobScheduler).toHaveBeenCalledWith(
      'periodic-outbox-scheduler',
      { every: 2000 },
      expect.objectContaining({
        name: OUTBOX_JOB_POLL,
      }),
    );
  });

  it('should gracefully handle missing queue in test environments during onModuleInit', async () => {
    const headlessProcessor = new OutboxProcessor(
      outboxServiceMock as unknown as OutboxService,
      undefined,
    );

    await expect(headlessProcessor.onModuleInit()).resolves.toBeUndefined();
  });
});
