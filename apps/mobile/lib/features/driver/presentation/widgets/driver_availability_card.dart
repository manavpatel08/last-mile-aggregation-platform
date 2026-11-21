import 'package:material_ui/material_ui.dart';

import '../../../../core/theme/app_colors.dart';

/// Presentation card displaying the driver availability (duty toggle) section.
///
/// In Phase 2, this is integrated with `PATCH /api/v1/drivers/status`.
/// When [onChanged] is provided and the driver is approved, the switch is interactive.
/// When [onChanged] is null or [isLoading] is true, the switch is disabled.
class DriverAvailabilityCard extends StatelessWidget {
  const DriverAvailabilityCard({
    super.key,
    this.isOnline,
    this.isLoading = false,
    this.onChanged,
  });

  /// Authoritative server online state (null if status is unavailable).
  final bool? isOnline;

  /// Whether an operational status mutation is currently in flight.
  final bool isLoading;

  /// Callback when driver toggles availability. Null if disabled or unapproved.
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    final String statusBadgeLabel;
    final Color badgeBg;
    final Color badgeFg;

    if (onChanged != null) {
      if (isOnline == true) {
        statusBadgeLabel = 'Online (Active)';
        badgeBg = AppColors.success.withValues(alpha: 0.15);
        badgeFg = AppColors.success;
      } else if (isOnline == false) {
        statusBadgeLabel = 'Offline (Inactive)';
        badgeBg = AppColors.textSecondary.withValues(alpha: 0.12);
        badgeFg = AppColors.textSecondary;
      } else {
        statusBadgeLabel = 'Status unavailable';
        badgeBg = AppColors.textSecondary.withValues(alpha: 0.12);
        badgeFg = AppColors.textSecondary;
      }
    } else {
      if (isOnline == true) {
        statusBadgeLabel = 'Online (Disabled)';
        badgeBg = AppColors.textSecondary.withValues(alpha: 0.12);
        badgeFg = AppColors.textSecondary;
      } else if (isOnline == false) {
        statusBadgeLabel = 'Offline (Disabled)';
        badgeBg = AppColors.textSecondary.withValues(alpha: 0.12);
        badgeFg = AppColors.textSecondary;
      } else {
        statusBadgeLabel = 'Status unavailable';
        badgeBg = AppColors.textSecondary.withValues(alpha: 0.12);
        badgeFg = AppColors.textSecondary;
      }
    }

    final String explanationText;
    if (onChanged != null) {
      if (isOnline == true) {
        explanationText =
            'You are online and eligible to receive sequential dispatch offers. Switch off when ending your shift.';
      } else {
        explanationText =
            'You are currently offline. Switch on to start receiving ride group dispatch offers.';
      }
    } else {
      explanationText =
          'Online availability will be enabled once backend dispatch integration is connected. You cannot go online at this time.';
    }

    return Card(
      key: const Key('driver_availability_card'),
      elevation: 0,
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
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: AppColors.secondary.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Icon(
                        Icons.sensors_outlined,
                        color: AppColors.secondary,
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      'Driver Availability',
                      style: textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                Container(
                  key: const Key('driver_availability_status_badge'),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: badgeBg,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (isLoading) ...[
                        const SizedBox(
                          width: 10,
                          height: 10,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AppColors.textSecondary,
                          ),
                        ),
                        const SizedBox(width: 6),
                      ],
                      Text(
                        statusBadgeLabel,
                        style: textTheme.bodySmall?.copyWith(
                          color: badgeFg,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Duty Status',
                        style: textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Go online to receive sequential dispatch offers',
                        style: textTheme.bodySmall?.copyWith(
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Switch(
                  key: const Key('driver_availability_switch'),
                  value: isOnline == true,
                  onChanged: isLoading ? null : onChanged,
                ),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              key: const Key('driver_availability_explanation'),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.secondaryContainer.withValues(alpha: 0.4),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: AppColors.secondary.withValues(alpha: 0.2),
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.info_outline,
                    color: AppColors.secondary,
                    size: 18,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      explanationText,
                      style: textTheme.bodySmall?.copyWith(
                        color: AppColors.textPrimary,
                        height: 1.35,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
