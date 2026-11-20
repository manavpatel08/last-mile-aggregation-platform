import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { of, throwError, lastValueFrom, delay } from 'rxjs';
import * as crypto from 'crypto';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  IdempotencyInterceptor,
  LEASE_DURATION_MS,
  MAX_REQUEST_PATH_LENGTH,
} from './idempotency.interceptor.js';

describe('IdempotencyInterceptor (Lease Ownership, Concurrency & Recovery)', () => {
  let module: TestingModule;
  let interceptor: IdempotencyInterceptor;
  let prisma: PrismaService;
  let reflector: Reflector;

  let testUserId1: string;
  let testUserId2: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [Reflector, IdempotencyInterceptor],
    }).compile();

    await module.init();

    prisma = module.get<PrismaService>(PrismaService);
    reflector = module.get<Reflector>(Reflector);
    interceptor = module.get<IdempotencyInterceptor>(IdempotencyInterceptor);

    // Create test users
    const user1 = await prisma.user.create({
      data: {
        email: `idemp-user1-${Date.now()}@pdeu.ac.in`,
        fullName: 'Idempotency User One',
        role: 'PASSENGER',
      },
    });
    testUserId1 = user1.id;

    const user2 = await prisma.user.create({
      data: {
        email: `idemp-user2-${Date.now()}@pdeu.ac.in`,
        fullName: 'Idempotency User Two',
        role: 'PASSENGER',
      },
    });
    testUserId2 = user2.id;
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({
      where: { userId: { in: [testUserId1, testUserId2] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [testUserId1, testUserId2] } },
    });
    await module.close();
  });

  beforeEach(() => {
    // Default: route handler marked as @Idempotent()
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
  });

  function createMockContext(options: {
    userId?: string;
    idempotencyKey?: string;
    method?: string;
    url?: string;
    body?: unknown;
  }): { context: ExecutionContext; response: { statusCode: number } } {
    const response = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
    };

    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    const request = {
      method: options.method || 'POST',
      url: options.url || '/api/v1/test',
      originalUrl: options.url || '/api/v1/test',
      headers,
      body: options.body ?? {},
      user: options.userId ? { id: options.userId } : undefined,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getHandler: () => () => {},
      getClass: () => class TestController {},
    } as unknown as ExecutionContext;

    return { context, response };
  }

  function createCallHandler(data: unknown, isError = false): CallHandler {
    return {
      handle: () => (isError ? throwError(() => data) : of(data)),
    };
  }

  async function executeIntercept(context: ExecutionContext, handler: CallHandler): Promise<unknown> {
    const obs = await interceptor.intercept(context, handler);
    return lastValueFrom(obs);
  }

  it('should reject missing or blank Idempotency-Key header', async () => {
    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: '',
    });

    await expect(
      executeIntercept(context, createCallHandler({ ok: true })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject unauthenticated requests', async () => {
    const { context } = createMockContext({
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(
      executeIntercept(context, createCallHandler({ ok: true })),
    ).rejects.toThrow(UnauthorizedException);
  });

  // 1. Two concurrent identical requests
  it('should execute concurrent identical requests from same user once and return identical response', async () => {
    const key = `conc-${crypto.randomUUID()}`;
    const payload = { amount: 100, item: 'e-rickshaw-ride' };

    let handlerExecutions = 0;
    const callHandler: CallHandler = {
      handle: () => {
        handlerExecutions++;
        return of({ result: 'success', execution: handlerExecutions }).pipe(delay(50));
      },
    };

    const { context: ctx1 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: payload,
    });
    const { context: ctx2 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: payload,
    });

    const [res1, res2] = await Promise.all([
      executeIntercept(ctx1, callHandler),
      executeIntercept(ctx2, callHandler),
    ]);

    expect(handlerExecutions).toBe(1);
    expect(res1).toEqual({ result: 'success', execution: 1 });
    expect(res2).toEqual({ result: 'success', execution: 1 });

    const records = await prisma.idempotencyRecord.findMany({
      where: { userId: testUserId1, idempotencyKey: key },
    });
    expect(records.length).toBe(1);
    expect(records[0].status).toBe('COMPLETED');
  });

  // 2. A live request lasting longer than 30 seconds
  it('should maintain claim lease via heartbeat for a live request lasting longer than 30 seconds', async () => {
    const key = `live-30s-${crypto.randomUUID()}`;
    const payload = { test: 'live-long-running' };

    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: payload,
    });

    // Start request with active lease
    const observable = await interceptor.intercept(
      context,
      createCallHandler({ finished: true }),
    );

    // Inspect the record created in DB
    const record = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId1, idempotencyKey: key },
      },
    });
    expect(record).not.toBeNull();
    expect(record?.status).toBe('IN_PROGRESS');
    expect(record?.lockedUntil).not.toBeNull();

    // Verify lockedUntil is approximately now + LEASE_DURATION_MS
    const diffMs = record!.lockedUntil!.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(25000);
    expect(diffMs).toBeLessThanOrEqual(LEASE_DURATION_MS + 2000);

    // Complete the operation
    const result = await lastValueFrom(observable);
    expect(result).toEqual({ finished: true });

    // Verify record is completed and lease released
    const completed = await prisma.idempotencyRecord.findUnique({
      where: { id: record!.id },
    });
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.lockedUntil).toBeNull();
  });

  // 3. A stale/replaced claim followed by the original request failing
  it('should NOT delete replaced claim when original request fails after claim ownership was lost', async () => {
    const key = `stale-fail-${crypto.randomUUID()}`;
    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: { action: 'stale-fail-test' },
    });

    // Request handler that throws an error after claim is replaced
    const failingHandler: CallHandler = {
      handle: () =>
        throwError(() => new BadRequestException({ message: 'Handler failed' })),
    };

    const observable = await interceptor.intercept(context, failingHandler);

    // Find the claim that Request 1 acquired
    const record = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId1, idempotencyKey: key },
      },
    });
    expect(record).not.toBeNull();
    const originalId = record!.id;

    // Simulate Request 2 taking over ownership because lease expired
    const newOwnerToken = 'owner-token-request-2';
    await prisma.idempotencyRecord.update({
      where: { id: originalId },
      data: {
        ownerToken: newOwnerToken,
        lockedUntil: new Date(Date.now() + 30000),
        version: { increment: 1 },
      },
    });

    // Now Request 1 fails and catchError executes
    await expect(lastValueFrom(observable)).rejects.toThrow(BadRequestException);

    // VERIFY: Request 2's record was NOT deleted because ownerToken did not match!
    const preservedRecord = await prisma.idempotencyRecord.findUnique({
      where: { id: originalId },
    });
    expect(preservedRecord).not.toBeNull();
    expect(preservedRecord?.ownerToken).toBe(newOwnerToken);
    expect(preservedRecord?.status).toBe('IN_PROGRESS');
  });

  // 4. A stale/replaced claim followed by the original request completing
  it('should NOT overwrite replaced claim when original request completes after claim ownership was lost', async () => {
    const key = `stale-complete-${crypto.randomUUID()}`;
    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: { action: 'stale-complete-test' },
    });

    const observable = await interceptor.intercept(
      context,
      createCallHandler({ original: 'response' }),
    );

    const record = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId1, idempotencyKey: key },
      },
    });
    expect(record).not.toBeNull();
    const originalId = record!.id;

    // Simulate Request 2 taking over ownership with a different ownerToken
    const newOwnerToken = 'owner-token-request-2-active';
    await prisma.idempotencyRecord.update({
      where: { id: originalId },
      data: {
        ownerToken: newOwnerToken,
        lockedUntil: new Date(Date.now() + 30000),
        version: { increment: 1 },
      },
    });

    // When Request 1 completes, updateMany matches 0 rows and throws ConflictException
    await expect(lastValueFrom(observable)).rejects.toThrow(ConflictException);

    // VERIFY: Request 2's claim was NOT overwritten with Request 1's response!
    const checkRecord = await prisma.idempotencyRecord.findUnique({
      where: { id: originalId },
    });
    expect(checkRecord?.ownerToken).toBe(newOwnerToken);
    expect(checkRecord?.status).toBe('IN_PROGRESS');
    expect(checkRecord?.responsePayload).toBeNull();
  });

  // 5. Database failure while persisting the completed response
  it('should throw InternalServerErrorException on database persistence failure and retain the in-progress claim', async () => {
    const key = `persist-fail-${crypto.randomUUID()}`;
    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: { action: 'db-fail-test' },
    });

    // Mock updateMany to simulate a database failure during completion
    const updateManySpy = vi
      .spyOn(prisma.idempotencyRecord, 'updateMany')
      .mockRejectedValue(new Error('PostgreSQL connection dropped'));

    const observable = await interceptor.intercept(
      context,
      createCallHandler({ businessMutation: 'committed' }),
    );

    // The interceptor must NOT swallow the error and return success!
    await expect(lastValueFrom(observable)).rejects.toThrow(
      InternalServerErrorException,
    );

    updateManySpy.mockRestore();

    // VERIFY: The claim was NOT deleted by catchError because business operation completed!
    const record = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId1, idempotencyKey: key },
      },
    });
    expect(record).not.toBeNull();
    expect(record?.status).toBe('IN_PROGRESS');
  });

  // 6. Process termination while a claim is IN_PROGRESS
  it('should safely allow takeover of an abandoned claim whose lease expired due to process termination', async () => {
    const key = `crashed-${crypto.randomUUID()}`;
    const payload = { action: 'process-crash-recovery' };

    // Simulate crashed process that created claim and terminated without completing
    const expiredRecord = await prisma.idempotencyRecord.create({
      data: {
        userId: testUserId1,
        idempotencyKey: key,
        requestPath: 'POST /api/v1/test',
        requestHash: crypto
          .createHash('sha256')
          .update(JSON.stringify(payload))
          .digest('hex'),
        status: 'IN_PROGRESS',
        ownerToken: 'crashed-process-token',
        lockedUntil: new Date(Date.now() - 5000), // Lease expired 5s ago
        version: 1,
      },
    });

    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: payload,
    });

    // Next request arrives: should take over the expired claim and complete successfully
    const result = await executeIntercept(context, createCallHandler({ recovered: true }));
    expect(result).toEqual({ recovered: true });

    const recovered = await prisma.idempotencyRecord.findUnique({
      where: { id: expiredRecord.id },
    });
    expect(recovered?.status).toBe('COMPLETED');
    expect(recovered?.version).toBe(2);
    expect(recovered?.ownerToken).not.toBe('crashed-process-token');
    expect(recovered?.responsePayload).toEqual({ recovered: true });
  });

  // 7. [] versus [null]
  it('should treat [] and [null] as distinct request payloads and detect conflict', async () => {
    const key = `distinct-array-${crypto.randomUUID()}`;

    // Request 1 with body []
    const { context: ctx1 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: [],
    });
    const res1 = await executeIntercept(ctx1, createCallHandler({ created: true }));
    expect(res1).toEqual({ created: true });

    // Request 2 with body [null] using the SAME key
    const { context: ctx2 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: [null],
    });

    await expect(
      executeIntercept(ctx2, createCallHandler({ created: true })),
    ).rejects.toThrow(ConflictException);
  });

  // 8. Nested arrays and null values
  it('should distinguish nested arrays, empty strings, and null values', async () => {
    const key1 = `nested-null-${crypto.randomUUID()}`;

    // { a: null } vs { a: "" }
    const { context: ctxA } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key1,
      body: { a: null },
    });
    await executeIntercept(ctxA, createCallHandler({ ok: true }));

    const { context: ctxB } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key1,
      body: { a: '' },
    });
    await expect(
      executeIntercept(ctxB, createCallHandler({ ok: true })),
    ).rejects.toThrow(ConflictException);

    // [[null]] vs [[]]
    const key2 = `nested-array-${crypto.randomUUID()}`;
    const { context: ctxC } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key2,
      body: [[null]],
    });
    await executeIntercept(ctxC, createCallHandler({ ok: true }));

    const { context: ctxD } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key2,
      body: [[]],
    });
    await expect(
      executeIntercept(ctxD, createCallHandler({ ok: true })),
    ).rejects.toThrow(ConflictException);
  });

  // 9. Long paths and query strings
  it('should support long paths and query strings (> 255 chars) without truncation and detect differences', async () => {
    const key = `long-path-${crypto.randomUUID()}`;
    const padding = 'x'.repeat(300);
    const longUrlA = `/api/v1/trips?filter=active&padding=${padding}&version=alpha`;
    const longUrlB = `/api/v1/trips?filter=active&padding=${padding}&version=beta`;

    expect(longUrlA.length).toBeGreaterThan(255);
    expect(longUrlB.length).toBeGreaterThan(255);

    // Request A on longUrlA
    const { context: ctxA } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      url: longUrlA,
    });
    const resA = await executeIntercept(ctxA, createCallHandler({ longPath: true }));
    expect(resA).toEqual({ longPath: true });

    // Verify stored path in DB is NOT truncated to 255 chars
    const record = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId1, idempotencyKey: key },
      },
    });
    expect(record?.requestPath).toContain(padding);
    expect(record?.requestPath.length).toBeGreaterThan(255);

    // Request B on longUrlB with same key -> must detect conflict past char 255!
    const { context: ctxB } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      url: longUrlB,
    });
    await expect(
      executeIntercept(ctxB, createCallHandler({ longPath: true })),
    ).rejects.toThrow(ConflictException);
  });

  it('should reject request path exceeding maximum supported length (4096 chars)', async () => {
    const key = `oversized-${crypto.randomUUID()}`;
    const oversizedUrl = `/api/v1/test?param=${'y'.repeat(MAX_REQUEST_PATH_LENGTH + 10)}`;

    const { context } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      url: oversizedUrl,
    });

    await expect(
      executeIntercept(context, createCallHandler({ ok: true })),
    ).rejects.toThrow(BadRequestException);
  });

  // 10. Same key across different users
  it('should allow different users to use the exact same idempotency key independently without conflict', async () => {
    const sharedKey = `shared-client-key-${crypto.randomUUID()}`;
    const payload = { bookRide: true };

    const { context: ctxUser1 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: sharedKey,
      body: payload,
    });
    const { context: ctxUser2 } = createMockContext({
      userId: testUserId2,
      idempotencyKey: sharedKey,
      body: payload,
    });

    const res1 = await executeIntercept(ctxUser1, createCallHandler({ user: 'one' }));
    const res2 = await executeIntercept(ctxUser2, createCallHandler({ user: 'two' }));

    expect(res1).toEqual({ user: 'one' });
    expect(res2).toEqual({ user: 'two' });

    const recUser1 = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId1, idempotencyKey: sharedKey },
      },
    });
    const recUser2 = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: { userId: testUserId2, idempotencyKey: sharedKey },
      },
    });

    expect(recUser1?.id).not.toBe(recUser2?.id);
    expect(recUser1?.responsePayload).toEqual({ user: 'one' });
    expect(recUser2?.responsePayload).toEqual({ user: 'two' });
  });

  // 11. Same key across different endpoints and different payloads
  it('should reject same key with different endpoint with IDEMPOTENCY_CONFLICT', async () => {
    const key = `cross-ep-${crypto.randomUUID()}`;

    const { context: ctx1 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      url: '/api/v1/bookings',
    });
    await executeIntercept(ctx1, createCallHandler({ step: 1 }));

    const { context: ctx2 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      url: '/api/v1/bookings/cancel',
    });
    await expect(
      executeIntercept(ctx2, createCallHandler({ step: 2 })),
    ).rejects.toThrow(ConflictException);
  });

  it('should reject same key with different payload with IDEMPOTENCY_CONFLICT', async () => {
    const key = `cross-body-${crypto.randomUUID()}`;

    const { context: ctx1 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: { passengers: 2 },
    });
    await executeIntercept(ctx1, createCallHandler({ booked: true }));

    const { context: ctx2 } = createMockContext({
      userId: testUserId1,
      idempotencyKey: key,
      body: { passengers: 4 },
    });
    await expect(
      executeIntercept(ctx2, createCallHandler({ booked: true })),
    ).rejects.toThrow(ConflictException);
  });
});
