import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
import { DriversModule } from '../drivers/drivers.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { DispatchService } from './dispatch.service.js';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    DriversModule,
    RoutingModule,
  ],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
