import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Job } from 'bullmq';

export interface TestJobPayload {
  taskId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface TestJobResult {
  status: 'completed' | 'skipped';
  jobId: string;
  reason?: string;
  data: TestJobPayload;
  processedAt: string;
}

@Injectable()
@Processor('test-queue')
export class TestProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger(TestProcessor.name);
  private readonly processedJobIds = new Set<string>();

  async process(job: Job<TestJobPayload, TestJobResult, string>): Promise<TestJobResult> {
    const jobId = String(job.id);
    this.logger.log(`Processing job ID=${jobId}, name=${job.name}`);

    // Idempotency check: prevent duplicate execution for identical job id
    if (this.processedJobIds.has(jobId)) {
      this.logger.warn(`Job ID=${jobId} was already processed. Skipping duplicate execution.`);
      return {
        status: 'skipped',
        jobId,
        reason: 'already_processed',
        data: job.data,
        processedAt: new Date().toISOString(),
      };
    }

    this.processedJobIds.add(jobId);

    return {
      status: 'completed',
      jobId,
      data: job.data,
      processedAt: new Date().toISOString(),
    };
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Worker shutting down gracefully on signal: ${signal ?? 'SHUTDOWN'}`);
    try {
      // Safe check if worker was initialized
      const workerInstance = this.worker;
      if (workerInstance) {
        await workerInstance.close();
      }
    } catch {
      // Worker was not initialized; ignore shutdown error
    }
  }

  isJobProcessed(jobId: string): boolean {
    return this.processedJobIds.has(jobId);
  }
}
