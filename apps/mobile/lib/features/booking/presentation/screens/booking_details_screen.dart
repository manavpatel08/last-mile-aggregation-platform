import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../core/theme/app_colors.dart';
import '../../models/booking_details.dart';
import '../../models/booking_status_history.dart';
import '../../state/booking_details_provider.dart';

/// Screen displaying complete booking details, chronological status transitions,
/// fare terms, and an idempotent cancellation workflow.
class BookingDetailsScreen extends StatefulWidget {
  const BookingDetailsScreen({
    super.key,
    required this.bookingId,
  });

  final String bookingId;

  @override
  State<BookingDetailsScreen> createState() => _BookingDetailsScreenState();
}

class _BookingDetailsScreenState extends State<BookingDetailsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context
            .read<BookingDetailsProvider>()
            .loadBookingDetails(widget.bookingId);
      }
    });
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'REQUESTED':
      case 'MATCHING':
      case 'MATCHED':
      case 'DISPATCHING':
        return AppColors.warning;
      case 'CONFIRMED':
      case 'DRIVER_ASSIGNED':
      case 'DRIVER_ARRIVED':
      case 'BOARDED':
      case 'IN_PROGRESS':
        return AppColors.success;
      case 'CANCELLED':
      case 'ABORTED':
        return AppColors.error;
      case 'COMPLETED':
        return AppColors.primary;
      default:
        return AppColors.textSecondary;
    }
  }

  String _formatCoordinates(double? lat, double? lng) {
    if (lat == null || lng == null) return 'Not available';
    final latDir = lat >= 0 ? 'N' : 'S';
    final lngDir = lng >= 0 ? 'E' : 'W';
    return '${lat.abs().toStringAsFixed(4)}° $latDir, ${lng.abs().toStringAsFixed(4)}° $lngDir';
  }

  String _formatDateTime(DateTime? dt) {
    if (dt == null) return 'N/A';
    return dt.toLocal().toString().split('.').first;
  }

  void _showCancellationDialog(
    BuildContext context,
    BookingDetails booking,
    BookingDetailsProvider provider,
  ) {
    final reasonController = TextEditingController();

    showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return AlertDialog(
          title: const Text('Cancel Booking?'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: booking.isAfterDriverAssignment
                        ? AppColors.error.withValues(alpha: 0.1)
                        : AppColors.success.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: booking.isAfterDriverAssignment
                          ? AppColors.error.withValues(alpha: 0.3)
                          : AppColors.success.withValues(alpha: 0.3),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        booking.isAfterDriverAssignment
                            ? 'Late Cancellation Fee: ₹30.00'
                            : 'Free Cancellation: ₹0.00',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          color: booking.isAfterDriverAssignment
                              ? AppColors.error
                              : AppColors.success,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        booking.isAfterDriverAssignment
                            ? 'A driver has been assigned. Late cancellations assess a fixed ₹30 fee collected on your next ride.'
                            : 'No driver assigned yet. You can cancel now with zero fee.',
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.textSecondary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Note: The server evaluates the exact lifecycle stage at request time and determines the authoritative fee.',
                        style: TextStyle(
                          fontSize: 11,
                          fontStyle: FontStyle.italic,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  'Cancellation Reason (optional, max 500 characters):',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 6),
                TextField(
                  key: const Key('cancellation_reason_input'),
                  controller: reasonController,
                  maxLines: 3,
                  maxLength: 500,
                  decoration: const InputDecoration(
                    hintText: 'e.g. Plans changed, booked by mistake...',
                    border: OutlineInputBorder(),
                    contentPadding: EdgeInsets.all(10),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Keep Ride'),
            ),
            FilledButton(
              key: const Key('confirm_cancellation_button'),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.error,
              ),
              onPressed: () {
                final reason = reasonController.text.trim();
                Navigator.of(dialogContext).pop();
                provider.cancelBooking(
                  reason: reason.isNotEmpty ? reason : null,
                );
              },
              child: const Text('Confirm Cancellation'),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final provider = context.watch<BookingDetailsProvider>();
    final booking = provider.bookingDetails;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Booking Details'),
        actions: [
          IconButton(
            key: const Key('refresh_booking_details_button'),
            icon: provider.isRefreshing
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh),
            onPressed: provider.isRefreshing
                ? null
                : () => provider.refreshBookingDetails(),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: Builder(
        builder: (context) {
          if (provider.isLoading && booking == null) {
            return const Center(
              child: CircularProgressIndicator(
                key: Key('booking_details_loading'),
              ),
            );
          }

          if (provider.error != null && booking == null) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.error_outline,
                      size: 48,
                      color: AppColors.error,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      provider.error!,
                      key: const Key('booking_details_error_text'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: AppColors.error),
                    ),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      key: const Key('booking_details_retry_button'),
                      onPressed: () =>
                          provider.loadBookingDetails(widget.bookingId),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            );
          }

          if (booking == null) {
            return const Center(
              child: Text('No booking details found.'),
            );
          }

          final statusColor = _statusColor(booking.status);

          return RefreshIndicator(
            onRefresh: () => provider.refreshBookingDetails(),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // Cancellation State Banner (Ambiguous, Reconciling, or Retry-Eligible)
                if (provider.cancellationState ==
                    CancellationAttemptState.reconciliationRequired) ...[
                  Container(
                    key: const Key('pending_cancellation_banner'),
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: AppColors.warning.withValues(alpha: 0.5),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(
                              Icons.warning_amber_rounded,
                              color: AppColors.warning,
                              size: 20,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Cancellation Status Unconfirmed',
                              style: textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.bold,
                                color: AppColors.warning,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Your cancellation request was sent, but the response was interrupted. Please check booking status before retrying.',
                          style: TextStyle(
                            fontSize: 12,
                            color: AppColors.textSecondary,
                          ),
                        ),
                        const SizedBox(height: 10),
                        OutlinedButton.icon(
                          key: const Key('check_cancellation_status_button'),
                          onPressed: provider.isCancelling
                              ? null
                              : () => provider.reconcileCancellation(),
                          icon: const Icon(Icons.sync, size: 16),
                          label: const Text('Check Booking Status'),
                          style: OutlinedButton.styleFrom(
                            visualDensity: VisualDensity.compact,
                          ),
                        ),
                      ],
                    ),
                  ),
                ] else if (provider.cancellationState ==
                    CancellationAttemptState.retryEligible) ...[
                  Container(
                    key: const Key('pending_cancellation_banner'),
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: AppColors.warning.withValues(alpha: 0.5),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(
                              Icons.info_outline,
                              color: AppColors.warning,
                              size: 20,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Ready to Retry Cancellation',
                              style: textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.bold,
                                color: AppColors.warning,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Server confirmed booking is still ${booking.status}. You may safely retry cancellation using the original request.',
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppColors.textSecondary,
                          ),
                        ),
                        const SizedBox(height: 10),
                        Row(
                          children: [
                            FilledButton.icon(
                              key: const Key('retry_cancellation_button'),
                              onPressed: provider.isCancelling
                                  ? null
                                  : () => provider.retryCancellation(),
                              icon: const Icon(Icons.replay, size: 16),
                              label: const Text('Retry Cancellation'),
                              style: FilledButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                              ),
                            ),
                            const SizedBox(width: 8),
                            OutlinedButton.icon(
                              key: const Key('check_cancellation_status_button'),
                              onPressed: provider.isCancelling
                                  ? null
                                  : () => provider.reconcileCancellation(),
                              icon: const Icon(Icons.sync, size: 16),
                              label: const Text('Check Status'),
                              style: OutlinedButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ] else if (provider.cancellationState ==
                    CancellationAttemptState.cancellationBlocked) ...[
                  Container(
                    key: const Key('cancellation_blocked_banner'),
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.error.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: AppColors.error.withValues(alpha: 0.3),
                      ),
                    ),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.block,
                          color: AppColors.error,
                          size: 20,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Booking has transitioned to ${booking.status} and can no longer be cancelled.',
                            style: const TextStyle(
                              fontSize: 12,
                              color: AppColors.error,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                // Cancellation Error Banner
                if (provider.cancellationError != null) ...[
                  Container(
                    key: const Key('cancellation_error_banner'),
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.error.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: AppColors.error.withValues(alpha: 0.3),
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
                            provider.cancellationError!,
                            key: const Key('cancellation_error_text'),
                            style: const TextStyle(
                              fontSize: 12,
                              color: AppColors.error,
                            ),
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, size: 16),
                          onPressed: () => provider.clearCancellationError(),
                          visualDensity: VisualDensity.compact,
                        ),
                      ],
                    ),
                  ),
                ],

                // Overall Outstanding Fees Notification
                if (provider.outstandingFees?.hasOutstandingFees == true) ...[
                  Container(
                    key: const Key('outstanding_fees_notice'),
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.error.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: AppColors.error.withValues(alpha: 0.25),
                      ),
                    ),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.account_balance_wallet_outlined,
                          color: AppColors.error,
                          size: 20,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Passenger Outstanding Balance: ₹${provider.outstandingFees!.totalOutstandingInRupeesFormatted}',
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 12,
                                  color: AppColors.error,
                                ),
                              ),
                              const SizedBox(height: 2),
                              const Text(
                                'Surcharged in cash upon completion of your subsequent ride.',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                // Primary Booking Info Card
                Card(
                  key: const Key('booking_details_primary_card'),
                  elevation: 0,
                  color: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(
                      color: statusColor.withValues(alpha: 0.4),
                      width: 1.5,
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Status',
                              style: textTheme.titleSmall?.copyWith(
                                color: AppColors.textSecondary,
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: statusColor.withValues(alpha: 0.15),
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Text(
                                booking.status,
                                key: const Key('booking_details_status_badge'),
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                  color: statusColor,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        const Divider(),
                        const SizedBox(height: 8),

                        _buildDetailRow(
                          'Booking ID',
                          booking.bookingId,
                          key: const Key('booking_details_id_text'),
                          isMonospace: true,
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Pickup Hub',
                          booking.pickupPointName ?? 'PDEU Hub',
                          key: const Key('booking_details_pickup_hub_text'),
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Pickup Coordinates',
                          _formatCoordinates(
                            booking.passengerPickupLocation?.latitude,
                            booking.passengerPickupLocation?.longitude,
                          ),
                          key: const Key('booking_details_pickup_coords_text'),
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Destination Coordinates',
                          _formatCoordinates(
                            booking.destinationLocation?.latitude,
                            booking.destinationLocation?.longitude,
                          ),
                          key: const Key('booking_details_dest_coords_text'),
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Ride Type',
                          booking.requestedType ?? 'SHARED',
                          key: const Key('booking_details_ride_type_text'),
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Group Preference',
                          booking.minGroupPreference != null
                              ? 'Min ${booking.minGroupPreference} passengers'
                              : 'Standard (2+)',
                          key: const Key('booking_details_group_pref_text'),
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Agreed Fare Ceiling',
                          '₹${booking.agreedFareCeiling}',
                          key: const Key('booking_details_ceiling_text'),
                          highlightColor: AppColors.primary,
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Final Allocated Fare',
                          booking.finalAllocatedFareInRupees != null
                              ? '₹${booking.finalAllocatedFareInRupees}'
                              : 'Pending completion',
                          key: const Key('booking_details_final_fare_text'),
                          highlightColor:
                              booking.finalAllocatedFareInRupees != null
                                  ? AppColors.success
                                  : null,
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Wait Deadline',
                          _formatDateTime(booking.maxWaitDeadline),
                          key: const Key('booking_details_deadline_text'),
                        ),
                        const SizedBox(height: 8),
                        _buildDetailRow(
                          'Created At',
                          _formatDateTime(booking.createdAt),
                          key: const Key('booking_details_created_at_text'),
                        ),

                        // Cancellation info if cancelled
                        if (booking.status == 'CANCELLED') ...[
                          const SizedBox(height: 8),
                          const Divider(),
                          const SizedBox(height: 8),
                          _buildDetailRow(
                            'Cancelled At',
                            booking.cancelledAt != null
                                ? _formatDateTime(booking.cancelledAt)
                                : 'Confirmation recorded',
                            key: const Key('booking_details_cancelled_at_text'),
                          ),
                          const SizedBox(height: 8),
                          _buildDetailRow(
                            'Cancellation Reason',
                            booking.cancellationReason ?? 'Passenger cancelled',
                            key: const Key(
                                'booking_details_cancellation_reason_text'),
                          ),
                          const SizedBox(height: 8),

                          // Assessed Fee Display
                          if (provider.cancellationResult != null) ...[
                            _buildDetailRow(
                              'Assessed Cancellation Fee',
                              '₹${provider.cancellationResult!.feeInRupeesFormatted} (${provider.cancellationResult!.cancellationFeeStatus})',
                              key: const Key('booking_details_assessed_fee_text'),
                              highlightColor: provider.cancellationResult!.hasFee
                                  ? AppColors.error
                                  : AppColors.success,
                            ),
                          ] else if (provider.recoveredAssessedFee != null) ...[
                            _buildDetailRow(
                              'Assessed Cancellation Fee',
                              '₹${provider.recoveredAssessedFee!.amountInRupeesFormatted} (OUTSTANDING)',
                              key: const Key('booking_details_assessed_fee_text'),
                              highlightColor: AppColors.error,
                            ),
                          ] else if (provider.isAssessedFeeUnavailable) ...[
                            _buildDetailRow(
                              'Assessed Cancellation Fee',
                              'Unavailable from ledger',
                              key: const Key('booking_details_assessed_fee_text'),
                              highlightColor: AppColors.textSecondary,
                            ),
                          ],
                        ],
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 20),

                // Status Transition History Section
                Card(
                  key: const Key('status_history_card'),
                  elevation: 0,
                  color: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: const BorderSide(color: AppColors.border),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(
                              Icons.history,
                              size: 18,
                              color: AppColors.primary,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Lifecycle Transition History',
                              style: textTheme.titleSmall?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        if (booking.sortedStatusHistory.isEmpty)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 8),
                            child: Text(
                              'No status transitions recorded.',
                              style: TextStyle(
                                fontSize: 12,
                                color: AppColors.textSecondary,
                              ),
                            ),
                          )
                        else
                          ListView.separated(
                            shrinkWrap: true,
                            physics: const NeverScrollableScrollPhysics(),
                            itemCount: booking.sortedStatusHistory.length,
                            separatorBuilder: (_, _) =>
                                const Divider(height: 16),
                            itemBuilder: (context, index) {
                              final item = booking.sortedStatusHistory[index];
                              return _buildHistoryItem(item, index);
                            },
                          ),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 24),

                // Active Trip Navigation (if assigned, arrived, boarded, or in progress)
                if (const [
                  'DRIVER_ASSIGNED',
                  'DRIVER_ARRIVED',
                  'BOARDED',
                  'IN_PROGRESS',
                ].contains(booking.status)) ...[
                  FilledButton.icon(
                    key: const Key('booking_details_view_trip_button'),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    onPressed: () {
                      context.push(
                        AppRoutes.passengerActiveTripPath(widget.bookingId),
                      );
                    },
                    icon: const Icon(Icons.confirmation_number_outlined),
                    label: const Text(
                      'View Boarding Pass & Trip',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],

                // Action Button: Cancel Booking (if cancellable and not blocked/reconciling)
                if (booking.isCancellable && provider.canCancel) ...[
                  FilledButton.icon(
                    key: const Key('cancel_booking_button'),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.error,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    onPressed: provider.isCancelling
                        ? null
                        : () => _showCancellationDialog(
                              context,
                              booking,
                              provider,
                            ),
                    icon: provider.isCancelling
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.cancel_outlined),
                    label: Text(
                      booking.isAfterDriverAssignment
                          ? 'Cancel Ride (₹30 Fee)'
                          : 'Cancel Ride (Free)',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildDetailRow(
    String label,
    String value, {
    Key? key,
    bool isMonospace = false,
    Color? highlightColor,
  }) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            value,
            key: key,
            textAlign: TextAlign.right,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              fontFamily: isMonospace ? 'monospace' : null,
              color: highlightColor,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildHistoryItem(BookingStatusHistoryItem item, int index) {
    return Column(
      key: Key('status_history_item_$index'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              children: [
                if (item.previousStatus != null &&
                    item.previousStatus!.isNotEmpty) ...[
                  Text(
                    item.previousStatus!,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4),
                    child: Icon(
                      Icons.arrow_forward,
                      size: 12,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
                Text(
                  item.newStatus,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: _statusColor(item.newStatus),
                  ),
                ),
              ],
            ),
            Text(
              _formatDateTime(item.transitionTime),
              style: const TextStyle(
                fontSize: 11,
                color: AppColors.textSecondary,
              ),
            ),
          ],
        ),
        if (item.reason != null && item.reason!.isNotEmpty) ...[
          const SizedBox(height: 2),
          Text(
            item.reason!,
            style: const TextStyle(
              fontSize: 11,
              fontStyle: FontStyle.italic,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ],
    );
  }
}
