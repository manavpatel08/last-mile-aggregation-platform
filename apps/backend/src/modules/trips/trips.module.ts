import { Module } from '@nestjs/common';
import { TripsService } from './trips.service.js';
import { TripsController } from './trips.controller.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { RoutingModule } from '../routing/routing.module.js';

@Module({
  imports: [PrismaModule, RoutingModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
