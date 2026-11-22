import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { MatchingModule } from '../matching/matching.module.js';
import { DispatchModule } from '../dispatch/dispatch.module.js';
import { TripsModule } from '../trips/trips.module.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { FaresModule } from '../fares/fares.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { QueueModule } from '../../infrastructure/queues/queue.module.js';
import { QUEUES } from '../../common/constants/index.js';
import { SimulationService } from './simulation.service.js';
import { SimulationController } from './simulation.controller.js';

@Module({
  imports: [
    PrismaModule,
    MatchingModule,
    DispatchModule,
    TripsModule,
    DriversModule,
    BookingsModule,
    FaresModule,
    AuthModule,
    RedisModule,
    RealtimeModule,
    QueueModule,
    BullModule.registerQueue({
      name: QUEUES.DISPATCH,
    }),
  ],
  providers: [SimulationService],
  controllers: [SimulationController],
  exports: [SimulationService],
})
export class SimulationModule {}
