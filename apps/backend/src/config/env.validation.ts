import 'reflect-metadata';
import { Transform, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(1024)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsOptional()
  DATABASE_URL: string =
    'postgresql://lastmile_app@127.0.0.1:5432/lastmile_db?schema=public';

  @IsString()
  @IsOptional()
  REDIS_HOST: string = '127.0.0.1';

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  REDIS_PORT: number = 6379;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD: string = '';

  @IsString()
  @IsOptional()
  OSRM_BACKEND_URL: string = 'http://127.0.0.1:5000';

  @IsString()
  @IsOptional()
  JWT_ACCESS_SECRET: string =
    'dev-access-secret-minimum-32-chars-long-placeholder!';

  @IsInt()
  @IsOptional()
  JWT_ACCESS_EXPIRY: number = 900;

  @IsInt()
  @IsOptional()
  REFRESH_TOKEN_MAX_DAYS: number = 30;

  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_ID_IOS: string = '';

  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_ID_ANDROID: string = '';

  @IsString()
  @IsOptional()
  GOOGLE_CLIENT_ID_WEB: string = '';

  @IsInt()
  @IsOptional()
  MATCHING_BATCH_INTERVAL_MS: number = 60000;

  @IsInt()
  @IsOptional()
  MAX_SHARED_WAIT_DEADLINE_MS: number = 120000;

  @IsInt()
  @IsOptional()
  DRIVER_OFFER_TIMEOUT_SEC: number = 20;

  @IsNumber()
  @IsOptional()
  MAX_DETOUR_PERCENT: number = 25.0;

  @IsInt()
  @IsOptional()
  BASE_FARE_PAISE: number = 2000;

  @IsInt()
  @IsOptional()
  PER_KM_RATE_PAISE: number = 1000;

  @Transform(({ value }) => {
    if (value === 'true' || value === true || value === '1' || value === 1) return true;
    if (value === 'false' || value === false || value === '0' || value === 0) return false;
    return value;
  })
  @IsBoolean()
  @IsOptional()
  DEMO_MODE: boolean = true;
}

export function validate(config: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...config };

  if (typeof normalized.DEMO_MODE === 'string') {
    normalized.DEMO_MODE =
      normalized.DEMO_MODE.toLowerCase() === 'true' ||
      normalized.DEMO_MODE === '1';
  }

  const validatedConfig = plainToInstance(EnvironmentVariables, normalized, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const errorMessages = errors
      .map(
        (err) =>
          `${err.property}: ${Object.values(err.constraints ?? {}).join(', ')}`,
      )
      .join('; ');
    throw new Error(`Environment validation failed: ${errorMessages}`);
  }

  return validatedConfig;
}
