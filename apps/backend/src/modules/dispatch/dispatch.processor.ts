import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../common/constants/index.js';
import { DispatchService } from './dispatch.service.js';
import {
  DispatchTimeoutJobPayload,
  DISPATCH_TIMEOUT_JOB_NAME,
} from './dispatch.interfaces.js';

@Injectable()
@Processor(QUEUES.DISPATCH)
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(private readonly dispatchService: DispatchService) {
    super();
  }

  async process(job: Job<DispatchTimeoutJobPayload>): Promise<any> {
    if (job.name === DISPATCH_TIMEOUT_JOB_NAME) {
      this.logger.log(
        `Processing timeout job ID=${job.id} for offer ${job.data?.offerId} (attempt=${job.data?.dispatchAttemptId})`,
      );
      return this.dispatchService.handleOfferTimeout(job.data);
    }

    this.logger.warn(`Unrecognized job name on dispatch-queue: ${job.name}`);
    return null;
  }
}
