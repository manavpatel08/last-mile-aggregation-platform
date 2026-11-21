import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deriveBoardingOtp, hashBoardingOtp } from './otp.util.js';

describe('otp.util', () => {
  const mockBookingId = '11111111-1111-4111-a111-111111111111';
  const mockAssignmentId = '22222222-2222-4222-a222-222222222222';
  const TEST_SECRET = 'test-only-secret-minimum-32-chars-long!';
  let originalEnvSecret: string | undefined;

  beforeEach(() => {
    originalEnvSecret = process.env.BOARDING_OTP_SECRET;
    process.env.BOARDING_OTP_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalEnvSecret !== undefined) {
      process.env.BOARDING_OTP_SECRET = originalEnvSecret;
    } else {
      delete process.env.BOARDING_OTP_SECRET;
    }
  });

  it('should derive a 4-digit numeric string between 1000 and 9999 using configured environment secret', () => {
    const otp = deriveBoardingOtp(mockBookingId, mockAssignmentId);
    expect(otp).toHaveLength(4);
    expect(/^\d{4}$/.test(otp)).toBe(true);
    const num = parseInt(otp, 10);
    expect(num).toBeGreaterThanOrEqual(1000);
    expect(num).toBeLessThanOrEqual(9999);
  });

  it('should derive a 4-digit numeric string between 1000 and 9999 using explicit test secret', () => {
    const otp = deriveBoardingOtp(mockBookingId, mockAssignmentId, TEST_SECRET);
    expect(otp).toHaveLength(4);
    expect(/^\d{4}$/.test(otp)).toBe(true);
    const num = parseInt(otp, 10);
    expect(num).toBeGreaterThanOrEqual(1000);
    expect(num).toBeLessThanOrEqual(9999);
  });

  it('should fail closed when secret is not configured in environment and not passed explicitly', () => {
    delete process.env.BOARDING_OTP_SECRET;
    expect(() => deriveBoardingOtp(mockBookingId, mockAssignmentId)).toThrow(
      /BOARDING_OTP_SECRET is not configured\. Boarding OTP generation failed closed\./,
    );
  });

  it('should fail closed when configured secret is empty or whitespace only', () => {
    process.env.BOARDING_OTP_SECRET = '   ';
    expect(() => deriveBoardingOtp(mockBookingId, mockAssignmentId)).toThrow(
      /BOARDING_OTP_SECRET is not configured\. Boarding OTP generation failed closed\./,
    );
  });

  it('should fail closed when explicit secret is shorter than 32 characters', () => {
    expect(() =>
      deriveBoardingOtp(mockBookingId, mockAssignmentId, 'short-secret-less-32-chars'),
    ).toThrow(
      /BOARDING_OTP_SECRET must be at least 32 characters long\. Boarding OTP generation failed closed\./,
    );
  });

  it('should fail closed when environment secret is shorter than 32 characters', () => {
    process.env.BOARDING_OTP_SECRET = 'short-secret-less-32-chars';
    expect(() => deriveBoardingOtp(mockBookingId, mockAssignmentId)).toThrow(
      /BOARDING_OTP_SECRET must be at least 32 characters long\. Boarding OTP generation failed closed\./,
    );
  });

  it('should produce deterministic output for the same inputs with identical secret', () => {
    const otp1 = deriveBoardingOtp(mockBookingId, mockAssignmentId, TEST_SECRET);
    const otp2 = deriveBoardingOtp(mockBookingId, mockAssignmentId, TEST_SECRET);
    expect(otp1).toBe(otp2);
  });

  it('should produce distinct output for different booking IDs or salts', () => {
    const otpA = deriveBoardingOtp(mockBookingId, mockAssignmentId, TEST_SECRET);
    const otpB = deriveBoardingOtp(
      '33333333-3333-4333-a333-333333333333',
      mockAssignmentId,
      TEST_SECRET,
    );
    const otpC = deriveBoardingOtp(
      mockBookingId,
      '44444444-4444-4444-a444-444444444444',
      TEST_SECRET,
    );

    // With 9000 possibilities, collision across distinct IDs is rare; verify distinct outputs
    expect(otpA !== otpB || otpA !== otpC).toBe(true);
  });

  it('should produce distinct output for different HMAC secrets', () => {
    const altSecret = 'alternative-test-secret-minimum-32-chars!';
    const otpA = deriveBoardingOtp(mockBookingId, mockAssignmentId, TEST_SECRET);
    const otpB = deriveBoardingOtp(mockBookingId, mockAssignmentId, altSecret);
    expect(otpA).not.toBe(otpB);
  });

  it('should verify deterministic OTP generation and recovery produce identical results across application restarts when configured secret is unchanged', () => {
    // Initial application instance before restart:
    // Dispatch assigns driver and stores only hash in PostgreSQL
    const persistentConfiguredSecret =
      'production-configured-secret-32-chars-long!';
    process.env.BOARDING_OTP_SECRET = persistentConfiguredSecret;

    const initialGeneratedOtp = deriveBoardingOtp(mockBookingId, mockAssignmentId);
    const storedHashInDb = hashBoardingOtp(initialGeneratedOtp);

    // Simulate application restart:
    // Process exits, in-memory state is wiped, Redis ephemeral cache is cold
    delete process.env.BOARDING_OTP_SECRET;

    // Restart boots with unchanged configured secret
    process.env.BOARDING_OTP_SECRET = persistentConfiguredSecret;

    // Passenger requests boarding pass after restart:
    // BookingsService deterministically recovers OTP and verifies cryptographic integrity against stored hash
    const recoveredOtp = deriveBoardingOtp(mockBookingId, mockAssignmentId);
    const recoveredHash = hashBoardingOtp(recoveredOtp);

    expect(recoveredOtp).toBe(initialGeneratedOtp);
    expect(recoveredHash).toBe(storedHashInDb);
  });

  it('should compute SHA-256 hex digest matching crypto standard', () => {
    const otp = '4821';
    const hash = hashBoardingOtp(otp);
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    expect(hashBoardingOtp('4821')).toBe(
      'a388f562e286fdf28986f9253579f4d096446e01dd0c771996a51ff11b390fa2',
    );
  });
});
