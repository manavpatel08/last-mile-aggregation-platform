import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/http-exception.filter.js';

async function bootstrap() {
  const logger = new Logger('NestApplication');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', 3000);
  const env = configService.get<string>('environment', 'development');

  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/ready', 'health/live'],
  });

  app.useGlobalFilters(new AllExceptionsFilter());

  // Allow cross-origin requests from frontend clients
  app.enableCors({
    origin: true,
    credentials: true,
  });

  await app.listen(port, '0.0.0.0');
  logger.log(
    `NestJS API Process running in [${env}] mode on http://0.0.0.0:${port} (Prefix: /api/v1, Health: /health)`,
  );
}

await bootstrap();
