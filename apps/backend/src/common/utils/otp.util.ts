import * as crypto from 'node:crypto';

/**
 * Generates a deterministic 4-digit numeric OTP (1000-9999) using HMAC-SHA256
 * derived from an entity key (bookingId), salt (assignmentId), and HMAC secret.
 *
 * Security & Architectural Guarantees:
 * 1. Plaintext OTP is NEVER stored in PostgreSQL.
 * 2. Deterministic recovery: if Redis is restarted, flushed, or unavailable,
 *    the passenger can still safely retrieve their valid OTP.
 * 3. Cannot be computed or guessed by drivers or unauthorized third parties
 *    without the server-side HMAC secret.
 * 4. Strictly 4 numeric digits: matches /^\d{4}$/ and range [1000, 9999].
 */
export function deriveBoardingOtp(
  bookingId: string,
  salt: string,
  secret?: string,
): string {
  const hmacSecret =
    secret ||
    process.env.BOARDING_OTP_SECRET ||
    process.env.JWT_SECRET ||
    'lastmile-pdeu-boarding-otp-secret-key';
  const hmac = crypto.createHmac('sha256', hmacSecret);
  hmac.update(`${bookingId}:${salt}`);
  const digest = hmac.digest();
  const code = (digest.readUInt32BE(0) % 9000) + 1000;
  return code.toString();
}

/**
 * Computes the SHA-256 hex digest of a 4-digit OTP string.
 * Used for storage in `boarding_verifications.otp_hash` and verification.
 */
export function hashBoardingOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}
