import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter.js';

describe('Auth & RBAC End-to-End Suite (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  // Track created test IDs for isolated cleanup
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'health/ready', 'health/live'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    // Isolated cleanup of all created test entities
    for (const userId of createdUserIds) {
      await prisma.userSession.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.authIdentity.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.passengerProfile.deleteMany({ where: { userId } }).catch(() => {});
      const driver = await prisma.driverProfile.findUnique({ where: { userId } }).catch(() => null);
      if (driver) {
        await prisma.driverDocument.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.vehicle.deleteMany({ where: { driverProfileId: driver.id } }).catch(() => {});
        await prisma.driverProfile.delete({ where: { id: driver.id } }).catch(() => {});
      }
      await prisma.userRole.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }

    await app.close();
  });

  describe('Unauthenticated & Missing Credentials Protections', () => {
    it('should reject requests without authorization header with 401 UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('UNAUTHORIZED');
    });

    it('should reject malformed or invalid JWT tokens with 401 UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer invalid-garbage-token')
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('UNAUTHORIZED');
    });
  });

  describe('Google OAuth & Session Lifecycle', () => {
    let passengerAccessToken: string;
    let passengerRefreshToken: string;
    let passengerUserId: string;

    it('should authenticate user with Google ID token, creating user and session', async () => {
      const googleToken = `mock-google-id-token:sub-e2e-${Date.now()}:aarav.e2e@pdeu.ac.in:Aarav E2E`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: googleToken })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toBeDefined();
      expect(res.body.data.user.email).toBe('aarav.e2e@pdeu.ac.in');
      expect(res.body.data.user.role).toBe('PASSENGER');
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.expiresIn).toBe(900);

      passengerAccessToken = res.body.data.accessToken;
      passengerRefreshToken = res.body.data.refreshToken;
      passengerUserId = res.body.data.user.id;
      createdUserIds.push(passengerUserId);
    });

    it('should access /api/v1/users/me with valid access token', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${passengerAccessToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(passengerUserId);
      expect(res.body.data.email).toBe('aarav.e2e@pdeu.ac.in');
      expect(res.body.data.passengerProfile.defaultMinGroupPreference).toBe(2);
      expect(res.body.data.outstandingCancellationFees.count).toBe(0);
    });

    it('should update profile preference via PATCH /api/v1/users/me', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${passengerAccessToken}`)
        .send({ defaultMinGroupPreference: 3 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.passengerProfile.defaultMinGroupPreference).toBe(3);
    });

    it('should successfully rotate refresh token via POST /api/v1/auth/refresh', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: passengerRefreshToken })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.refreshToken).not.toBe(passengerRefreshToken);

      const oldToken = passengerRefreshToken;
      passengerAccessToken = res.body.data.accessToken;
      passengerRefreshToken = res.body.data.refreshToken;

      // Replay Attack Test: Try refreshing using the old burned token
      const replayRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: oldToken })
        .expect(401);

      expect(replayRes.body.success).toBe(false);

      // Verify that after replay detection, even the replacement token was revoked!
      const subsequentRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: passengerRefreshToken })
        .expect(401);

      expect(subsequentRes.body.success).toBe(false);
    });

    it('should generate a 60-second single-use socket ticket', async () => {
      // Re-login to get fresh active session
      const googleToken = `mock-google-id-token:sub-e2e-ticket:ticket.user@pdeu.ac.in:Ticket User`;
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: googleToken })
        .expect(200);

      createdUserIds.push(loginRes.body.data.user.id);
      const token = loginRes.body.data.accessToken;

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/socket-ticket')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.ticket).toBeDefined();
      expect(res.body.data.expiresIn).toBe(60);
    });

    it('should terminate session on POST /api/v1/auth/logout', async () => {
      const googleToken = `mock-google-id-token:sub-e2e-logout:logout.user@pdeu.ac.in:Logout User`;
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: googleToken })
        .expect(200);

      createdUserIds.push(loginRes.body.data.user.id);
      const token = loginRes.body.data.accessToken;

      // Access succeeds before logout
      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Perform logout
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Access is immediately revoked
      const afterLogoutRes = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(afterLogoutRes.body.success).toBe(false);
    });

    it('should terminate all sessions on POST /api/v1/auth/logout-all', async () => {
      const googleToken = `mock-google-id-token:sub-e2e-logoutall:logoutall.user@pdeu.ac.in:LogoutAll User`;
      const login1 = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: googleToken, deviceFingerprint: 'device-a' })
        .expect(200);

      const login2 = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: googleToken, deviceFingerprint: 'device-b' })
        .expect(200);

      createdUserIds.push(login1.body.data.user.id);

      // Call logout-all using session 1
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${login1.body.data.accessToken}`)
        .expect(200);

      // Both tokens are now invalid
      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${login1.body.data.accessToken}`)
        .expect(401);

      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${login2.body.data.accessToken}`)
        .expect(401);
    });
  });

  describe('RBAC & Driver Approval Enforcement (Zero Frontend Trust)', () => {
    let passengerToken: string;
    let passengerUserId: string;
    let driverToken: string;
    let driverUserId: string;
    let adminToken: string;
    let adminUserId: string;
    let driverProfileId: string;

    beforeAll(async () => {
      // 1. Create Passenger
      const pRes = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: `mock-google-id-token:pax-${Date.now()}:pax@pdeu.ac.in:Pax Commuter` });
      passengerToken = pRes.body.data.accessToken;
      passengerUserId = pRes.body.data.user.id;
      createdUserIds.push(passengerUserId);

      // 2. Create Driver candidate
      const dRes = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: `mock-google-id-token:drv-${Date.now()}:drv@pdeu.ac.in:Driver Cand` });
      driverToken = dRes.body.data.accessToken;
      driverUserId = dRes.body.data.user.id;
      createdUserIds.push(driverUserId);

      // 3. Create Admin user directly in DB
      const adminUser = await prisma.user.create({
        data: {
          email: `admin-${Date.now()}@pdeu.ac.in`,
          fullName: 'Security Transport Admin',
          role: 'ADMIN',
          roles: {
            create: { roleName: 'ADMIN' },
          },
        },
      });
      adminUserId = adminUser.id;
      createdUserIds.push(adminUserId);

      // Login as Admin via Google mock linking to admin email
      const aRes = await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send({ idToken: `mock-google-id-token:admin-sub-${Date.now()}:${adminUser.email}:Security Admin` });
      adminToken = aRes.body.data.accessToken;
    });

    it('should reject a passenger attempting to access driver operational endpoints with 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should reject non-admin users from calling admin endpoints with 403 FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/drivers/pending')
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
    });

    it('should allow candidate to submit driver onboarding application with PENDING status', async () => {
      const uniqueReg = `GJ-01-E2E-${Date.now().toString().slice(-4)}`;
      const uniqueLic = `LIC-E2E-${Date.now()}`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/drivers/onboard')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          licenseNumber: uniqueLic,
          vehicle: {
            registrationNumber: uniqueReg,
            vehicleType: 'E_RICKSHAW',
            passengerCapacity: 4,
            makeModel: 'Mahindra Treo 2026',
          },
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.driverProfile.verificationStatus).toBe('PENDING');
      driverProfileId = res.body.data.driverProfile.id;
    });

    it('should reject unapproved driver from accessing protected driver operations with 403 FORBIDDEN', async () => {
      // Driver now has DRIVER role, but verificationStatus is still PENDING!
      const res = await request(app.getHttpServer())
        .get('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
      expect(res.body.message).toContain('not approved');
    });

    it('should allow admin to list pending drivers via GET /api/v1/admin/drivers/pending', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/drivers/pending')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      const pendingIds = res.body.data.map((d: any) => d.id);
      expect(pendingIds).toContain(driverProfileId);
    });

    it('should allow admin to approve driver via POST /api/v1/admin/drivers/:id/approve', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/drivers/${driverProfileId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('APPROVED');
    });

    it('should permit approved driver to access protected driver operations', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('APPROVED');
      expect(res.body.data.vehiclesCount).toBeGreaterThanOrEqual(1);
    });

    it('should reject suspended driver from operational endpoints', async () => {
      // Mark driver operational_status = SUSPENDED in database
      await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { operationalStatus: 'SUSPENDED' },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('FORBIDDEN');
      expect(res.body.message).toContain('suspended');
    });

    it('should prevent role escalation attempts via client payload tampering', async () => {
      // Passenger attempts to patch their own role to ADMIN
      const res = await request(app.getHttpServer())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ role: 'ADMIN', defaultMinGroupPreference: 4 } as any)
        .expect(400); // ValidationPipe rejects non-whitelisted property 'role'

      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('VALIDATION_ERROR');

      // Verify user in DB still has role PASSENGER
      const dbUser = await prisma.user.findUnique({ where: { id: passengerUserId } });
      expect(dbUser?.role).toBe('PASSENGER');
    });
  });
});
