import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DriverOffersController } from './driver-offers.controller.js';
import { DispatchService } from './dispatch.service.js';

describe('DriverOffersController - Unit Tests', () => {
  let controller: DriverOffersController;
  let dispatchServiceMock: any;

  beforeEach(() => {
    dispatchServiceMock = {
      getPendingOffersForDriver: vi.fn(),
      acceptOffer: vi.fn(),
      rejectOffer: vi.fn(),
    };

    controller = new DriverOffersController(
      dispatchServiceMock as unknown as DispatchService,
    );
  });

  describe('GET /drivers/offers/pending', () => {
    it('should return pending offers from DispatchService', async () => {
      const mockOffers = [
        {
          offerId: 'offer-1',
          rideGroupId: 'group-1',
          remainingSeconds: 18,
          totalEstimatedFare: '85.00',
        },
      ];
      dispatchServiceMock.getPendingOffersForDriver.mockResolvedValue(mockOffers);

      const res = await controller.getPendingOffers('user-123');

      expect(dispatchServiceMock.getPendingOffersForDriver).toHaveBeenCalledWith('user-123');
      expect(res).toEqual({
        success: true,
        data: mockOffers,
      });
    });
  });

  describe('POST /drivers/offers/:id/accept', () => {
    it('should delegate offer acceptance with claim context', async () => {
      const mockClaim: any = { id: 'claim-1', ownerToken: 'token-1' };
      const mockAcceptData = {
        assignmentId: 'assign-1',
        tripId: 'trip-1',
        rideGroupId: 'group-1',
        passengerCount: 3,
        totalEstimatedFare: '114.00',
        navigationRoute: { geometry: {}, stops: [] },
      };
      dispatchServiceMock.acceptOffer.mockResolvedValue(mockAcceptData);

      const res = await controller.acceptOffer('user-123', 'offer-1', mockClaim);

      expect(dispatchServiceMock.acceptOffer).toHaveBeenCalledWith(
        'user-123',
        'offer-1',
        mockClaim,
      );
      expect(res).toEqual({
        success: true,
        data: mockAcceptData,
      });
    });
  });

  describe('POST /drivers/offers/:id/reject', () => {
    it('should delegate offer rejection with reason and claim', async () => {
      const mockClaim: any = { id: 'claim-2', ownerToken: 'token-2' };
      const dto = { reason: 'Too far away' };
      dispatchServiceMock.rejectOffer.mockResolvedValue({
        success: true,
        message: 'Offer rejected successfully',
      });

      const res = await controller.rejectOffer('user-123', 'offer-1', dto, mockClaim);

      expect(dispatchServiceMock.rejectOffer).toHaveBeenCalledWith(
        'user-123',
        'offer-1',
        dto,
        mockClaim,
      );
      expect(res).toEqual({
        success: true,
        message: 'Offer rejected successfully',
      });
    });
  });
});
