import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue, Job } from 'bullmq';
import type { TestJobPayload, TestJobResult } from './test.processor.js';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue('test-queue') private readonly testQueue: Queue<TestJobPayload, TestJobResult>,
  ) {}

  async addTestJob(name: string, data: TestJobPayload, jobId?: string): Promise<Job<TestJobPayload, TestJobResult>> {
    this.logger.log(`Enqueuing test job '${name}' with optional jobId=${jobId}`);
    return this.testQueue.add(name, data, {
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async getTestJob(jobId: string): Promise<Job<TestJobPayload, TestJobResult> | undefined> {
    return this.testQueue.getJob(jobId);
  }

  async getQueueMetrics(): Promise<{ waiting: number; active: number; completed: number; failed: number }> {
    const counts = await this.testQueue.getJobCounts('waiting', 'active', 'completed', 'failed');
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.testQueue.getJobCounts('waiting');
      return true;
    } catch (err) {
      this.logger.error('Queue connection health check failed:', err);
      return false;
    }
  }
}
