import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { TokenService } from './token.service.js';

export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface RotatedSession {
  newSessionId: string;
  newRefreshToken: string;
  userId: string;
  tokenFamilyId: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly maxSessionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
  ) {
    this.maxSessionDays = this.configService.get<number>('jwt.refreshTokenMaxDays', 30);
  }

  async createSession(userId: string, deviceFingerprint?: string): Promise<CreatedSession> {
    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.maxSessionDays);

    const session = await this.prisma.userSession.create({
      data: {
        userId,
        tokenFamilyId: crypto.randomUUID(),
        refreshTokenHash: tokenHash,
        deviceFingerprint: deviceFingerprint || null,
        expiresAt,
      },
    });

    return {
      sessionId: session.id,
      refreshToken: rawRefreshToken,
      expiresAt: session.expiresAt,
    };
  }

  async rotateSession(rawRefreshToken: string, deviceFingerprint?: string): Promise<RotatedSession> {
    if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
      throw new UnauthorizedException('Missing or invalid refresh token');
    }

    const tokenHash = this.tokenService.hashToken(rawRefreshToken);

    // Look up session by hashed token
    const session = await this.prisma.userSession.findUnique({
      where: { refreshTokenHash: tokenHash },
    });

    if (!session) {
      this.logger.warn('Refresh token not found in user_sessions');
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Reuse detection: If token was already revoked, a replay attack or theft occurred!
    if (session.revokedAt !== null) {
      this.logger.error(
        `Token reuse detected for family ${session.tokenFamilyId} (user: ${session.userId}). Revoking entire family.`,
      );
      await this.prisma.userSession.updateMany({
        where: {
          tokenFamilyId: session.tokenFamilyId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      throw new UnauthorizedException('Refresh token reuse detected. All sessions terminated.');
    }

    // Check expiration against absolute 30-day lifecycle
    if (session.expiresAt <= new Date()) {
      await this.prisma.userSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session has expired');
    }

    // Atomic rotation within transaction using pessimistic locking / conditional CAS
    return await this.prisma.$transaction(async (tx) => {
      // Burn the current token atomically
      const burned = await tx.userSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      if (burned.count === 0) {
        throw new UnauthorizedException('Concurrent refresh collision detected');
      }

      // Generate replacement refresh token
      const newRawRefreshToken = this.tokenService.generateRefreshToken();
      const newTokenHash = this.tokenService.hashToken(newRawRefreshToken);

      // Create new session in the exact same token family, preserving the initial absolute expiry
      const newSession = await tx.userSession.create({
        data: {
          userId: session.userId,
          tokenFamilyId: session.tokenFamilyId,
          refreshTokenHash: newTokenHash,
          deviceFingerprint: deviceFingerprint ?? session.deviceFingerprint,
          expiresAt: session.expiresAt,
        },
      });

      return {
        newSessionId: newSession.id,
        newRefreshToken: newRawRefreshToken,
        userId: session.userId,
        tokenFamilyId: session.tokenFamilyId,
        expiresAt: session.expiresAt,
      };
    });
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const result = await this.prisma.userSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    return result.count > 0;
  }

  async revokeAllUserSessions(userId: string): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    return result.count;
  }

  async validateSession(sessionId: string): Promise<boolean> {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      return false;
    }
    return session.revokedAt === null && session.expiresAt > new Date();
  }
}
