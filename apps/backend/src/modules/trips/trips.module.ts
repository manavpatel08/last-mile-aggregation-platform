import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TripsService } from './trips.service.js';
import { TripsController } from './trips.controller.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { QUEUES } from '../../common/constants/index.js';
import { DispatchModule } from '../dispatch/dispatch.module.js';

@Module({
  imports: [
    PrismaModule,
    RoutingModule,
    BullModule.registerQueue({
      name: QUEUES.DISPATCH,
    }),
    forwardRef(() => DispatchModule),
  ],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
