import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../common/constants/index.js';
import { DispatchService } from './dispatch.service.js';
import { DISPATCH_TIMEOUT_JOB_NAME } from './dispatch.interfaces.js';
import { TripsService } from '../trips/trips.service.js';

@Injectable()
@Processor(QUEUES.DISPATCH)
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(
    private readonly dispatchService: DispatchService,
    @Optional()
    @Inject(forwardRef(() => TripsService))
    private readonly tripsService?: TripsService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<any> {
    if (job.name === DISPATCH_TIMEOUT_JOB_NAME) {
      this.logger.log(
        `Processing timeout job ID=${job.id} for offer ${job.data?.offerId} (attempt=${job.data?.dispatchAttemptId})`,
      );
      return this.dispatchService.handleOfferTimeout(job.data);
    }

    if (job.name === 'replacement-offer-timeout') {
      this.logger.log(
        `Processing replacement timeout job ID=${job.id} for trip ${job.data?.tripId} (attempt=${job.data?.attemptId})`,
      );
      if (!this.tripsService) {
        this.logger.error(
          `TripsService not available to process replacement timeout job ID=${job.id}`,
        );
        throw new Error(
          `TripsService unavailable; cannot process replacement timeout job ${job.id}`,
        );
      }
      return this.tripsService.handleReplacementTimeout(job.data);
    }

    this.logger.warn(`Unrecognized job name on dispatch-queue: ${job.name}`);
    return null;
  }
}
