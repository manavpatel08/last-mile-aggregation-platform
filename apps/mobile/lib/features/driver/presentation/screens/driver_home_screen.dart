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
import '../../state/driver_home_provider.dart';

/// Basic Driver Home placeholder screen established by TASK-002 and updated for TASK-003.
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
    final authProvider = context.watch<AuthProvider>();
    final user = authProvider.user;

    final verificationStatus =
        user?.driverProfile?.verificationStatus ??
        user?.driverVerificationStatus ??
        'PENDING';
    final isApproved = verificationStatus == 'APPROVED';

    final Color statusColor;
    final IconData statusIcon;
    final String statusTitle;
    final String statusDescription;

    switch (verificationStatus) {
      case 'PENDING':
        statusColor = AppColors.warning;
        statusIcon = Icons.pending_actions_outlined;
        statusTitle = 'Driver Verification: PENDING';
        statusDescription =
            'Your driver profile is currently under review by campus administrators. In accordance with platform security rules (AGENTS.md §1.3), operational dispatch is disabled until verification is APPROVED.';
      case 'REJECTED':
        statusColor = AppColors.error;
        statusIcon = Icons.cancel_outlined;
        statusTitle = 'Driver Application: REJECTED';
        statusDescription =
            'Your driver application was not approved by campus administrators. Please consult the transport desk to submit updated license or vehicle documentation.';
      case 'SUSPENDED':
        statusColor = AppColors.error;
        statusIcon = Icons.block_outlined;
        statusTitle = 'Driver Account: SUSPENDED';
        statusDescription =
            'Your driver account has been suspended by campus administration. Dispatch offers and active ride duties are disabled.';
      default:
        statusColor = AppColors.warning;
        statusIcon = Icons.warning_amber_outlined;
        statusTitle = 'Driver Status: $verificationStatus';
        statusDescription =
            'Operational dispatch is disabled until your account verification is APPROVED by campus administration.';
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Driver Home'),
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
            if (!isApproved) ...[
              Container(
                margin: const EdgeInsets.only(bottom: 16),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: statusColor.withValues(alpha: 0.4),
                  ),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      statusIcon,
                      color: statusColor,
                      size: 24,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            statusTitle,
                            style: textTheme.titleSmall?.copyWith(
                              color: statusColor,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            statusDescription,
                            style: textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
            Card(
              color: AppColors.driverContainer,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const ModeBadge(mode: AppMode.driver),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 3,
                          ),
                          decoration: BoxDecoration(
                            color: isApproved
                                ? AppColors.success.withValues(alpha: 0.2)
                                : statusColor.withValues(alpha: 0.2),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            verificationStatus,
                            style: textTheme.bodySmall?.copyWith(
                              color: isApproved
                                  ? AppColors.success
                                  : statusColor,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ],
                    ),
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
