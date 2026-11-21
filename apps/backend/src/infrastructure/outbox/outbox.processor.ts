import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../../common/constants/index.js';
import { OutboxService } from './outbox.service.js';

export const OUTBOX_JOB_POLL = 'poll-outbox-events';
export const OUTBOX_POLL_INTERVAL_MS = 2000; // 2 seconds

@Injectable()
@Processor(QUEUES.OUTBOX)
export class OutboxProcessor
  extends WorkerHost
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(
    private readonly outboxService: OutboxService,
    @Optional()
    @InjectQueue(QUEUES.OUTBOX)
    private readonly outboxQueue?: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.outboxQueue) {
      this.logger.debug(
        'Outbox queue not injected; skipping periodic scheduler configuration',
      );
      return;
    }

    try {
      await this.outboxQueue.upsertJobScheduler(
        'periodic-outbox-scheduler',
        { every: OUTBOX_POLL_INTERVAL_MS },
        {
          name: OUTBOX_JOB_POLL,
          opts: {
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        },
      );
      this.logger.log(
        `Configured repeatable 2-second outbox processor job on queue [${QUEUES.OUTBOX}]`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to schedule repeatable outbox job: ${err?.message}`,
      );
    }
  }

  async process(job: Job): Promise<any> {
    if (job.name === OUTBOX_JOB_POLL) {
      return this.outboxService.processPendingEvents();
    }

    this.logger.warn(`Unrecognized job name on outbox-queue: ${job.name}`);
    return null;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Application shutdown triggered (${signal}). Closing outbox worker on [${QUEUES.OUTBOX}]...`,
    );
    try {
      await this.worker?.close();
    } catch (err) {
      this.logger.warn('Error while closing outbox worker:', err);
    }
  }
}
