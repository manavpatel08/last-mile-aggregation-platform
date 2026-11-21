import { describe, expect, it } from 'vitest';
import { Environment, validate } from './env.validation.js';

describe('Environment Validation', () => {
  const validOtpSecret =
    'dev-boarding-otp-secret-minimum-32-chars-long-placeholder!';

  it('should throw an error if mandatory BOARDING_OTP_SECRET is missing', () => {
    expect(() => validate({})).toThrow(/BOARDING_OTP_SECRET/);
  });

  it('should throw an error if BOARDING_OTP_SECRET is shorter than 32 characters', () => {
    expect(() =>
      validate({
        BOARDING_OTP_SECRET: 'short-secret-less-than-32-chars',
      }),
    ).toThrow(/BOARDING_OTP_SECRET/);
  });

  it('should validate and set defaults when valid mandatory BOARDING_OTP_SECRET is provided', () => {
    const config = validate({
      BOARDING_OTP_SECRET: validOtpSecret,
    });
    expect(config.NODE_ENV).toBe(Environment.Development);
    expect(config.PORT).toBe(3000);
    expect(config.REDIS_HOST).toBe('127.0.0.1');
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.BASE_FARE_PAISE).toBe(2000);
    expect(config.PER_KM_RATE_PAISE).toBe(1000);
    expect(config.DEMO_MODE).toBe(true);
    expect(config.BOARDING_OTP_SECRET).toBe(validOtpSecret);
  });

  it('should accept valid custom configuration including BOARDING_OTP_SECRET', () => {
    const custom = {
      NODE_ENV: 'production',
      PORT: '8080',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6380',
      BASE_FARE_PAISE: '2500',
      PER_KM_RATE_PAISE: '1200',
      DEMO_MODE: 'false',
      BOARDING_OTP_SECRET: validOtpSecret,
    };
    const config = validate(custom);
    expect(config.NODE_ENV).toBe(Environment.Production);
    expect(config.PORT).toBe(8080);
    expect(config.REDIS_PORT).toBe(6380);
    expect(config.BASE_FARE_PAISE).toBe(2500);
    expect(config.PER_KM_RATE_PAISE).toBe(1200);
    expect(config.DEMO_MODE).toBe(false);
    expect(config.BOARDING_OTP_SECRET).toBe(validOtpSecret);
  });

  it('should throw an error for invalid port number', () => {
    expect(() =>
      validate({
        BOARDING_OTP_SECRET: validOtpSecret,
        PORT: '999999',
      }),
    ).toThrow(/PORT/);
  });

  it('should throw an error for invalid NODE_ENV', () => {
    expect(() =>
      validate({
        BOARDING_OTP_SECRET: validOtpSecret,
        NODE_ENV: 'staging',
      }),
    ).toThrow(/NODE_ENV/);
  });
});
