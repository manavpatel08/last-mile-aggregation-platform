import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../app/state/app_mode_provider.dart';
import '../../../../core/config/app_config.dart';
import '../../../../core/theme/app_colors.dart';

/// Entry point allowing the user to select the Passenger or Driver UI mode.
///
/// Mode selection controls UI navigation only; role authorization and driver
/// verification status are enforced strictly by the backend (`AGENTS.md` §1.3).
class RoleSelectionScreen extends StatelessWidget {
  const RoleSelectionScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final config = context.read<AppConfig>();

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 28),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 48,
                        height: 48,
                        decoration: BoxDecoration(
                          color: AppColors.primary,
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: const Icon(
                          Icons.electric_rickshaw_outlined,
                          color: AppColors.onPrimary,
                          size: 28,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('LastMile', style: textTheme.headlineMedium),
                            Text(
                              'Shared Micro-Mobility Platform',
                              style: textTheme.bodyMedium,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 28),
                  Text('Choose an interface mode', style: textTheme.titleLarge),
                  const SizedBox(height: 8),
                  Text(
                    'Select the experience you want to open. Both Passenger and Driver workflows share this mobile application.',
                    style: textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 20),
                  _RoleEntryCard(
                    key: const Key('role_card_passenger'),
                    icon: Icons.commute_outlined,
                    title: 'Passenger Mode',
                    subtitle:
                        'Open the commuter interface placeholder for shared and private campus last-mile rides.',
                    buttonLabel: 'Continue as Passenger',
                    accentColor: AppColors.primary,
                    onPressed: () {
                      context.read<AppModeProvider>().selectMode(
                        AppMode.passenger,
                      );
                      context.go(AppRoutes.passengerHome);
                    },
                  ),
                  const SizedBox(height: 16),
                  _RoleEntryCard(
                    key: const Key('role_card_driver'),
                    icon: Icons.directions_car_outlined,
                    title: 'Driver Mode',
                    subtitle:
                        'Open the driver interface placeholder for availability, dispatch offers, and trip workflows.',
                    buttonLabel: 'Continue as Driver',
                    accentColor: AppColors.driverAccent,
                    onPressed: () {
                      context.read<AppModeProvider>().selectMode(
                        AppMode.driver,
                      );
                      context.go(AppRoutes.driverHome);
                    },
                  ),
                  const SizedBox(height: 24),
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceCard,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(
                          Icons.shield_outlined,
                          size: 20,
                          color: AppColors.textSecondary,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            'UI mode selection is not an authorization boundary. Account authentication, RBAC, and driver verification are enforced by the backend.',
                            style: textTheme.bodySmall,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'Environment: ${config.appEnv}',
                    textAlign: TextAlign.center,
                    style: textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RoleEntryCard extends StatelessWidget {
  const _RoleEntryCard({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.buttonLabel,
    required this.accentColor,
    required this.onPressed,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final String buttonLabel;
  final Color accentColor;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: accentColor.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(icon, color: accentColor),
                ),
                const SizedBox(width: 12),
                Expanded(child: Text(title, style: textTheme.titleMedium)),
              ],
            ),
            const SizedBox(height: 10),
            Text(subtitle, style: textTheme.bodyMedium),
            const SizedBox(height: 16),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: accentColor),
              onPressed: onPressed,
              child: Text(buttonLabel),
            ),
          ],
        ),
      ),
    );
  }
}
