import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { TokenService } from './token.service.js';
import { SessionService } from './session.service.js';

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    roles: string[];
    driverVerificationStatus: string | null;
  };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SocketTicketResponse {
  ticket: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async authenticateWithGoogle(idToken: string, deviceFingerprint?: string): Promise<AuthResponse> {
    const verifiedGoogle = await this.googleAuthService.verifyIdToken(idToken);

    // Atomically find or create the user and their OAuth identity
    const user = await this.prisma.$transaction(async (tx) => {
      // 1. Check if auth_identity exists for this Google sub
      const existingIdentity = await tx.authIdentity.findUnique({
        where: { providerSub: verifiedGoogle.sub },
        include: {
          user: {
            include: {
              roles: true,
              driverProfile: true,
              passengerProfile: true,
            },
          },
        },
      });

      if (existingIdentity) {
        const existingUser = existingIdentity.user;
        if (!existingUser.isActive) {
          throw new ForbiddenException('User account has been disabled');
        }

        // Optional update of name/avatar if changed in Google
        if (
          existingUser.fullName !== verifiedGoogle.fullName ||
          (verifiedGoogle.avatarUrl && existingUser.avatarUrl !== verifiedGoogle.avatarUrl)
        ) {
          return tx.user.update({
            where: { id: existingUser.id },
            data: {
              fullName: verifiedGoogle.fullName,
              avatarUrl: verifiedGoogle.avatarUrl ?? existingUser.avatarUrl,
            },
            include: {
              roles: true,
              driverProfile: true,
              passengerProfile: true,
            },
          });
        }

        return existingUser;
      }

      // 2. Check if a user with this email already exists (e.g. invited or manual record)
      const existingUserByEmail = await tx.user.findUnique({
        where: { email: verifiedGoogle.email },
        include: {
          roles: true,
          driverProfile: true,
          passengerProfile: true,
        },
      });

      if (existingUserByEmail) {
        if (!existingUserByEmail.isActive) {
          throw new ForbiddenException('User account has been disabled');
        }

        // Security Directive: Automatic identity linking to administrator accounts is strictly forbidden
        const hasAdminRole =
          existingUserByEmail.role === 'ADMIN' ||
          existingUserByEmail.roles.some((r) => r.roleName === 'ADMIN');

        if (hasAdminRole) {
          throw new ForbiddenException(
            'Automatic identity linking to administrator accounts is forbidden',
          );
        }

        // Link identity to existing user
        await tx.authIdentity.create({
          data: {
            userId: existingUserByEmail.id,
            provider: 'GOOGLE',
            providerSub: verifiedGoogle.sub,
          },
        });

        return existingUserByEmail;
      }

      // 3. New User Registration: create user, passenger profile, and default role
      const newUser = await tx.user.create({
        data: {
          email: verifiedGoogle.email,
          fullName: verifiedGoogle.fullName,
          avatarUrl: verifiedGoogle.avatarUrl ?? null,
          role: 'PASSENGER',
          isActive: true,
          roles: {
            create: {
              roleName: 'PASSENGER',
            },
          },
          passengerProfile: {
            create: {
              defaultMinGroupPreference: 2,
            },
          },
          authIdentities: {
            create: {
              provider: 'GOOGLE',
              providerSub: verifiedGoogle.sub,
            },
          },
        },
        include: {
          roles: true,
          driverProfile: true,
          passengerProfile: true,
        },
      });

      return newUser;
    });

    // Create a new persistent session with family tracking
    const session = await this.sessionService.createSession(user.id, deviceFingerprint);

    const rolesList = user.roles.map((r) => r.roleName);
    const driverStatus = user.driverProfile?.verificationStatus ?? null;

    // Sign 15-minute platform JWT
    const { accessToken, expiresIn } = await this.tokenService.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      roles: rolesList,
      driverVerificationStatus: driverStatus,
      sessionId: session.sessionId,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        roles: rolesList,
        driverVerificationStatus: driverStatus,
      },
      accessToken,
      refreshToken: session.refreshToken,
      expiresIn,
    };
  }

  async refreshSession(rawRefreshToken: string, deviceFingerprint?: string): Promise<RefreshResponse> {
    const rotated = await this.sessionService.rotateSession(rawRefreshToken, deviceFingerprint);

    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      include: {
        roles: true,
        driverProfile: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Associated user not found');
    }

    if (!user.isActive) {
      throw new ForbiddenException('User account has been disabled');
    }

    const rolesList = user.roles.map((r) => r.roleName);
    const driverStatus = user.driverProfile?.verificationStatus ?? null;

    const { accessToken, expiresIn } = await this.tokenService.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      roles: rolesList,
      driverVerificationStatus: driverStatus,
      sessionId: rotated.newSessionId,
    });

    return {
      accessToken,
      refreshToken: rotated.newRefreshToken,
      expiresIn,
    };
  }

  async logout(sessionId: string): Promise<{ success: boolean; message: string }> {
    if (!sessionId) {
      throw new UnauthorizedException('Missing session identifier');
    }
    await this.sessionService.revokeSession(sessionId);
    return { success: true, message: 'Logged out successfully' };
  }

  async logoutAll(userId: string): Promise<{ success: boolean; message: string }> {
    if (!userId) {
      throw new UnauthorizedException('Missing user identifier');
    }
    await this.sessionService.revokeAllUserSessions(userId);
    return { success: true, message: 'All sessions terminated successfully' };
  }

  async generateSocketTicket(
    userId: string,
    role: string,
    driverVerificationStatus: string | null,
    sessionId: string,
  ): Promise<SocketTicketResponse> {
    const ticket = crypto.randomUUID();
    const redisClient = this.redisService.getClient();

    const ticketContext = JSON.stringify({
      userId,
      role,
      driverVerificationStatus,
      sessionId,
      createdAt: new Date().toISOString(),
    });

    // 60-second single-use TTL
    await redisClient.set(`socket_ticket:${ticket}`, ticketContext, 'EX', 60);

    return {
      ticket,
      expiresIn: 60,
    };
  }
}
