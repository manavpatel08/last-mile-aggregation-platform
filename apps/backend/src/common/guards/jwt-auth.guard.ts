import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { TokenService } from '../../modules/auth/token.service.js';
import { SessionService } from '../../modules/auth/session.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException('Missing authorization token');
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Malformed authorization header');
    }

    // 1. Verify token signature and expiration
    const payload = await this.tokenService.verifyAccessToken(token);

    // 2. Validate session has not been revoked or expired
    const isSessionActive = await this.sessionService.validateSession(payload.sessionId);
    if (!isSessionActive) {
      throw new UnauthorizedException('Session has been revoked or expired');
    }

    // 3. Verify user status from authoritative database
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        roles: true,
        driverProfile: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User account no longer exists');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account has been disabled');
    }

    // Attach verified user context to request
    request.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      roles: user.roles.map((r) => r.roleName),
      driverProfile: user.driverProfile,
      driverVerificationStatus: user.driverProfile?.verificationStatus ?? null,
      sessionId: payload.sessionId,
    };

    return true;
  }
}
