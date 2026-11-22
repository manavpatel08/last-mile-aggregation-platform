import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

describe('AuthService — Admin Account Linking Security (Stage 11 Task 2)', () => {
  let authService: AuthService;
  let prismaMock: any;
  let googleAuthServiceMock: any;
  let tokenServiceMock: any;
  let sessionServiceMock: any;
  let redisServiceMock: any;

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(async (callback) => {
        return callback(prismaMock);
      }),
      authIdentity: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };

    googleAuthServiceMock = {
      verifyIdToken: vi.fn(),
    };

    tokenServiceMock = {
      signAccessToken: vi.fn().mockReturnValue('mock-jwt-token'),
      generateRefreshToken: vi.fn().mockReturnValue('mock-refresh-token'),
    };

    sessionServiceMock = {
      createSession: vi.fn().mockResolvedValue({
        rawRefreshToken: 'mock-refresh-token',
        expiresInDays: 30,
      }),
    };

    redisServiceMock = {};

    authService = new AuthService(
      prismaMock,
      redisServiceMock,
      googleAuthServiceMock,
      tokenServiceMock,
      sessionServiceMock,
    );
  });

  it('4. ADMIN identity cannot be claimed through automatic account linking', async () => {
    // Attacker authenticates with a Google account matching admin email but with their own sub
    googleAuthServiceMock.verifyIdToken.mockResolvedValue({
      sub: 'attacker-google-sub-999',
      email: 'admin@pdeu.ac.in',
      fullName: 'Attacker Impersonator',
    });

    // 1. Identity not found for attacker's sub
    prismaMock.authIdentity.findUnique.mockResolvedValue(null);

    // 2. Existing user found by email with ADMIN role
    prismaMock.user.findUnique.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@pdeu.ac.in',
      fullName: 'Platform Administrator',
      role: 'ADMIN',
      roles: [{ roleName: 'ADMIN' }],
      isActive: true,
      driverProfile: null,
      passengerProfile: null,
    });

    // Attempting to authenticate must be blocked with ForbiddenException
    await expect(
      authService.authenticateWithGoogle('some-google-token'),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      authService.authenticateWithGoogle('some-google-token'),
    ).rejects.toThrow('Automatic identity linking to administrator accounts is forbidden');

    // Verify identity was NOT created
    expect(prismaMock.authIdentity.create).not.toHaveBeenCalled();
  });

  it('Preserves legitimate account linking for ordinary PASSENGER accounts', async () => {
    // Legitimate commuter logs in with alternate Google sub for their existing email
    googleAuthServiceMock.verifyIdToken.mockResolvedValue({
      sub: 'new-google-sub-777',
      email: 'student@pdeu.ac.in',
      fullName: 'Student User',
    });

    prismaMock.authIdentity.findUnique.mockResolvedValue(null);

    prismaMock.user.findUnique.mockResolvedValue({
      id: 'passenger-uuid-123',
      email: 'student@pdeu.ac.in',
      fullName: 'Student User',
      role: 'PASSENGER',
      roles: [{ roleName: 'PASSENGER' }],
      isActive: true,
      driverProfile: null,
      passengerProfile: { defaultMinGroupPreference: 2 },
    });

    const res = await authService.authenticateWithGoogle('valid-google-token');

    expect(prismaMock.authIdentity.create).toHaveBeenCalledWith({
      data: {
        userId: 'passenger-uuid-123',
        provider: 'GOOGLE',
        providerSub: 'new-google-sub-777',
      },
    });

    expect(res.user.email).toBe('student@pdeu.ac.in');
    expect(res.user.role).toBe('PASSENGER');
  });
});
