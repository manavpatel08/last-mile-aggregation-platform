import 'package:material_ui/material_ui.dart';

import '../config/app_config.dart';
import '../theme/app_colors.dart';

/// Displays the currently selected client UI mode.
class ModeBadge extends StatelessWidget {
  const ModeBadge({super.key, required this.mode});

  final AppMode mode;

  @override
  Widget build(BuildContext context) {
    final bool isDriver = mode == AppMode.driver;
    final Color foregroundColor = isDriver
        ? AppColors.onDriverContainer
        : AppColors.onPrimaryContainer;
    final IconData icon = isDriver
        ? Icons.directions_car_outlined
        : Icons.commute_outlined;
    final String label = isDriver ? 'Driver UI' : 'Passenger UI';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: foregroundColor.withValues(alpha: 0.25)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: foregroundColor),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: foregroundColor,
            ),
          ),
        ],
      ),
    );
  }
}
