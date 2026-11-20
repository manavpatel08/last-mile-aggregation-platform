import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../passenger/state/passenger_home_provider.dart';
import '../../state/booking_flow_provider.dart';
import '../widgets/destination_map_picker.dart';
import '../widgets/fare_quote_card.dart';

/// Screen coordinating the complete passenger booking flow:
/// pickup hub verification, destination selection via map, 2-minute binding fare quote,
/// ride mode configuration, upfront consent, and idempotent submission.
class BookingFlowScreen extends StatefulWidget {
  const BookingFlowScreen({super.key});

  @override
  State<BookingFlowScreen> createState() => _BookingFlowScreenState();
}

class _BookingFlowScreenState extends State<BookingFlowScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final provider = context.read<BookingFlowProvider>();
      if (provider.pickupPoints.isEmpty) {
        provider.loadInitialData();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final provider = context.watch<BookingFlowProvider>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book a Ride'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () {
            if (provider.createdBooking != null) {
              provider.resetFlow();
            }
            context.go(AppRoutes.passengerHome);
          },
        ),
      ),
      body: SafeArea(
        child: _buildContent(context, provider, textTheme),
      ),
    );
  }

  Widget _buildContent(
    BuildContext context,
    BookingFlowProvider provider,
    TextTheme textTheme,
  ) {
    if (provider.isLoadingInitialData) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('Loading transit hubs and map boundaries...'),
          ],
        ),
      );
    }

    if (provider.initialDataError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off, size: 48, color: AppColors.error),
              const SizedBox(height: 16),
              Text(
                'Unable to load transit data',
                style: textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                provider.initialDataError!,
                textAlign: TextAlign.center,
                style: textTheme.bodySmall?.copyWith(
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: () => provider.loadInitialData(),
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    // Success Screen when booking is confirmed
    if (provider.createdBooking != null) {
      final booking = provider.createdBooking!;
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.success.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.check_circle_outline,
                size: 64,
                color: AppColors.success,
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'Booking Requested!',
              textAlign: TextAlign.center,
              style: textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
                color: AppColors.primary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Your ride request has been registered and is entering matching.',
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 24),
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
                side: const BorderSide(color: AppColors.border),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    _DetailRow(
                      label: 'Booking ID',
                      value: booking.bookingId,
                      valueKey: const Key('created_booking_id'),
                    ),
                    const Divider(height: 16),
                    _DetailRow(
                      label: 'Status',
                      value: booking.status,
                      valueKey: const Key('created_booking_status'),
                      valueColor: AppColors.success,
                    ),
                    const Divider(height: 16),
                    _DetailRow(
                      label: 'Agreed Fare Ceiling',
                      value: '₹${booking.agreedFareCeiling}',
                      valueKey: const Key('created_booking_ceiling'),
                      valueColor: AppColors.primary,
                    ),
                    const Divider(height: 16),
                    _DetailRow(
                      label: 'Max Wait Deadline',
                      value: booking.maxWaitDeadline
                          .toLocal()
                          .toString()
                          .split('.')
                          .first,
                      valueKey: const Key('created_booking_deadline'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 28),
            FilledButton.icon(
              key: const Key('return_to_passenger_home_button'),
              onPressed: () {
                // Update passenger home active booking
                context
                    .read<PassengerHomeProvider>()
                    .updateActiveBooking(booking);
                provider.resetFlow();
                context.go(AppRoutes.passengerHome);
              },
              icon: const Icon(Icons.home),
              label: const Text('Return to Passenger Home'),
            ),
          ],
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // 1. Pickup Zone Hub Selection & Geofence
        _buildPickupSection(context, provider, textTheme),
        const SizedBox(height: 16),

        // 2. Destination Map Picker
        Text(
          'Select Destination',
          style: textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 4),
        Text(
          'Destination must reside within the Gandhinagar service region.',
          style: textTheme.bodySmall?.copyWith(color: AppColors.textSecondary),
        ),
        const SizedBox(height: 10),
        DestinationMapPicker(
          selectedPickupPoint: provider.selectedPickupPoint,
          serviceRegions: provider.serviceRegions,
          passengerLocation: provider.passengerLocation,
          selectedDestination: provider.selectedDestination,
          onDestinationSelected: provider.hasPendingSubmission
              ? (_) {}
              : (latLng) {
                  provider.selectDestination(latLng);
                },
        ),

        // Destination validation feedback
        if (provider.isValidatingDestination) ...[
          const SizedBox(height: 8),
          const Row(
            children: [
              SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              SizedBox(width: 8),
              Text(
                'Validating destination with backend...',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
            ],
          ),
        ] else if (provider.destinationError != null) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: AppColors.error.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                const Icon(Icons.error_outline,
                    color: AppColors.error, size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    provider.destinationError!,
                    style: const TextStyle(
                      color: AppColors.error,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ] else if (provider.destinationValidation?.isInsideServiceRegion ==
            true) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: AppColors.success.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Row(
              children: [
                Icon(Icons.check_circle, color: AppColors.success, size: 16),
                SizedBox(width: 6),
                Text(
                  'Valid destination inside Gandhinagar Service Region',
                  style: TextStyle(
                    color: AppColors.success,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ],

        const SizedBox(height: 16),

        // 3. Fare Quote Generation / Display
        if (provider.canRequestQuote && provider.fareQuote == null) ...[
          FilledButton.tonalIcon(
            key: const Key('get_fare_quote_button'),
            onPressed:
                provider.isLoadingQuote ? null : () => provider.requestFareQuote(),
            icon: provider.isLoadingQuote
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.calculate_outlined),
            label: const Text('Get Fare Quote'),
          ),
        ] else if (provider.selectedDestination != null &&
            provider.destinationValidation?.isInsideServiceRegion == true &&
            provider.fareQuote == null &&
            !provider.hasPendingSubmission) ...[
          Container(
            key: const Key('pickup_location_guidance_banner'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.warning.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.warning),
            ),
            child: Row(
              children: [
                const Icon(Icons.info_outline, color: AppColors.warning, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    provider.passengerLocation == null
                        ? 'Actual GPS coordinates are required to verify you are within 150m of the pickup hub before requesting a quote. Tap Update GPS to grant location.'
                        : provider.pickupValidation?.isValid != true
                            ? 'Your current GPS position is outside the 150m pickup geofence. Please move closer to ${provider.selectedPickupPoint?.name ?? 'the pickup hub'} and tap Update GPS.'
                            : 'Validating pickup proximity...',
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],

        if (provider.isLoadingQuote) ...[
          const SizedBox(height: 12),
          const Center(child: CircularProgressIndicator()),
        ],

        if (provider.quoteError != null) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: AppColors.error.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              provider.quoteError!,
              style: const TextStyle(color: AppColors.error, fontSize: 12),
            ),
          ),
        ],

        if (provider.fareQuote != null) ...[
          const SizedBox(height: 8),
          FareQuoteCard(
            fareQuote: provider.fareQuote!,
            remainingDuration: provider.remainingQuoteDuration,
            isExpired: provider.isQuoteExpired,
            isRefreshing: provider.isLoadingQuote,
            onRefreshQuote: () => provider.requestFareQuote(),
          ),
          const SizedBox(height: 16),

          // 4. Ride Mode Configuration: SHARED vs PRIVATE
          Text(
            'Ride Mode',
            style:
                textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            key: const Key('ride_type_segmented_button'),
            segments: const [
              ButtonSegment<String>(
                value: 'SHARED',
                label: Text('Shared Ride'),
                icon: Icon(Icons.group_outlined),
              ),
              ButtonSegment<String>(
                value: 'PRIVATE',
                label: Text('Private Ride'),
                icon: Icon(Icons.person_outline),
              ),
            ],
            selected: {provider.requestedType},
            onSelectionChanged: provider.hasPendingSubmission
                ? null
                : (newSelection) {
                    provider.setRequestedType(newSelection.first);
                  },
          ),
          const SizedBox(height: 12),

          // Minimum Group Preference (if SHARED)
          if (provider.requestedType == 'SHARED') ...[
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Minimum Group Size Preference',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      'Match with 2 to 4 passengers for lower shared fare',
                      style: textTheme.bodySmall?.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
                DropdownButton<int>(
                  key: const Key('group_preference_dropdown'),
                  value: provider.minGroupPreference,
                  items: const [
                    DropdownMenuItem(value: 2, child: Text('2 Riders')),
                    DropdownMenuItem(value: 3, child: Text('3 Riders')),
                    DropdownMenuItem(value: 4, child: Text('4 Riders')),
                  ],
                  onChanged: provider.hasPendingSubmission
                      ? null
                      : (val) {
                          if (val != null) {
                            provider.setMinGroupPreference(val);
                          }
                        },
                ),
              ],
            ),
            const SizedBox(height: 12),
          ],

          // 5. Mandatory Upfront Consent Checkbox
          CheckboxListTile(
            key: const Key('upfront_consent_checkbox'),
            contentPadding: EdgeInsets.zero,
            value: provider.upfrontConsentAgreed,
            onChanged: provider.hasPendingSubmission
                ? null
                : (val) {
                    provider.setUpfrontConsentAgreed(val ?? false);
                  },
            title: const Text(
              'I give upfront consent to automatic grouping (up to 4 passengers), maximum 25% individual detour, and agreed fare ceiling capping.',
              style: TextStyle(fontSize: 12),
            ),
            controlAffinity: ListTileControlAffinity.leading,
          ),

          if (provider.hasPendingSubmission) ...[
            const SizedBox(height: 12),
            Container(
              key: const Key('pending_retry_banner'),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.warning.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.warning),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(
                    children: [
                      Icon(Icons.sync_problem,
                          color: AppColors.warning, size: 20),
                      SizedBox(width: 8),
                      Text(
                        'Submission Pending Verification',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          color: AppColors.warning,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Your ride request was submitted, but confirmation was interrupted by a connection failure. Tap Retry to resubmit with the exact same request, or Check Status to verify if the server registered your ride.',
                    style: TextStyle(fontSize: 12),
                  ),
                  const SizedBox(height: 8),
                  TextButton.icon(
                    key: const Key('reconcile_status_button'),
                    onPressed: provider.isReconciling ||
                            provider.isSubmittingBooking
                        ? null
                        : () => provider.reconcilePendingSubmission(),
                    icon: provider.isReconciling
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.search, size: 16),
                    label: const Text('Check Booking Status'),
                  ),
                ],
              ),
            ),
          ],

          // Submission Error
          if (provider.submissionError != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.error.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                provider.submissionError!,
                key: const Key('booking_submission_error_banner'),
                style: const TextStyle(
                  color: AppColors.error,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],

          const SizedBox(height: 16),

          // 6. Submit Booking Button
          FilledButton(
            key: const Key('confirm_booking_button'),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 14),
            ),
            onPressed: provider.canSubmitBooking
                ? () => provider.submitBooking()
                : null,
            child: provider.isSubmittingBooking
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      color: Colors.white,
                      strokeWidth: 2,
                    ),
                  )
                : Text(
                    provider.hasPendingSubmission
                        ? 'Retry Booking Submission'
                        : 'Confirm ${provider.requestedType == 'SHARED' ? 'Shared' : 'Private'} Booking',
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
          ),
          const SizedBox(height: 24),
        ],
      ],
    );
  }

  Widget _buildPickupSection(
    BuildContext context,
    BookingFlowProvider provider,
    TextTheme textTheme,
  ) {
    final pickup = provider.selectedPickupPoint;
    final validation = provider.pickupValidation;

    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: AppColors.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.hub_outlined,
                  color: AppColors.success,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Text(
                  'Pickup Hub (150m Campus Geofence)',
                  style: textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            if (provider.pickupPoints.isNotEmpty) ...[
              DropdownButtonFormField<String>(
                key: const Key('pickup_point_dropdown'),
                initialValue: pickup?.id,
                decoration: const InputDecoration(
                  labelText: 'Selected Transit Hub',
                  border: OutlineInputBorder(),
                  contentPadding:
                      EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
                items: provider.pickupPoints.map((p) {
                  return DropdownMenuItem<String>(
                    value: p.id,
                    child: Text(
                      '${p.name} (r=${p.radiusMeters.toInt()}m)',
                      overflow: TextOverflow.ellipsis,
                    ),
                  );
                }).toList(),
                onChanged: provider.hasPendingSubmission
                    ? null
                    : (val) {
                        if (val != null) {
                          final match = provider.pickupPoints
                              .firstWhere((p) => p.id == val);
                          provider.selectPickupPoint(match);
                        }
                      },
              ),
            ],
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Row(
                    children: [
                      Icon(
                        validation?.isValid == true
                            ? Icons.check_circle_outline
                            : (provider.passengerLocation == null
                                ? Icons.location_off_outlined
                                : Icons.location_searching),
                        size: 16,
                        color: validation?.isValid == true
                            ? AppColors.success
                            : (provider.passengerLocation == null ||
                                    validation?.isValid == false ||
                                    provider.pickupValidationError != null
                                ? AppColors.error
                                : AppColors.textSecondary),
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          provider.isAcquiringLocation
                              ? 'Acquiring GPS location...'
                              : provider.isValidatingPickup
                                  ? 'Validating geofence...'
                                  : provider.passengerLocation == null
                                      ? 'Location unavailable (GPS required)'
                                      : validation != null
                                          ? (validation.isValid
                                              ? 'Within geofence (~${validation.distanceMeters.toInt()}m)'
                                              : 'Distance: ${validation.distanceMeters.toInt()}m (exceeds 150m)')
                                          : provider.pickupValidationError != null
                                              ? 'Geofence validation error'
                                              : 'Proximity: unverified',
                          style: TextStyle(
                            fontSize: 11,
                            color: validation?.isValid == true
                                ? AppColors.success
                                : (provider.passengerLocation == null ||
                                        validation?.isValid == false ||
                                        provider.pickupValidationError != null
                                    ? AppColors.error
                                    : AppColors.textSecondary),
                            fontWeight: validation?.isValid == false ||
                                    provider.passengerLocation == null ||
                                    provider.pickupValidationError != null
                                ? FontWeight.bold
                                : FontWeight.normal,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                TextButton.icon(
                  key: const Key('refresh_location_button'),
                  onPressed: provider.isAcquiringLocation ||
                          provider.isValidatingPickup
                      ? null
                      : () => provider.refreshPassengerLocation(),
                  icon: provider.isAcquiringLocation ||
                          provider.isValidatingPickup
                      ? const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.my_location, size: 14),
                  label: const Text('Update GPS', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            if (provider.locationErrorMessage != null) ...[
              const SizedBox(height: 6),
              Container(
                key: const Key('location_error_banner'),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.error_outline,
                        size: 14, color: AppColors.error),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        provider.locationErrorMessage!,
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.error),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            if (provider.pickupValidationError != null) ...[
              const SizedBox(height: 6),
              Container(
                key: const Key('pickup_validation_error_banner'),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.error_outline,
                        size: 14, color: AppColors.error),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        provider.pickupValidationError!,
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.error),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.label,
    required this.value,
    this.valueKey,
    this.valueColor,
  });

  final String label;
  final String value;
  final Key? valueKey;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 13,
            color: AppColors.textSecondary,
          ),
        ),
        Text(
          value,
          key: valueKey,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.bold,
            color: valueColor ?? AppColors.textPrimary,
          ),
        ),
      ],
    );
  }
}
