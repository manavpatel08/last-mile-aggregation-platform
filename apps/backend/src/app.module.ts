import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import configuration from './config/configuration.js';
import { validate } from './config/env.validation.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { QueueModule } from './infrastructure/queues/queue.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { RoutingModule } from './modules/routing/routing.module.js';
import { FaresModule } from './modules/fares/fares.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { TripsModule } from './modules/trips/trips.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { MatchingModule } from './modules/matching/matching.module.js';
import { DispatchModule } from './modules/dispatch/dispatch.module.js';
import { OutboxModule } from './infrastructure/outbox/outbox.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { SimulationModule } from './modules/simulation/simulation.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { DriverApprovalGuard } from './common/guards/driver-approval.guard.js';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor.js';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    PrismaModule,
    RedisModule,
    QueueModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DriversModule,
    LocationsModule,
    RoutingModule,
    FaresModule,
    BookingsModule,
    TripsModule,
    PaymentsModule,
    MatchingModule,
    DispatchModule,
    OutboxModule,
    RealtimeModule,
    SyncModule,
    SimulationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: DriverApprovalGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
