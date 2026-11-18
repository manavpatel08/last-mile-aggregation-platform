import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'node:crypto';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  roles: string[];
  driverVerificationStatus: string | null;
  sessionId: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class TokenService {
  private readonly accessExpirySeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.accessExpirySeconds = this.configService.get<number>('jwt.accessExpiry', 900);
  }

  async signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: this.accessExpirySeconds,
    });
    return {
      accessToken,
      expiresIn: this.accessExpirySeconds,
    };
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    try {
      const decoded = await this.jwtService.verifyAsync<JwtPayload>(token);
      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  generateRefreshToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
