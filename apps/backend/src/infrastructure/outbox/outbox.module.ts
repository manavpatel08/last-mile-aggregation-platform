import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DispatchModule } from '../../modules/dispatch/dispatch.module.js';
import { QUEUES } from '../../common/constants/index.js';
import { OutboxService } from './outbox.service.js';
import { OutboxProcessor } from './outbox.processor.js';

@Module({
  imports: [
    PrismaModule,
    DispatchModule,
    BullModule.registerQueue({
      name: QUEUES.OUTBOX,
    }),
  ],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService, OutboxProcessor],
})
export class OutboxModule {}
