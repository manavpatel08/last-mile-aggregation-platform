import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { AdminCancellationFeesController } from './admin-cancellation-fees.controller.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController, AdminCancellationFeesController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
