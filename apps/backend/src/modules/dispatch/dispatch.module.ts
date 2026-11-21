import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { QueueModule } from '../../infrastructure/queues/queue.module.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { OutboxModule } from '../../infrastructure/outbox/outbox.module.js';
import { QUEUES } from '../../common/constants/index.js';
import { DispatchService } from './dispatch.service.js';
import { DispatchProcessor } from './dispatch.processor.js';
import { DriverOffersController } from './driver-offers.controller.js';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    QueueModule,
    BullModule.registerQueue({
      name: QUEUES.DISPATCH,
    }),
    DriversModule,
    RoutingModule,
    forwardRef(() => OutboxModule),
  ],
  controllers: [DriverOffersController],
  providers: [DispatchService, DispatchProcessor],
  exports: [DispatchService, DispatchProcessor],
})
export class DispatchModule {}
