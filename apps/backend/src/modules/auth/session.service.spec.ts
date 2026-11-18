import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import { SessionService } from './session.service.js';

describe('SessionService (Persistent Session Management & Rotation)', () => {
  let module: TestingModule;
  let sessionService: SessionService;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let testUserId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        PrismaModule,
        JwtModule.register({
          secret: 'test-secret-at-least-32-chars-long-placeholder!!',
          signOptions: { expiresIn: 900 },
        }),
      ],
      providers: [
        ConfigService,
        TokenService,
        SessionService,
      ],
    }).compile();

    await module.init();

    sessionService = module.get<SessionService>(SessionService);
    prisma = module.get<PrismaService>(PrismaService);
    tokenService = module.get<TokenService>(TokenService);

    // Create isolated test user
    const user = await prisma.user.create({
      data: {
        email: `session-test-${Date.now()}@pdeu.ac.in`,
        fullName: 'Session Test User',
        role: 'PASSENGER',
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    // Isolated cleanup
    await prisma.userSession.deleteMany({ where: { userId: testUserId } });
    await prisma.user.delete({ where: { id: testUserId } });
    await module.close();
  });

  it('should create a persistent session with hashed refresh token and 30-day expiry', async () => {
    const session = await sessionService.createSession(testUserId, 'device-fingerprint-ios-1');

    expect(session.sessionId).toBeDefined();
    expect(session.refreshToken).toBeDefined();
    expect(session.refreshToken.length).toBe(64); // 32 bytes hex = 64 chars

    // Verify database record has SHA-256 hash, not plain text!
    const dbSession = await prisma.userSession.findUnique({
      where: { id: session.sessionId },
    });
    expect(dbSession).not.toBeNull();
    expect(dbSession?.refreshTokenHash).toBe(tokenService.hashToken(session.refreshToken));
    expect(dbSession?.refreshTokenHash).not.toBe(session.refreshToken);
    expect(dbSession?.revokedAt).toBeNull();
    expect(dbSession?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 28 * 24 * 3600 * 1000);
  });

  it('should successfully rotate refresh token and preserve token family', async () => {
    const original = await sessionService.createSession(testUserId, 'device-rotate-1');
    const originalHash = tokenService.hashToken(original.refreshToken);

    // Rotate token
    const rotated = await sessionService.rotateSession(original.refreshToken, 'device-rotate-2');

    expect(rotated.newSessionId).not.toBe(original.sessionId);
    expect(rotated.newRefreshToken).not.toBe(original.refreshToken);
    expect(rotated.userId).toBe(testUserId);

    // Check old session is burned (revoked)
    const oldDbSession = await prisma.userSession.findUnique({
      where: { refreshTokenHash: originalHash },
    });
    expect(oldDbSession?.revokedAt).not.toBeNull();

    // Check new session belongs to the SAME token family
    const newDbSession = await prisma.userSession.findUnique({
      where: { id: rotated.newSessionId },
    });
    expect(newDbSession?.tokenFamilyId).toBe(oldDbSession?.tokenFamilyId);
    expect(newDbSession?.revokedAt).toBeNull();
  });

  it('should detect refresh token reuse and immediately revoke the entire token family', async () => {
    const original = await sessionService.createSession(testUserId, 'device-reuse-test');

    // First rotation succeeds
    const rotated = await sessionService.rotateSession(original.refreshToken);

    // Replay attack: Attacker attempts to rotate using the already-burned original token
    await expect(sessionService.rotateSession(original.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );

    // Verify ENTIRE token family is now revoked
    const familySessions = await prisma.userSession.findMany({
      where: { tokenFamilyId: rotated.tokenFamilyId },
    });

    expect(familySessions.length).toBeGreaterThanOrEqual(2);
    for (const s of familySessions) {
      expect(s.revokedAt).not.toBeNull();
    }

    // Validating rotated session now fails because family was revoked
    const isValid = await sessionService.validateSession(rotated.newSessionId);
    expect(isValid).toBe(false);
  });

  it('should revoke a single session on logout', async () => {
    const session = await sessionService.createSession(testUserId, 'device-logout-test');

    expect(await sessionService.validateSession(session.sessionId)).toBe(true);

    const revoked = await sessionService.revokeSession(session.sessionId);
    expect(revoked).toBe(true);

    expect(await sessionService.validateSession(session.sessionId)).toBe(false);
  });

  it('should revoke all user sessions on logout-all', async () => {
    const session1 = await sessionService.createSession(testUserId, 'device-1');
    const session2 = await sessionService.createSession(testUserId, 'device-2');

    expect(await sessionService.validateSession(session1.sessionId)).toBe(true);
    expect(await sessionService.validateSession(session2.sessionId)).toBe(true);

    const count = await sessionService.revokeAllUserSessions(testUserId);
    expect(count).toBeGreaterThanOrEqual(2);

    expect(await sessionService.validateSession(session1.sessionId)).toBe(false);
    expect(await sessionService.validateSession(session2.sessionId)).toBe(false);
  });

  it('should reject refresh on expired session', async () => {
    const rawToken = tokenService.generateRefreshToken();
    const hash = tokenService.hashToken(rawToken);

    // Create session already expired in past
    const expiredDate = new Date(Date.now() - 1000 * 60);
    const expiredSession = await prisma.userSession.create({
      data: {
        userId: testUserId,
        tokenFamilyId: crypto.randomUUID(),
        refreshTokenHash: hash,
        expiresAt: expiredDate,
      },
    });

    await expect(sessionService.rotateSession(rawToken)).rejects.toThrow(
      UnauthorizedException,
    );

    const updated = await prisma.userSession.findUnique({
      where: { id: expiredSession.id },
    });
    expect(updated?.revokedAt).not.toBeNull();
  });

  it('should handle concurrent refresh attempts safely with only one winner', async () => {
    const session = await sessionService.createSession(testUserId, 'concurrent-test');

    // Attempt two simultaneous rotations with the identical refresh token
    const results = await Promise.allSettled([
      sessionService.rotateSession(session.refreshToken),
      sessionService.rotateSession(session.refreshToken),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed, and the concurrent/replay call must fail
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });
});
