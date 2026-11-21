import 'package:material_ui/material_ui.dart';

import '../../../../core/theme/app_colors.dart';

/// Presentation card displaying the driver availability (duty toggle) section.
///
/// In Phase 1, the backend availability endpoint (`PATCH /api/v1/drivers/status`)
/// is not yet implemented. The control is intentionally rendered disabled (`onChanged: null`)
/// with a clear explanatory notice that online availability will be activated once
/// backend dispatch integration (Stage 6) is complete.
class DriverAvailabilityCard extends StatelessWidget {
  const DriverAvailabilityCard({
    super.key,
    this.isOnline,
  });

  /// Authoritative server online state (null if status is unavailable).
  final bool? isOnline;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    final String statusBadgeLabel;
    if (isOnline == true) {
      statusBadgeLabel = 'Online (Disabled)';
    } else if (isOnline == false) {
      statusBadgeLabel = 'Offline (Disabled)';
    } else {
      statusBadgeLabel = 'Status unavailable';
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
                    color: AppColors.textSecondary.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    statusBadgeLabel,
                    style: textTheme.bodySmall?.copyWith(
                      color: AppColors.textSecondary,
                      fontWeight: FontWeight.bold,
                    ),
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
                  // Intentionally null in Phase 1: backend endpoint is not yet connected.
                  onChanged: null,
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
                      'Online availability will be enabled once backend dispatch integration is connected. You cannot go online at this time.',
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
