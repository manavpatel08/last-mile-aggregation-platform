import { describe, expect, it } from 'vitest';
import { Environment, validate } from './env.validation.js';

describe('Environment Validation', () => {
  it('should validate and set defaults for an empty configuration', () => {
    const config = validate({});
    expect(config.NODE_ENV).toBe(Environment.Development);
    expect(config.PORT).toBe(3000);
    expect(config.REDIS_HOST).toBe('127.0.0.1');
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.BASE_FARE_PAISE).toBe(2000);
    expect(config.PER_KM_RATE_PAISE).toBe(1000);
    expect(config.DEMO_MODE).toBe(true);
  });

  it('should accept valid custom configuration', () => {
    const custom = {
      NODE_ENV: 'production',
      PORT: '8080',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6380',
      BASE_FARE_PAISE: '2500',
      PER_KM_RATE_PAISE: '1200',
      DEMO_MODE: 'false',
    };
    const config = validate(custom);
    expect(config.NODE_ENV).toBe(Environment.Production);
    expect(config.PORT).toBe(8080);
    expect(config.REDIS_PORT).toBe(6380);
    expect(config.BASE_FARE_PAISE).toBe(2500);
    expect(config.PER_KM_RATE_PAISE).toBe(1200);
    expect(config.DEMO_MODE).toBe(false);
  });

  it('should throw an error for invalid port number', () => {
    expect(() =>
      validate({
        PORT: '999999',
      }),
    ).toThrow(/PORT/);
  });

  it('should throw an error for invalid NODE_ENV', () => {
    expect(() =>
      validate({
        NODE_ENV: 'staging',
      }),
    ).toThrow(/NODE_ENV/);
  });
});
