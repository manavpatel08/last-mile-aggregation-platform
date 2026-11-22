import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DispatchModule } from '../../modules/dispatch/dispatch.module.js';
import { RealtimeModule } from '../../modules/realtime/realtime.module.js';
import { QUEUES } from '../../common/constants/index.js';
import { OutboxService } from './outbox.service.js';
import { OutboxProcessor } from './outbox.processor.js';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => DispatchModule),
    forwardRef(() => RealtimeModule),
    BullModule.registerQueue({
      name: QUEUES.OUTBOX,
    }),
  ],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService, OutboxProcessor],
})
export class OutboxModule {}
