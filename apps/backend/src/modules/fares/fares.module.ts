import { Module } from '@nestjs/common';
import { FaresService } from './fares.service.js';
import { FaresController } from './fares.controller.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { RoutingModule } from '../routing/routing.module.js';

@Module({
  imports: [PrismaModule, LocationsModule, RoutingModule],
  controllers: [FaresController],
  providers: [FaresService],
  exports: [FaresService],
})
export class FaresModule {}
