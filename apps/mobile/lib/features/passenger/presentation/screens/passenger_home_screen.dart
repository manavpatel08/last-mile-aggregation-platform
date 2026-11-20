import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../app/state/app_mode_provider.dart';
import '../../../../core/config/app_config.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/widgets/mode_badge.dart';
import '../../../../core/widgets/placeholder_section_card.dart';
import '../../../auth/state/auth_provider.dart';
import '../../state/passenger_home_provider.dart';

/// Basic Passenger Home placeholder screen established by TASK-002 and updated for TASK-003.
class PassengerHomeScreen extends StatelessWidget {
  const PassengerHomeScreen({super.key});

  IconData _iconForSection(String id) {
    switch (id) {
      case 'booking':
        return Icons.route_outlined;
      case 'active_ride':
        return Icons.directions_transit_outlined;
      case 'history':
        return Icons.receipt_long_outlined;
      default:
        return Icons.widgets_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final passengerProvider = context.watch<PassengerHomeProvider>();
    final authProvider = context.watch<AuthProvider>();
    final user = authProvider.user;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Passenger Home'),
        actions: [
          if (user?.isDualRole == true) ...[
            TextButton.icon(
              key: const Key('switch_mode_button'),
              onPressed: () {
                context.read<AppModeProvider>().clearMode();
                context.go(AppRoutes.roleSelection);
              },
              icon: const Icon(Icons.swap_horiz, size: 18),
              label: const Text('Switch'),
            ),
            const SizedBox(width: 4),
          ],
          IconButton(
            key: const Key('logout_button'),
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: () => context.read<AuthProvider>().logout(),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Card(
              color: AppColors.primaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const ModeBadge(mode: AppMode.passenger),
                        if (user != null)
                          Text(
                            user.fullName.isNotEmpty
                                ? user.fullName
                                : user.email,
                            style: textTheme.bodySmall?.copyWith(
                              color: AppColors.onPrimaryContainer,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Passenger Workspace',
                      style: textTheme.titleLarge?.copyWith(
                        color: AppColors.onPrimaryContainer,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      passengerProvider.statusSummary,
                      style: textTheme.bodyMedium?.copyWith(
                        color: AppColors.onPrimaryContainer,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (user?.driverProfile == null) ...[
              const SizedBox(height: 16),
              Card(
                elevation: 0,
                color: AppColors.driverContainer.withValues(alpha: 0.6),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                  side: BorderSide(
                    color: AppColors.driverAccent.withValues(alpha: 0.3),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AppColors.driverAccent.withValues(alpha: 0.15),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.drive_eta_outlined,
                          color: AppColors.driverAccent,
                          size: 28,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Become a Driver',
                              style: textTheme.titleMedium?.copyWith(
                                fontWeight: FontWeight.bold,
                                color: AppColors.onDriverContainer,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Register your vehicle and start earning with campus rides.',
                              style: textTheme.bodySmall?.copyWith(
                                color: AppColors.onDriverContainer,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        key: const Key('become_driver_button'),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.driverAccent,
                          foregroundColor: Colors.white,
                        ),
                        onPressed: () {
                          context.push(AppRoutes.driverOnboarding);
                        },
                        child: const Text('Apply'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            const SizedBox(height: 20),
            Text('Planned Passenger Modules', style: textTheme.titleMedium),
            const SizedBox(height: 12),
            for (final section in passengerProvider.sections) ...[
              PlaceholderSectionCard(
                icon: _iconForSection(section.id),
                title: section.title,
                description: section.description,
                accentColor: AppColors.primary,
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
    );
  }
}
