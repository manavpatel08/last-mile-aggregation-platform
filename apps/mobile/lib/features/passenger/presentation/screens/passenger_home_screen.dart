import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../app/state/app_mode_provider.dart';
import '../../../../core/config/app_config.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/widgets/mode_badge.dart';
import '../../../../core/widgets/placeholder_section_card.dart';
import '../../state/passenger_home_provider.dart';

/// Basic Passenger Home placeholder screen established by TASK-002.
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

    return Scaffold(
      appBar: AppBar(
        title: const Text('Passenger Home'),
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
              color: AppColors.primaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const ModeBadge(mode: AppMode.passenger),
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
