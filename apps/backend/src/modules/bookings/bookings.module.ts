import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service.js';
import { BookingsController } from './bookings.controller.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { RoutingModule } from '../routing/routing.module.js';

@Module({
  imports: [PrismaModule, LocationsModule, RoutingModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
