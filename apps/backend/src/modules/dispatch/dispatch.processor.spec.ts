import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DispatchProcessor } from './dispatch.processor.js';
import { DispatchService } from './dispatch.service.js';
import {
  DispatchTimeoutJobPayload,
  DISPATCH_TIMEOUT_JOB_NAME,
} from './dispatch.interfaces.js';

describe('DispatchProcessor - Unit Tests', () => {
  let processor: DispatchProcessor;
  let dispatchServiceMock: any;

  beforeEach(() => {
    dispatchServiceMock = {
      handleOfferTimeout: vi.fn(),
    };

    processor = new DispatchProcessor(
      dispatchServiceMock as unknown as DispatchService,
    );
  });

  it('should delegate dispatch-timeout jobs to DispatchService.handleOfferTimeout', async () => {
    const payload: DispatchTimeoutJobPayload = {
      offerId: 'offer-123',
      rideGroupId: 'group-123',
      driverId: 'driver-123',
      groupVersion: 1,
      dispatchAttemptId: 'attempt-123',
    };

    const mockJob: any = {
      id: 'dispatch-timeout-offer-123',
      name: DISPATCH_TIMEOUT_JOB_NAME,
      data: payload,
    };

    dispatchServiceMock.handleOfferTimeout.mockResolvedValue({
      expired: true,
      cascaded: true,
      nextOfferId: 'offer-456',
    });

    const result = await processor.process(mockJob);

    expect(dispatchServiceMock.handleOfferTimeout).toHaveBeenCalledWith(payload);
    expect(result).toEqual({
      expired: true,
      cascaded: true,
      nextOfferId: 'offer-456',
    });
  });

  it('should warn and return null for unrecognized job names', async () => {
    const mockJob: any = {
      id: 'job-unrecognized',
      name: 'some-unknown-job',
      data: {},
    };

    const result = await processor.process(mockJob);

    expect(dispatchServiceMock.handleOfferTimeout).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
