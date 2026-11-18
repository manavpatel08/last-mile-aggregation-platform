import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller.js';
import { AdminDriversController } from './admin-drivers.controller.js';
import { DriversService } from './drivers.service.js';

@Module({
  controllers: [DriversController, AdminDriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
