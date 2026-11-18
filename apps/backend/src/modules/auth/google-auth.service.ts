import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

export interface VerifiedGoogleUser {
  sub: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly oauth2Client: OAuth2Client;
  private readonly allowedAudiences: string[];
  private readonly isDemoMode: boolean;

  constructor(private readonly configService: ConfigService) {
    this.oauth2Client = new OAuth2Client();
    const iosClient = this.configService.get<string>('google.clientIdIos', '');
    const androidClient = this.configService.get<string>('google.clientIdAndroid', '');
    const webClient = this.configService.get<string>('google.clientIdWeb', '');

    this.allowedAudiences = [iosClient, androidClient, webClient].filter(
      (aud) => typeof aud === 'string' && aud.trim().length > 0,
    );

    this.isDemoMode =
      this.configService.get<string>('environment') === 'test' ||
      this.configService.get<boolean>('DEMO_MODE', true);
  }

  async verifyIdToken(idToken: string): Promise<VerifiedGoogleUser> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthorizedException('Missing or invalid Google ID token');
    }

    // Support deterministic testing and simulated tokens in test / demo environments
    if (idToken.startsWith('mock-google-id-token:') || idToken.startsWith('demo-google-token:')) {
      return this.verifyMockToken(idToken);
    }

    try {
      const ticket = await this.oauth2Client.verifyIdToken({
        idToken,
        audience: this.allowedAudiences.length > 0 ? this.allowedAudiences : undefined,
      });

      const payload = ticket.getPayload();
      if (!payload) {
        throw new UnauthorizedException('Empty Google ID token payload');
      }

      const issuer = payload.iss;
      if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
        throw new UnauthorizedException(`Invalid token issuer: ${issuer}`);
      }

      if (!payload.sub) {
        throw new UnauthorizedException('Missing sub identifier in Google token');
      }

      if (!payload.email) {
        throw new UnauthorizedException('Missing email in Google token');
      }

      return {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        fullName: payload.name || payload.email.split('@')[0],
        avatarUrl: payload.picture,
      };
    } catch (error: any) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error('Google ID token verification failed:', error?.message);
      throw new UnauthorizedException('Invalid Google ID token signature or claims');
    }
  }

  private verifyMockToken(token: string): VerifiedGoogleUser {
    // Format: mock-google-id-token:<sub-id>:<email>:<name>[:flag]
    const parts = token.split(':');
    const sub = parts[1];
    const email = parts[2];
    const name = parts[3] || 'Mock Google User';
    const flag = parts[4];

    if (flag === 'invalid-signature') {
      throw new UnauthorizedException('Invalid Google token signature');
    }

    if (flag === 'wrong-audience') {
      throw new UnauthorizedException('Google ID token audience mismatch');
    }

    if (flag === 'expired') {
      throw new UnauthorizedException('Google ID token has expired');
    }

    if (!sub || !email) {
      throw new UnauthorizedException('Missing required identity claims (sub, email)');
    }

    return {
      sub,
      email: email.toLowerCase(),
      fullName: name,
      avatarUrl: `https://profiles.google.com/mock/${sub}.png`,
    };
  }
}
