import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { QueueModule } from '../../infrastructure/queues/queue.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { FaresModule } from '../fares/fares.module.js';
import { OutboxModule } from '../../infrastructure/outbox/outbox.module.js';
import { PermutationSolver } from './permutation-solver.service.js';
import { MatchingService } from './matching.service.js';
import {
  MatchingProcessor,
  MATCHING_QUEUE_NAME,
} from './matching.processor.js';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    QueueModule,
    BullModule.registerQueue({
      name: MATCHING_QUEUE_NAME,
    }),
    RoutingModule,
    FaresModule,
    OutboxModule,
  ],
  providers: [PermutationSolver, MatchingService, MatchingProcessor],
  exports: [PermutationSolver, MatchingService, MatchingProcessor],
})
export class MatchingModule {}
