import 'dart:async';
import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../core/realtime/models/realtime_event.dart';
import '../../../../core/realtime/socket_service.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../driver/services/driver_location_tracker.dart';
import '../../data/trip_repository.dart';
import '../../state/driver_active_trip_provider.dart';

/// Screen displaying the driver active trip management, arrival reporting button,
/// passenger manifest, and passenger boarding OTP verification form.
class DriverActiveTripScreen extends StatefulWidget {
  const DriverActiveTripScreen({
    super.key,
    required this.tripId,
    this.repository,
    this.provider,
  });

  final String tripId;
  final TripRepository? repository;
  final DriverActiveTripProvider? provider;

  @override
  State<DriverActiveTripScreen> createState() => _DriverActiveTripScreenState();
}

class _DriverActiveTripScreenState extends State<DriverActiveTripScreen> {
  late final DriverActiveTripProvider _provider;
  bool _ownsProvider = false;
  final Map<String, TextEditingController> _otpControllers = {};
  StreamSubscription<StandardRealtimeEvent>? _eventSubscription;
  SocketService? _socketService;
  DriverLocationTracker? _locationTracker;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_socketService == null) {
      try {
        _socketService = Provider.of<SocketService>(context, listen: false);
        _setupRealtime();
      } catch (_) {}
    }
    if (_locationTracker == null) {
      try {
        _locationTracker =
            Provider.of<DriverLocationTracker>(context, listen: false);
        _locationTracker?.setActiveTripId(widget.tripId);
      } catch (_) {}
    }
  }

  void _setupRealtime() {
    final socket = _socketService;
    if (socket == null) return;
    socket.subscribeTrip(widget.tripId);
    _eventSubscription?.cancel();
    _eventSubscription = socket.eventStream.listen((event) {
      if (!mounted) return;
      if (event.event == 'passenger.boarded') {
        final pId = event.data is Map ? event.data['passengerId'] : null;
        if (pId != null) _provider.onPassengerBoarded(pId.toString());
      } else if (event.event == 'trip.status.updated') {
        _provider.onTripStatusUpdated('IN_PROGRESS');
      } else if (event.event == 'passenger.dropped_off') {
        final pId = event.data is Map ? event.data['passengerId'] : null;
        if (pId != null) _provider.onPassengerDroppedOff(pId.toString());
      } else if (event.event == 'passenger.no_show') {
        final pId = event.data is Map ? event.data['passengerId'] : null;
        if (pId != null) _provider.onPassengerNoShow(pId.toString());
      } else if (event.event == 'trip.completed') {
        _provider.onTripCompleted();
        _locationTracker?.setActiveTripId(null);
      } else if (event.event == 'payment.confirmed') {
        if (event.data is Map) {
          _provider.onPaymentConfirmed(Map<String, dynamic>.from(event.data));
        }
      }
    });
  }

  @override
  void initState() {
    super.initState();
    if (widget.provider != null) {
      _provider = widget.provider!;
      _ownsProvider = false;
    } else {
      _provider = DriverActiveTripProvider(repository: widget.repository);
      _ownsProvider = true;
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _provider.loadTrip(widget.tripId, repository: widget.repository);
      }
    });
  }

  @override
  void dispose() {
    _socketService?.unsubscribeTrip(widget.tripId);
    _eventSubscription?.cancel();
    _locationTracker?.setActiveTripId(null);
    for (final controller in _otpControllers.values) {
      controller.dispose();
    }
    if (_ownsProvider) {
      _provider.dispose();
    }
    super.dispose();
  }

  TextEditingController _getControllerFor(String passengerId) {
    return _otpControllers.putIfAbsent(
      passengerId,
      () => TextEditingController(),
    );
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'AT_PICKUP':
      case 'BOARDED':
      case 'IN_PROGRESS':
        return AppColors.success;
      case 'CREATED':
      case 'ASSIGNED':
      case 'DRIVER_EN_ROUTE':
        return AppColors.warning;
      case 'NO_SHOW':
      case 'CANCELLED':
        return AppColors.error;
      default:
        return AppColors.textSecondary;
    }
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<DriverActiveTripProvider>.value(
      value: _provider,
      child: Consumer<DriverActiveTripProvider>(
        builder: (context, provider, _) {
          return Scaffold(
            appBar: AppBar(
              title: const Text('Trip Manifest & Boarding'),
              actions: [
                IconButton(
                  key: const Key('refresh_trip_button'),
                  icon: const Icon(Icons.refresh),
                  tooltip: 'Refresh',
                  onPressed: provider.isLoadingTrip
                      ? null
                      : () => provider.loadTrip(
                            widget.tripId,
                            repository: widget.repository,
                          ),
                ),
              ],
            ),
            body: SafeArea(
              child: Builder(
                builder: (context) {
                  if (provider.isLoadingTrip && provider.trip == null) {
                    return const Center(
                      child: CircularProgressIndicator(
                        key: Key('driver_trip_loading_indicator'),
                      ),
                    );
                  }

                  if (provider.generalError != null && provider.trip == null) {
                    return Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.error_outline,
                              size: 48,
                              color: AppColors.error,
                            ),
                            const SizedBox(height: 16),
                            Text(
                              provider.generalError!,
                              key: const Key('driver_trip_error_banner'),
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 16,
                                color: AppColors.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 24),
                            ElevatedButton.icon(
                              key: const Key('retry_load_trip_button'),
                              onPressed: () => provider.loadTrip(
                                widget.tripId,
                                repository: widget.repository,
                              ),
                              icon: const Icon(Icons.refresh),
                              label: const Text('Retry'),
                            ),
                          ],
                        ),
                      ),
                    );
                  }

                  final trip = provider.trip;
                  if (trip == null) {
                    return const Center(
                      child: Text('No trip manifest details available.'),
                    );
                  }

                  return ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      // General Success / Error Messages
                      if (provider.generalSuccess != null) ...[
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: AppColors.success.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: AppColors.success.withValues(alpha: 0.4),
                            ),
                          ),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.check_circle,
                                color: AppColors.success,
                                size: 20,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  provider.generalSuccess!,
                                  key: const Key('driver_trip_success_banner'),
                                  style: const TextStyle(
                                    color: AppColors.success,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],

                      if (provider.generalError != null) ...[
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: AppColors.error.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(
                              color: AppColors.error.withValues(alpha: 0.4),
                            ),
                          ),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.error_outline,
                                color: AppColors.error,
                                size: 20,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  provider.generalError!,
                                  style: const TextStyle(
                                    color: AppColors.error,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],

                      // Trip Status Card
                      Card(
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment:
                                    MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(
                                    'Trip #${trip.tripId.length > 8 ? trip.tripId.substring(0, 8) : trip.tripId}',
                                    style: const TextStyle(
                                      fontWeight: FontWeight.bold,
                                      fontSize: 16,
                                    ),
                                  ),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                      vertical: 4,
                                    ),
                                    decoration: BoxDecoration(
                                      color: _statusColor(trip.status)
                                          .withValues(alpha: 0.15),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: Text(
                                      trip.status,
                                      key: const Key('driver_trip_status_badge'),
                                      style: TextStyle(
                                        color: _statusColor(trip.status),
                                        fontWeight: FontWeight.bold,
                                        fontSize: 12,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              Text(
                                'Pickup Hub: PDEU Main Gate',
                                style: TextStyle(
                                  color: AppColors.textSecondary,
                                  fontSize: 13,
                                ),
                              ),
                              if (trip.driverArrivedAt != null) ...[
                                const SizedBox(height: 4),
                                Text(
                                  'Arrived at: ${trip.driverArrivedAt!.toLocal().toString().split('.').first}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: AppColors.success,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),

                      // Progression / Action Buttons
                      if (trip.status == 'COMPLETED') ...[
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          decoration: BoxDecoration(
                            color: AppColors.success.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: AppColors.success.withValues(alpha: 0.4),
                            ),
                          ),
                          child: const Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.check_circle,
                                color: AppColors.success,
                                size: 22,
                              ),
                              SizedBox(width: 8),
                              Text(
                                'Trip Completed',
                                key: Key('trip_completed_status_indicator'),
                                style: TextStyle(
                                  color: AppColors.success,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 15,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 12),
                        OutlinedButton.icon(
                          key: const Key('return_home_button'),
                          onPressed: () {
                            if (Navigator.of(context).canPop()) {
                              Navigator.of(context).pop();
                            } else {
                              context.go(AppRoutes.driverHome);
                            }
                          },
                          icon: const Icon(Icons.home),
                          label: const Text('Return to Driver Home'),
                        ),
                      ] else if (trip.isInProgress) ...[
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: AppColors.primary.withValues(alpha: 0.3),
                            ),
                          ),
                          child: const Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.navigation,
                                color: AppColors.primary,
                                size: 20,
                              ),
                              SizedBox(width: 8),
                              Text(
                                'Trip In Progress — Delivering Passengers',
                                key: Key('trip_in_progress_indicator'),
                                style: TextStyle(
                                  color: AppColors.primary,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 14,
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (provider.canCompleteTrip) ...[
                          const SizedBox(height: 12),
                          ElevatedButton.icon(
                            key: const Key('finalize_trip_button'),
                            onPressed: provider.isCompletingTrip
                                ? null
                                : () => provider.completeTrip(
                                      repository: widget.repository,
                                    ),
                            icon: provider.isCompletingTrip
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white,
                                    ),
                                  )
                                : const Icon(Icons.flag),
                            label: Text(
                              provider.isCompletingTrip
                                  ? 'Finalizing Trip...'
                                  : 'Finalize Trip',
                            ),
                            style: ElevatedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(vertical: 14),
                              backgroundColor: AppColors.success,
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                            ),
                          ),
                        ],
                      ] else if (trip.isAtPickup) ...[
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          decoration: BoxDecoration(
                            color: AppColors.success.withValues(alpha: 0.15),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: AppColors.success.withValues(alpha: 0.4),
                            ),
                          ),
                          child: const Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                Icons.check_circle,
                                color: AppColors.success,
                                size: 22,
                              ),
                              SizedBox(width: 8),
                              Text(
                                'Arrived at Pickup Hub',
                                key: Key('arrived_status_indicator'),
                                style: TextStyle(
                                  color: AppColors.success,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 15,
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (provider.canStartTrip) ...[
                          const SizedBox(height: 12),
                          ElevatedButton.icon(
                            key: const Key('start_trip_button'),
                            onPressed: provider.isStartingTrip
                                ? null
                                : () => provider.startTrip(
                                      repository: widget.repository,
                                    ),
                            icon: provider.isStartingTrip
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white,
                                    ),
                                  )
                                : const Icon(Icons.navigation),
                            label: Text(
                              provider.isStartingTrip
                                  ? 'Starting Trip...'
                                  : 'Start Trip (Depart Hub)',
                            ),
                            style: ElevatedButton.styleFrom(
                              padding: const EdgeInsets.symmetric(vertical: 14),
                              backgroundColor: AppColors.primary,
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                            ),
                          ),
                        ],
                      ] else ...[
                        ElevatedButton.icon(
                          key: const Key('driver_arrived_button'),
                          onPressed: provider.isReportingArrival
                              ? null
                              : () => provider.reportArrival(
                                    repository: widget.repository,
                                  ),
                          icon: provider.isReportingArrival
                              ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white,
                                    ),
                                  )
                              : const Icon(Icons.location_on),
                          label: Text(
                            provider.isReportingArrival
                                ? 'Reporting Arrival...'
                                : 'Arrived at Pickup Hub',
                          ),
                          style: ElevatedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            backgroundColor: AppColors.primary,
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 24),

                      // Passenger Manifest Title
                      Text(
                        'Assigned Passengers (${trip.passengers.length})',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 12),

                      // Passenger List
                      ...trip.passengers.asMap().entries.map((entry) {
                        final index = entry.key;
                        final passenger = entry.value;
                        final controller =
                            _getControllerFor(passenger.passengerId);
                        final isVerifying =
                            provider.isVerifying(passenger.passengerId);
                        final passengerError =
                            provider.errorForPassenger(passenger.passengerId);

                        return Card(
                          key: Key('passenger_card_${passenger.passengerId}'),
                          margin: const EdgeInsets.only(bottom: 12),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                            side: BorderSide(
                              color: passenger.isBoarded
                                  ? AppColors.success.withValues(alpha: 0.4)
                                  : AppColors.border,
                            ),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceBetween,
                                  children: [
                                    Text(
                                      'Passenger ${index + 1}',
                                      style: const TextStyle(
                                        fontWeight: FontWeight.bold,
                                        fontSize: 15,
                                      ),
                                    ),
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: _statusColor(passenger.status)
                                            .withValues(alpha: 0.15),
                                        borderRadius: BorderRadius.circular(6),
                                      ),
                                      child: Text(
                                        passenger.status,
                                        key: Key(
                                          'passenger_status_${passenger.passengerId}',
                                        ),
                                        style: TextStyle(
                                          color: _statusColor(passenger.status),
                                          fontWeight: FontWeight.bold,
                                          fontSize: 11,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  'Booking: ${passenger.bookingId.length > 8 ? passenger.bookingId.substring(0, 8) : passenger.bookingId}',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: AppColors.textSecondary,
                                  ),
                                ),
                                const Divider(height: 20),

                                // If passenger is COMPLETED
                                if (passenger.isCompleted) ...[
                                  Row(
                                    children: [
                                      const Icon(
                                        Icons.check_circle,
                                        color: AppColors.success,
                                        size: 20,
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        'Drop-Off Completed',
                                        key: Key(
                                          'passenger_completed_label_${passenger.passengerId}',
                                        ),
                                        style: const TextStyle(
                                          color: AppColors.success,
                                          fontWeight: FontWeight.bold,
                                          fontSize: 13,
                                        ),
                                      ),
                                      const Spacer(),
                                      Text(
                                        '₹${(passenger.finalRideFarePaise / 100).toStringAsFixed(2)}',
                                        key: Key(
                                          'passenger_fare_${passenger.passengerId}',
                                        ),
                                        style: const TextStyle(
                                          fontWeight: FontWeight.bold,
                                          color: AppColors.textPrimary,
                                        ),
                                      ),
                                    ],
                                  ),
                                  if (provider.cashReceipt(passenger.passengerId) != null) ...[
                                    Builder(
                                      builder: (context) {
                                        final receipt = provider
                                            .cashReceipt(passenger.passengerId)!;
                                        return Container(
                                          key: Key(
                                            'payment_receipt_${passenger.passengerId}',
                                          ),
                                          margin:
                                              const EdgeInsets.only(top: 10),
                                          padding: const EdgeInsets.all(12),
                                          decoration: BoxDecoration(
                                            color: AppColors.success
                                                .withValues(alpha: 0.08),
                                            borderRadius:
                                                BorderRadius.circular(8),
                                            border: Border.all(
                                              color: AppColors.success
                                                .withValues(alpha: 0.3),
                                            ),
                                          ),
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Row(
                                                children: [
                                                  const Icon(
                                                    Icons.check_circle,
                                                    color: AppColors.success,
                                                    size: 18,
                                                  ),
                                                  const SizedBox(width: 6),
                                                  Text(
                                                    'Payment Collected',
                                                    key: Key(
                                                      'payment_collected_badge_${passenger.passengerId}',
                                                    ),
                                                    style: const TextStyle(
                                                      color: AppColors.success,
                                                      fontWeight:
                                                          FontWeight.bold,
                                                      fontSize: 13,
                                                    ),
                                                  ),
                                                  const Spacer(),
                                                  Container(
                                                    padding:
                                                        const EdgeInsets.symmetric(
                                                      horizontal: 8,
                                                      vertical: 2,
                                                    ),
                                                    decoration: BoxDecoration(
                                                      color: AppColors.success
                                                          .withValues(
                                                        alpha: 0.15,
                                                      ),
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                        4,
                                                      ),
                                                    ),
                                                    child: Text(
                                                      receipt.paymentStatus,
                                                      key: Key(
                                                        'receipt_status_${passenger.passengerId}',
                                                      ),
                                                      style: const TextStyle(
                                                        color:
                                                            AppColors.success,
                                                        fontWeight:
                                                            FontWeight.bold,
                                                        fontSize: 11,
                                                      ),
                                                    ),
                                                  ),
                                                ],
                                              ),
                                              const Divider(height: 16),
                                              Row(
                                                mainAxisAlignment:
                                                    MainAxisAlignment
                                                        .spaceBetween,
                                                children: [
                                                  const Text(
                                                    'Total Cash Collected:',
                                                    style: TextStyle(
                                                      fontWeight:
                                                          FontWeight.bold,
                                                      fontSize: 13,
                                                    ),
                                                  ),
                                                  Text(
                                                    '₹${receipt.totalCashCollected}',
                                                    key: Key(
                                                      'confirmed_cash_total_${passenger.passengerId}',
                                                    ),
                                                    style: const TextStyle(
                                                      fontWeight:
                                                          FontWeight.bold,
                                                      fontSize: 15,
                                                      color: AppColors.success,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                              const SizedBox(height: 6),
                                              Text(
                                                'Ride Fare: ₹${receipt.rideFare}',
                                                key: Key(
                                                  'receipt_ride_fare_${passenger.passengerId}',
                                                ),
                                                style: const TextStyle(
                                                  fontSize: 12,
                                                  color:
                                                      AppColors.textSecondary,
                                                ),
                                              ),
                                              Text(
                                                'Waiting Charge: ₹${receipt.waitingCharge}',
                                                key: Key(
                                                  'receipt_waiting_charge_${passenger.passengerId}',
                                                ),
                                                style: const TextStyle(
                                                  fontSize: 12,
                                                  color:
                                                      AppColors.textSecondary,
                                                ),
                                              ),
                                              if (receipt.surchargeFeesPaise >
                                                  0) ...[
                                                Text(
                                                  'Surcharge Fees: ₹${receipt.surchargeFees}',
                                                  key: Key(
                                                    'receipt_surcharge_fees_${passenger.passengerId}',
                                                  ),
                                                  style: const TextStyle(
                                                    fontSize: 12,
                                                    color: AppColors.warning,
                                                    fontWeight:
                                                        FontWeight.w500,
                                                  ),
                                                ),
                                              ],
                                              if (receipt.paymentAllocations
                                                  .isNotEmpty) ...[
                                                const SizedBox(height: 6),
                                                const Text(
                                                  'Allocations:',
                                                  style: TextStyle(
                                                    fontSize: 11,
                                                    fontWeight:
                                                        FontWeight.bold,
                                                    color:
                                                        AppColors.textSecondary,
                                                  ),
                                                ),
                                                ...receipt.paymentAllocations
                                                    .map(
                                                  (alloc) => Padding(
                                                    padding:
                                                        const EdgeInsets.only(
                                                      left: 4,
                                                      top: 2,
                                                    ),
                                                    child: Text(
                                                      '• ${alloc.obligationType}: ₹${alloc.allocatedAmount}',
                                                      style: const TextStyle(
                                                        fontSize: 11,
                                                        color: AppColors
                                                            .textSecondary,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                              ],
                                              if (receipt.confirmedAt !=
                                                  null) ...[
                                                const SizedBox(height: 6),
                                                Text(
                                                  'Confirmed at: ${receipt.confirmedAt!.toLocal().toString().split('.').first}',
                                                  key: Key(
                                                    'confirmed_at_text_${passenger.passengerId}',
                                                  ),
                                                  style: const TextStyle(
                                                    fontSize: 11,
                                                    color:
                                                        AppColors.textSecondary,
                                                  ),
                                                ),
                                              ],
                                            ],
                                          ),
                                        );
                                      },
                                    ),
                                  ] else if (provider.dropOffResult(
                                          passenger.passengerId) !=
                                      null) ...[
                                    const SizedBox(height: 8),
                                    Container(
                                      key: Key(
                                        'cash_breakdown_${passenger.passengerId}',
                                      ),
                                      padding: const EdgeInsets.all(8),
                                      decoration: BoxDecoration(
                                        color: AppColors.surface,
                                        borderRadius:
                                            BorderRadius.circular(8),
                                        border:
                                            Border.all(color: AppColors.border),
                                      ),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            'Ride Fare: ₹${provider.dropOffResult(passenger.passengerId)!.rideFare}',
                                            style: const TextStyle(fontSize: 12),
                                          ),
                                          Text(
                                            'Waiting Charge: ₹${provider.dropOffResult(passenger.passengerId)!.waitingCharge}',
                                            style: const TextStyle(fontSize: 12),
                                          ),
                                          Text(
                                            'Total Cash to Collect: ₹${provider.dropOffResult(passenger.passengerId)!.totalCashToCollect}',
                                            style: const TextStyle(
                                              fontSize: 12,
                                              fontWeight: FontWeight.bold,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(height: 10),
                                    SizedBox(
                                      width: double.infinity,
                                      child: ElevatedButton.icon(
                                        key: Key(
                                          'confirm_cash_button_${passenger.passengerId}',
                                        ),
                                        onPressed: provider.isConfirmingCash(
                                                passenger.passengerId)
                                            ? null
                                            : () =>
                                                provider.confirmCashCollection(
                                                  passengerId:
                                                      passenger.passengerId,
                                                  repository:
                                                      widget.repository,
                                                ),
                                        icon: provider.isConfirmingCash(
                                                passenger.passengerId)
                                            ? const SizedBox(
                                                width: 14,
                                                height: 14,
                                                child:
                                                    CircularProgressIndicator(
                                                  strokeWidth: 2,
                                                  color: Colors.white,
                                                ),
                                              )
                                            : const Icon(
                                                Icons.payments,
                                                size: 16,
                                              ),
                                        label: Text(
                                          provider.isConfirmingCash(
                                                  passenger.passengerId)
                                              ? 'Confirming Cash...'
                                              : 'Confirm Cash Payment (₹${provider.dropOffResult(passenger.passengerId)!.totalCashToCollect})',
                                        ),
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: AppColors.success,
                                          foregroundColor: Colors.white,
                                          visualDensity:
                                              VisualDensity.compact,
                                          shape: RoundedRectangleBorder(
                                            borderRadius:
                                                BorderRadius.circular(8),
                                          ),
                                        ),
                                      ),
                                    ),
                                    if (provider.cashError(
                                            passenger.passengerId) !=
                                        null) ...[
                                      const SizedBox(height: 6),
                                      Text(
                                        provider.cashError(
                                            passenger.passengerId)!,
                                        key: Key(
                                          'cash_error_${passenger.passengerId}',
                                        ),
                                        style: const TextStyle(
                                          color: AppColors.error,
                                          fontSize: 12,
                                          fontWeight: FontWeight.w500,
                                        ),
                                      ),
                                    ],
                                  ],
                                ] else if (passenger.isCancelled) ...[
                                  Row(
                                    children: [
                                      const Icon(
                                        Icons.cancel_outlined,
                                        color: AppColors.error,
                                        size: 20,
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        'Booking Cancelled',
                                        key: Key(
                                          'passenger_cancelled_label_${passenger.passengerId}',
                                        ),
                                        style: const TextStyle(
                                          color: AppColors.error,
                                          fontWeight: FontWeight.bold,
                                          fontSize: 13,
                                        ),
                                      ),
                                    ],
                                  ),
                                ] else if (passenger.isNoShow) ...[
                                  Row(
                                    children: [
                                      const Icon(
                                        Icons.person_off_outlined,
                                        color: AppColors.error,
                                        size: 20,
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        'Marked No-Show',
                                        key: Key(
                                          'passenger_noshow_label_${passenger.passengerId}',
                                        ),
                                        style: const TextStyle(
                                          color: AppColors.error,
                                          fontWeight: FontWeight.bold,
                                          fontSize: 13,
                                        ),
                                      ),
                                    ],
                                  ),
                                ] else if (passenger.isBoarded) ...[
                                  if (trip.isInProgress) ...[
                                    Row(
                                      mainAxisAlignment:
                                          MainAxisAlignment.spaceBetween,
                                      children: [
                                        const Row(
                                          children: [
                                            Icon(
                                              Icons.directions_car,
                                              color: AppColors.primary,
                                              size: 20,
                                            ),
                                            SizedBox(width: 8),
                                            Text(
                                              'On Board',
                                              style: TextStyle(
                                                color: AppColors.primary,
                                                fontWeight: FontWeight.bold,
                                                fontSize: 13,
                                              ),
                                            ),
                                          ],
                                        ),
                                        ElevatedButton.icon(
                                          key: Key(
                                            'complete_drop_off_button_${passenger.passengerId}',
                                          ),
                                          onPressed: provider
                                                  .isCompletingPassenger(
                                                      passenger.passengerId)
                                              ? null
                                              : () => provider
                                                  .completePassengerDropOff(
                                                    passengerId:
                                                        passenger.passengerId,
                                                    repository:
                                                        widget.repository,
                                                  ),
                                          icon: provider.isCompletingPassenger(
                                                  passenger.passengerId)
                                              ? const SizedBox(
                                                  width: 14,
                                                  height: 14,
                                                  child:
                                                      CircularProgressIndicator(
                                                    strokeWidth: 2,
                                                    color: Colors.white,
                                                  ),
                                                )
                                              : const Icon(Icons.check,
                                                  size: 16),
                                          label:
                                              const Text('Complete Drop-Off'),
                                          style: ElevatedButton.styleFrom(
                                            backgroundColor: AppColors.primary,
                                            foregroundColor: Colors.white,
                                            visualDensity:
                                                VisualDensity.compact,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ] else ...[
                                    Row(
                                      children: [
                                        const Icon(
                                          Icons.check_circle,
                                          color: AppColors.success,
                                          size: 20,
                                        ),
                                        const SizedBox(width: 8),
                                        Text(
                                          'Boarding Verified',
                                          key: Key(
                                            'passenger_verified_label_${passenger.passengerId}',
                                          ),
                                          style: const TextStyle(
                                            color: AppColors.success,
                                            fontWeight: FontWeight.bold,
                                            fontSize: 13,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ] else ...[
                                  // OTP Input & Verification Row
                                  Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.center,
                                    children: [
                                      Expanded(
                                        child: TextField(
                                          key: Key(
                                            'otp_input_${passenger.passengerId}',
                                          ),
                                          controller: controller,
                                          keyboardType: TextInputType.number,
                                          maxLength: 4,
                                          decoration: InputDecoration(
                                            counterText: '',
                                            hintText: '4-digit OTP',
                                            isDense: true,
                                            contentPadding:
                                                const EdgeInsets.symmetric(
                                              horizontal: 12,
                                              vertical: 10,
                                            ),
                                            border: OutlineInputBorder(
                                              borderRadius:
                                                  BorderRadius.circular(8),
                                            ),
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      ElevatedButton(
                                        key: Key(
                                          'verify_otp_button_${passenger.passengerId}',
                                        ),
                                        onPressed: isVerifying
                                            ? null
                                            : () {
                                                provider.verifyPassengerOtp(
                                                  passengerId:
                                                      passenger.passengerId,
                                                  otp: controller.text,
                                                  repository: widget.repository,
                                                );
                                              },
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: AppColors.primary,
                                          foregroundColor: Colors.white,
                                          shape: RoundedRectangleBorder(
                                            borderRadius:
                                                BorderRadius.circular(8),
                                          ),
                                        ),
                                        child: isVerifying
                                            ? const SizedBox(
                                                width: 16,
                                                height: 16,
                                                child:
                                                    CircularProgressIndicator(
                                                  strokeWidth: 2,
                                                  color: Colors.white,
                                                ),
                                              )
                                            : const Text('Verify'),
                                      ),
                                    ],
                                  ),
                                  if (passengerError != null) ...[
                                    const SizedBox(height: 8),
                                    Text(
                                      passengerError,
                                      key: Key(
                                        'passenger_error_${passenger.passengerId}',
                                      ),
                                      style: const TextStyle(
                                        color: AppColors.error,
                                        fontSize: 12,
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                  ],
                                ],
                              ],
                            ),
                          ),
                        );
                      }),
                    ],
                  );
                },
              ),
            ),
          );
        },
      ),
    );
  }
}
