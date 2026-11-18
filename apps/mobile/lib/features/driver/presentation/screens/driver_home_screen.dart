import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../app/state/app_mode_provider.dart';
import '../../../../core/config/app_config.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/widgets/mode_badge.dart';
import '../../../../core/widgets/placeholder_section_card.dart';
import '../../state/driver_home_provider.dart';

/// Basic Driver Home placeholder screen established by TASK-002.
class DriverHomeScreen extends StatelessWidget {
  const DriverHomeScreen({super.key});

  IconData _iconForSection(String id) {
    switch (id) {
      case 'onboarding':
        return Icons.verified_user_outlined;
      case 'dispatch':
        return Icons.notifications_active_outlined;
      case 'active_trip':
        return Icons.assignment_outlined;
      default:
        return Icons.widgets_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final driverProvider = context.watch<DriverHomeProvider>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Driver Home'),
        actions: [
          TextButton.icon(
            key: const Key('switch_mode_button'),
            onPressed: () {
              context.read<AppModeProvider>().clearMode();
              context.go(AppRoutes.roleSelection);
            },
            icon: const Icon(Icons.swap_horiz, size: 18),
            label: const Text('Switch'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Card(
              color: AppColors.driverContainer,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const ModeBadge(mode: AppMode.driver),
                    const SizedBox(height: 12),
                    Text(
                      'Driver Workspace',
                      style: textTheme.titleLarge?.copyWith(
                        color: AppColors.onDriverContainer,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      driverProvider.statusSummary,
                      style: textTheme.bodyMedium?.copyWith(
                        color: AppColors.onDriverContainer,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),
            Text('Planned Driver Modules', style: textTheme.titleMedium),
            const SizedBox(height: 12),
            for (final section in driverProvider.sections) ...[
              PlaceholderSectionCard(
                icon: _iconForSection(section.id),
                title: section.title,
                description: section.description,
                accentColor: AppColors.driverAccent,
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
    );
  }
}
