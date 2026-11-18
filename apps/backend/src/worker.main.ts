import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrapWorker() {
  const logger = new Logger('NestWorkerProcess');
  const app = await NestFactory.createApplicationContext(AppModule);

  const configService = app.get(ConfigService);
  const env = configService.get<string>('environment', 'development');

  logger.log(`NestJS Background Worker Process initialized in [${env}] mode`);

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}. Shutting down worker context gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await bootstrapWorker();
