import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { GoogleAuthService } from './google-auth.service.js';

describe('GoogleAuthService', () => {
  let service: GoogleAuthService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService({
      google: {
        clientIdIos: 'ios-client-id-12345.apps.googleusercontent.com',
        clientIdAndroid: 'android-client-id-12345.apps.googleusercontent.com',
        clientIdWeb: 'web-client-id-12345.apps.googleusercontent.com',
      },
      environment: 'test',
      DEMO_MODE: true,
    });

    service = new GoogleAuthService(configService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('verifyIdToken() with Google token validation rules', () => {
    it('should successfully verify a valid identity token and extract claims', async () => {
      const validToken = 'mock-google-id-token:sub-1001:aarav.patel@pdeu.ac.in:Aarav Patel';
      const user = await service.verifyIdToken(validToken);

      expect(user).toBeDefined();
      expect(user.sub).toBe('sub-1001');
      expect(user.email).toBe('aarav.patel@pdeu.ac.in');
      expect(user.fullName).toBe('Aarav Patel');
      expect(user.avatarUrl).toContain('sub-1001');
    });

    it('should reject a token with invalid signature', async () => {
      const invalidSigToken =
        'mock-google-id-token:sub-1002:user@pdeu.ac.in:User Name:invalid-signature';
      await expect(service.verifyIdToken(invalidSigToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject a token with audience mismatch (wrong audience)', async () => {
      const wrongAudToken =
        'mock-google-id-token:sub-1003:user@pdeu.ac.in:User Name:wrong-audience';
      await expect(service.verifyIdToken(wrongAudToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject an expired token', async () => {
      const expiredToken =
        'mock-google-id-token:sub-1004:user@pdeu.ac.in:User Name:expired';
      await expect(service.verifyIdToken(expiredToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject a token with missing identity claims', async () => {
      const missingClaimsToken = 'mock-google-id-token:::';
      await expect(service.verifyIdToken(missingClaimsToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject empty or non-string tokens', async () => {
      await expect(service.verifyIdToken('')).rejects.toThrow(UnauthorizedException);
      await expect(service.verifyIdToken(null as any)).rejects.toThrow(UnauthorizedException);
    });
  });
});
