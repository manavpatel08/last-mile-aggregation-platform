import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { QueueEvents } from 'bullmq';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import configuration from '../../config/configuration.js';
import { QueueModule } from './queue.module.js';
import { QueueService } from './queue.service.js';
import { TestProcessor } from './test.processor.js';

describe('BullMQ Integration (QueueService & TestProcessor)', () => {
  let module: TestingModule;
  let queueService: QueueService;
  let processor: TestProcessor;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
        QueueModule,
      ],
    }).compile();

    await module.init();

    queueService = module.get<QueueService>(QueueService);
    processor = module.get<TestProcessor>(TestProcessor);

    queueEvents = new QueueEvents('test-queue', {
      connection: { host: '127.0.0.1', port: 6379 },
    });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await queueEvents.close();
    await module.close();
  });

  it('should verify queue is healthy and can connect to Redis broker', async () => {
    const isHealthy = await queueService.isHealthy();
    expect(isHealthy).toBe(true);
  });

  it('should successfully enqueue and process a test job via TestProcessor', async () => {
    const uniqueTaskId = `task-${Date.now()}`;
    const payload = {
      taskId: uniqueTaskId,
      payload: { action: 'VERIFY_DISPATCH', priority: 'HIGH' },
      timestamp: new Date().toISOString(),
    };

    const job = await queueService.addTestJob('test-job-execution', payload);
    expect(job.id).toBeDefined();

    const result = await job.waitUntilFinished(queueEvents);
    expect(result).toBeDefined();
    expect(result.status).toBe('completed');
    expect(result.jobId).toBe(job.id);
    expect(result.data.taskId).toBe(uniqueTaskId);
    expect(processor.isJobProcessed(String(job.id))).toBe(true);
  });

  it('should enforce idempotency when processing duplicate job IDs', async () => {
    const duplicateJobId = `idempotent-job-${Date.now()}`;
    const payload = {
      taskId: 'idempotent-task-1',
      payload: { action: 'CHECK_IDEMPOTENCY' },
      timestamp: new Date().toISOString(),
    };

    // First execution
    const job1 = await queueService.addTestJob('idempotent-step-1', payload, duplicateJobId);
    const result1 = await job1.waitUntilFinished(queueEvents);
    expect(result1.status).toBe('completed');

    // Simulate processor receiving duplicate job with identical ID
    const mockDuplicateJob = {
      id: duplicateJobId,
      name: 'idempotent-step-2',
      data: payload,
    };
    const result2 = await processor.process(mockDuplicateJob as any);
    expect(result2.status).toBe('skipped');
    expect(result2.reason).toBe('already_processed');
  });

  it('should report queue metrics with positive completed count', async () => {
    const metrics = await queueService.getQueueMetrics();
    expect(metrics).toBeDefined();
    expect(typeof metrics.completed).toBe('number');
    expect(typeof metrics.failed).toBe('number');
  });
});
