import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { MatchingService } from './matching.service.js';
import { MatchingCycleSummary } from './matching.interfaces.js';

export interface MatchingJobPayload {
  pickupPointName?: string;
  triggeredBy?: string;
}

export const MATCHING_QUEUE_NAME = 'matching-queue';
export const MATCHING_JOB_PERIODIC = 'periodic-matching-pdeu';
export const MATCHING_INTERVAL_MS = 60000; // 60 seconds

@Injectable()
@Processor(MATCHING_QUEUE_NAME)
export class MatchingProcessor
  extends WorkerHost
  implements OnApplicationShutdown, OnModuleInit
{
  private readonly logger = new Logger(MatchingProcessor.name);

  constructor(
    private readonly matchingService: MatchingService,
    @InjectQueue(MATCHING_QUEUE_NAME)
    private readonly matchingQueue: Queue<
      MatchingJobPayload,
      MatchingCycleSummary | null
    >,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      // Schedule or ensure repeatable 60-second periodic matching job
      await this.matchingQueue.upsertJobScheduler(
        'periodic-matching-pdeu-scheduler',
        { every: MATCHING_INTERVAL_MS },
        {
          name: MATCHING_JOB_PERIODIC,
          data: { pickupPointName: 'PDEU Main Gate', triggeredBy: 'scheduler' },
          opts: {
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        },
      );
      this.logger.log(
        `Configured repeatable 60-second matching cycle job on queue [${MATCHING_QUEUE_NAME}]`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to schedule repeatable matching job: ${err?.message}`,
      );
    }
  }

  /**
   * BullMQ processor callback executing the matching batch for the zone.
   * Handles concurrency and crashes: Redis distributed lease ensures only one
   * worker processes the zone at any given moment.
   */
  async process(
    job: Job<MatchingJobPayload, MatchingCycleSummary | null, string>,
  ): Promise<MatchingCycleSummary | null> {
    const pickupPointName = job.data?.pickupPointName || 'PDEU Main Gate';
    this.logger.log(
      `Processing matching job ID=${job.id}, name=${job.name} for [${pickupPointName}]`,
    );

    const summary = await this.matchingService.processMatchingCycle(
      pickupPointName,
    );

    if (summary) {
      this.logger.log(
        `Completed matching cycle batch=${summary.batchId}. Eligible: ${summary.totalEligibleBookings}, Groups formed: ${summary.groupsFormedCount}`,
      );
    } else {
      this.logger.debug(
        `Matching cycle for [${pickupPointName}] skipped or already held by another worker`,
      );
    }

    return summary;
  }

  /**
   * On-demand trigger to execute a matching cycle immediately (e.g. for testing, admin, or high-demand surges).
   */
  async triggerImmediateMatching(
    pickupPointName = 'PDEU Main Gate',
  ): Promise<Job<MatchingJobPayload, MatchingCycleSummary | null>> {
    this.logger.log(`Triggering immediate on-demand matching for [${pickupPointName}]`);
    return this.matchingQueue.add(
      'on-demand-matching',
      { pickupPointName, triggeredBy: 'manual-trigger' },
      {
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Application shutdown triggered (${signal}). Closing worker on [${MATCHING_QUEUE_NAME}]...`,
    );
    try {
      await this.worker?.close();
    } catch (err) {
      this.logger.warn('Error while closing matching worker:', err);
    }
  }
}
