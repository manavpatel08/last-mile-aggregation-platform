import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('Demo & Mock Token Security Restrictions (Stage 11 Task 1)', () => {
    it('1. Demo tokens must be rejected in production', async () => {
      const prodConfig = new ConfigService({
        environment: 'production',
        DEMO_MODE: true, // even if someone attempts to enable it
      });
      const prodService = new GoogleAuthService(prodConfig);

      const demoToken =
        'demo-google-token:admin-google-sub-001:admin@pdeu.ac.in:Platform Administrator';
      await expect(prodService.verifyIdToken(demoToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(prodService.verifyIdToken(demoToken)).rejects.toThrow(
        'Demo tokens are disabled',
      );

      const mockToken =
        'mock-google-id-token:sub-1001:user@pdeu.ac.in:User Name';
      await expect(prodService.verifyIdToken(mockToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(prodService.verifyIdToken(mockToken)).rejects.toThrow(
        'Mock identity tokens are only permitted in test environments',
      );
    });

    it('2. Demo tokens must be rejected when DEMO_MODE is false or undefined', async () => {
      const nonDemoConfig = new ConfigService({
        environment: 'development',
        demoMode: false,
        DEMO_MODE: false,
      });
      const nonDemoService = new GoogleAuthService(nonDemoConfig);

      const demoToken =
        'demo-google-token:admin-google-sub-001:admin@pdeu.ac.in:Platform Administrator';
      await expect(nonDemoService.verifyIdToken(demoToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(nonDemoService.verifyIdToken(demoToken)).rejects.toThrow(
        'Demo tokens are disabled',
      );
    });

    it('3. Genuine Google OAuth flow is preserved and invoked for standard tokens', async () => {
      const mockOAuth2Client = {
        verifyIdToken: vi.fn().mockResolvedValue({
          getPayload: () => ({
            iss: 'accounts.google.com',
            sub: 'real-google-sub-999',
            email: 'real.user@gmail.com',
            name: 'Real User',
            picture: 'https://avatar.url/pic.jpg',
          }),
        }),
      };
      (service as any).oauth2Client = mockOAuth2Client;

      const genuineGoogleJwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEy...real-google-jwt';
      const result = await service.verifyIdToken(genuineGoogleJwt);

      expect(mockOAuth2Client.verifyIdToken).toHaveBeenCalledWith({
        idToken: genuineGoogleJwt,
        audience: expect.any(Array),
      });
      expect(result.sub).toBe('real-google-sub-999');
      expect(result.email).toBe('real.user@gmail.com');
      expect(result.fullName).toBe('Real User');
    });

    it('4. Demo tokens cannot impersonate non-demo accounts', async () => {
      const nonDemoImpersonation =
        'demo-google-token:attacker-sub:victim.student@pdeu.ac.in:Victim';
      await expect(service.verifyIdToken(nonDemoImpersonation)).rejects.toThrow(
        'Demo tokens cannot be used for non-demo accounts',
      );
    });

    it('5. Demo tokens cannot forge arbitrary sub for administrator account', async () => {
      const forgedAdminToken =
        'demo-google-token:forged-sub-999:admin@pdeu.ac.in:Platform Administrator';
      await expect(service.verifyIdToken(forgedAdminToken)).rejects.toThrow(
        'Demo token sub mismatch for administrator account',
      );
    });

    it('6. Valid demo token for approved demo accounts succeeds in demo mode', async () => {
      const validAdminToken =
        'demo-google-token:admin-google-sub-001:admin@pdeu.ac.in:Platform Administrator';
      const adminResult = await service.verifyIdToken(validAdminToken);
      expect(adminResult.sub).toBe('admin-google-sub-001');
      expect(adminResult.email).toBe('admin@pdeu.ac.in');

      const validPaxToken =
        'demo-google-token:pax-sub-001:demo.passenger1@pdeu.ac.in:Commuter A';
      const paxResult = await service.verifyIdToken(validPaxToken);
      expect(paxResult.sub).toBe('pax-sub-001');
      expect(paxResult.email).toBe('demo.passenger1@pdeu.ac.in');
    });
  });
});
