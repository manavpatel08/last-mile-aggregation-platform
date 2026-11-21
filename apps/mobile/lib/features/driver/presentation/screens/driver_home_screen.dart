import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../app/state/app_mode_provider.dart';
import '../../../../core/config/app_config.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/widgets/mode_badge.dart';
import '../../../auth/state/auth_provider.dart';
import '../../data/driver_repository.dart';
import '../../state/driver_home_provider.dart';
import '../../state/driver_onboarding_provider.dart';
import '../widgets/dispatch_offers_inbox.dart';
import '../widgets/driver_availability_card.dart';

/// Driver Home screen coordinating readiness dashboard, operational status,
/// registered vehicle inspection, role switching, and onboarding state.
class DriverHomeScreen extends StatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  State<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends State<DriverHomeScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _loadDashboard();
      }
    });
  }

  @override
  void deactivate() {
    try {
      context.read<DriverHomeProvider>().stopTrackingOnExitDriverMode();
    } catch (_) {}
    super.deactivate();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (mounted) {
      final provider = context.read<DriverHomeProvider>();
      provider.updateAppLifecycle(state);
      if (state == AppLifecycleState.resumed) {
        DriverRepository? repo;
        try {
          repo = Provider.of<DriverRepository>(context, listen: false);
        } catch (_) {}
        provider.reconcileOnResume(repository: repo);
      }
    }
  }

  void _loadDashboard() {
    final authProvider = context.read<AuthProvider>();
    final user = authProvider.user;
    final verificationStatus = user?.driverProfile?.verificationStatus ??
        user?.driverVerificationStatus ??
        'PENDING';
    DriverRepository? repo;
    try {
      repo = Provider.of<DriverRepository>(context, listen: false);
    } catch (_) {
      // DriverRepository not available in widget tree context
    }
    context.read<DriverHomeProvider>().loadDashboard(
      verificationStatus: verificationStatus,
      userId: user?.id,
      repository: repo,
    );
  }

  Future<void> _handleRefreshApplicationStatus() async {
    final onboardingProvider = context.read<DriverOnboardingProvider>();
    final authProvider = context.read<AuthProvider>();
    final success = await onboardingProvider.retryProfileSync(
      authProvider: authProvider,
    );
    if (!mounted) return;
    if (success) {
      _loadDashboard();
    }
  }

  Future<void> _handleToggleAvailability(bool value) async {
    DriverRepository? repo;
    try {
      repo = Provider.of<DriverRepository>(context, listen: false);
    } catch (_) {}

    final provider = context.read<DriverHomeProvider>();
    final success = await provider.setOnline(value, repository: repo);
    if (!mounted) return;
    if (!success && provider.statusUpdateError != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          key: const Key('driver_availability_error_snackbar'),
          content: Text(provider.statusUpdateError!),
          backgroundColor: AppColors.error,
        ),
      );
    }
  }

  Future<void> _handleAcceptOffer(String offerId) async {
    DriverRepository? repo;
    try {
      repo = Provider.of<DriverRepository>(context, listen: false);
    } catch (_) {}

    final provider = context.read<DriverHomeProvider>();
    final success = await provider.acceptOffer(offerId, repository: repo);
    if (!mounted) return;
    if (success) {
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          key: const Key('driver_offer_accepted_snackbar'),
          content: Text(
            provider.actionSuccessMessage ?? 'Offer accepted successfully!',
          ),
          backgroundColor: AppColors.success,
        ),
      );
    } else if (provider.offersError != null) {
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          key: const Key('driver_offer_error_snackbar'),
          content: Text(provider.offersError!),
          backgroundColor: AppColors.error,
          action: provider.unresolvedOfferId != null
              ? SnackBarAction(
                  key: const Key('driver_offer_error_retry_action'),
                  label: 'Retry',
                  textColor: Colors.white,
                  onPressed: () =>
                      _handleAcceptOffer(provider.unresolvedOfferId!),
                )
              : null,
        ),
      );
    }
  }

  Future<void> _handleRejectOffer(String offerId) async {
    DriverRepository? repo;
    try {
      repo = Provider.of<DriverRepository>(context, listen: false);
    } catch (_) {}

    final provider = context.read<DriverHomeProvider>();
    final success = await provider.rejectOffer(offerId, repository: repo);
    if (!mounted) return;
    if (success) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          key: Key('driver_offer_rejected_snackbar'),
          content: Text('Offer declined.'),
          backgroundColor: AppColors.textSecondary,
        ),
      );
    } else if (provider.offersError != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          key: const Key('driver_offer_error_snackbar'),
          content: Text(provider.offersError!),
          backgroundColor: AppColors.error,
          action: provider.unresolvedOfferId != null
              ? SnackBarAction(
                  key: const Key('driver_offer_error_retry_action'),
                  label: 'Retry',
                  textColor: Colors.white,
                  onPressed: () =>
                      _handleAcceptOffer(provider.unresolvedOfferId!),
                )
              : null,
        ),
      );
    }
  }

  Color _colorForOperationalStatus(String? status) {
    switch (status) {
      case 'AVAILABLE':
        return AppColors.success;
      case 'OFFLINE':
        return AppColors.textSecondary;
      case 'BUSY':
      case 'ASSIGNED':
      case 'RESERVED':
      case 'EN_ROUTE':
      case 'ARRIVED':
      case 'IN_TRIP':
        return AppColors.secondary;
      case 'SUSPENDED':
        return AppColors.error;
      default:
        return AppColors.warning;
    }
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final driverProvider = context.watch<DriverHomeProvider>();
    final onboardingProvider = context.watch<DriverOnboardingProvider>();
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
                context.read<DriverHomeProvider>().stopTrackingOnExitDriverMode();
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
            onPressed: () {
              context.read<DriverHomeProvider>().clear();
              context.read<AuthProvider>().logout();
            },
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: RefreshIndicator(
          key: const Key('driver_dashboard_refresh_indicator'),
          onRefresh: () async {
            DriverRepository? repo;
            try {
              repo = Provider.of<DriverRepository>(context, listen: false);
            } catch (_) {}
            await context.read<DriverHomeProvider>().refreshDashboard(
              verificationStatus: verificationStatus,
              userId: user?.id,
              repository: repo,
            );
          },
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
              if (onboardingProvider.profileRefreshPending) ...[
                Container(
                  key: const Key('pending_sync_banner'),
                  margin: const EdgeInsets.only(bottom: 16),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.secondaryContainer.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: AppColors.secondary.withValues(alpha: 0.3),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            Icons.sync_problem_outlined,
                            color: AppColors.secondary,
                            size: 24,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              'Profile Synchronization Pending',
                              style: textTheme.titleSmall?.copyWith(
                                color: AppColors.secondary,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Your driver onboarding application was submitted successfully. However, your profile could not be synchronized with the server. Please check your network and refresh application status.',
                        style: textTheme.bodySmall,
                      ),
                      const SizedBox(height: 12),
                      FilledButton.icon(
                        key: const Key('refresh_application_status_button'),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.secondary,
                          foregroundColor: Colors.white,
                        ),
                        onPressed: onboardingProvider.isSubmitting
                            ? null
                            : _handleRefreshApplicationStatus,
                        icon: onboardingProvider.isSubmitting
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Icon(Icons.refresh, size: 18),
                        label: const Text('Refresh Application Status'),
                      ),
                    ],
                  ),
                ),
              ],
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
              if (driverProvider.hasError) ...[
                const SizedBox(height: 16),
                Container(
                  key: const Key('driver_dashboard_error_banner'),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.error.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: AppColors.error.withValues(alpha: 0.4),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            Icons.error_outline,
                            color: AppColors.error,
                            size: 20,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'Failed to load driver dashboard',
                              style: textTheme.titleSmall?.copyWith(
                                color: AppColors.error,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        driverProvider.error ?? 'Unknown error occurred.',
                        style: textTheme.bodySmall?.copyWith(
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        key: const Key('driver_dashboard_retry_button'),
                        onPressed: driverProvider.isLoading
                            ? null
                            : _loadDashboard,
                        icon: const Icon(Icons.refresh, size: 16),
                        label: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ],
              if (driverProvider.isLoading && !driverProvider.hasLoaded) ...[
                const SizedBox(height: 32),
                const Center(
                  key: Key('driver_dashboard_loading'),
                  child: Column(
                    children: [
                      CircularProgressIndicator(),
                      SizedBox(height: 12),
                      Text('Loading driver readiness...'),
                    ],
                  ),
                ),
              ] else ...[
                const SizedBox(height: 20),
                Text(
                  'Readiness & Operational Status',
                  style: textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 12),
                Card(
                  elevation: 0,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: const BorderSide(color: AppColors.border),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Verification Status',
                              style: textTheme.bodyMedium?.copyWith(
                                color: AppColors.textSecondary,
                              ),
                            ),
                            Container(
                              key: const Key('driver_verification_status_chip'),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 3,
                              ),
                              decoration: BoxDecoration(
                                color: (isApproved
                                        ? AppColors.success
                                        : statusColor)
                                    .withValues(alpha: 0.15),
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
                        const Divider(height: 24),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Operational Status',
                              style: textTheme.bodyMedium?.copyWith(
                                color: AppColors.textSecondary,
                              ),
                            ),
                            if (isApproved) ...[
                              if (driverProvider.hasStatus && driverProvider.operationalStatus != null) ...[
                                Container(
                                  key: const Key('driver_operational_status'),
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                    vertical: 3,
                                  ),
                                  decoration: BoxDecoration(
                                    color: _colorForOperationalStatus(
                                      driverProvider.operationalStatus,
                                    ).withValues(alpha: 0.15),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: Text(
                                    driverProvider.operationalStatus!,
                                    style: textTheme.bodySmall?.copyWith(
                                      color: _colorForOperationalStatus(
                                        driverProvider.operationalStatus,
                                      ),
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                ),
                              ] else ...[
                                Text(
                                  'Status unavailable',
                                  key: const Key('driver_operational_status_unavailable'),
                                  style: textTheme.bodySmall?.copyWith(
                                    color: AppColors.textSecondary,
                                    fontStyle: FontStyle.italic,
                                  ),
                                ),
                              ],
                            ] else ...[
                              Text(
                                'Disabled',
                                key: const Key('driver_operational_status_disabled'),
                                style: textTheme.bodySmall?.copyWith(
                                  color: AppColors.textSecondary,
                                  fontStyle: FontStyle.italic,
                                ),
                              ),
                            ],
                          ],
                        ),
                        const Divider(height: 24),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              'Server Connection',
                              style: textTheme.bodyMedium?.copyWith(
                                color: AppColors.textSecondary,
                              ),
                            ),
                            if (isApproved) ...[
                              if (driverProvider.hasStatus && driverProvider.isOnline != null) ...[
                                Row(
                                  key: const Key('driver_online_state'),
                                  children: [
                                    Container(
                                      width: 8,
                                      height: 8,
                                      decoration: BoxDecoration(
                                        shape: BoxShape.circle,
                                        color: driverProvider.isOnline == true
                                            ? AppColors.success
                                            : AppColors.textSecondary,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      driverProvider.isOnline == true ? 'Online' : 'Offline',
                                      style: textTheme.bodySmall?.copyWith(
                                        color: driverProvider.isOnline == true
                                            ? AppColors.success
                                            : AppColors.textSecondary,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ],
                                ),
                              ] else ...[
                                Text(
                                  'Status unavailable',
                                  key: const Key('driver_online_state_unavailable'),
                                  style: textTheme.bodySmall?.copyWith(
                                    color: AppColors.textSecondary,
                                    fontStyle: FontStyle.italic,
                                  ),
                                ),
                              ],
                            ] else ...[
                              Text(
                                'Offline (Not Approved)',
                                key: const Key('driver_online_state_disabled'),
                                style: textTheme.bodySmall?.copyWith(
                                  color: AppColors.textSecondary,
                                  fontStyle: FontStyle.italic,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                if (isApproved) ...[
                  const SizedBox(height: 20),
                  DriverAvailabilityCard(
                    isOnline: driverProvider.isOnline,
                    isLoading: driverProvider.isUpdatingStatus,
                    onChanged: driverProvider.hasStatus &&
                            !driverProvider.isUpdatingStatus
                        ? _handleToggleAvailability
                        : null,
                  ),
                  const SizedBox(height: 20),
                  DispatchOffersInbox(
                    state: driverProvider.inboxState,
                    offers: driverProvider.offers,
                    errorMessage: driverProvider.offersError,
                    unresolvedOfferId: driverProvider.unresolvedOfferId,
                    onRetryAccept: _handleAcceptOffer,
                    onRetry: () {
                      DriverRepository? repo;
                      try {
                        repo = Provider.of<DriverRepository>(context,
                            listen: false);
                      } catch (_) {}
                      driverProvider.loadOffers(repository: repo);
                    },
                    onAcceptOffer: _handleAcceptOffer,
                    onRejectOffer: _handleRejectOffer,
                  ),
                ],
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Registered Vehicles',
                      style: textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    Container(
                      key: const Key('driver_vehicle_count'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: AppColors.secondaryContainer,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        '${driverProvider.vehicleCount} ${driverProvider.vehicleCount == 1 ? 'vehicle' : 'vehicles'}',
                        style: textTheme.bodySmall?.copyWith(
                          color: AppColors.onSecondaryContainer,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (driverProvider.hasLoaded && driverProvider.vehicles.isEmpty) ...[
                  Card(
                    key: const Key('driver_empty_vehicles_card'),
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: const BorderSide(color: AppColors.border),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        vertical: 32,
                        horizontal: 16,
                      ),
                      child: Center(
                        child: Column(
                          children: [
                            const Icon(
                              Icons.electric_rickshaw_outlined,
                              size: 48,
                              color: AppColors.textSecondary,
                            ),
                            const SizedBox(height: 12),
                            Text(
                              'No Registered Vehicles',
                              style: textTheme.titleSmall?.copyWith(
                                color: AppColors.textPrimary,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'No vehicles are currently linked to your driver profile.',
                              textAlign: TextAlign.center,
                              style: textTheme.bodySmall?.copyWith(
                                color: AppColors.textSecondary,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ] else if (driverProvider.vehicles.isNotEmpty) ...[
                  for (final vehicle in driverProvider.vehicles) ...[
                    Card(
                      key: Key('driver_vehicle_card_${vehicle.id}'),
                      elevation: 0,
                      margin: const EdgeInsets.only(bottom: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
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
                                    const Icon(
                                      Icons.electric_rickshaw,
                                      color: AppColors.primary,
                                      size: 20,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      vehicle.registrationNumber,
                                      key: Key(
                                        'vehicle_registration_${vehicle.registrationNumber}',
                                      ),
                                      style: textTheme.titleSmall?.copyWith(
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ],
                                ),
                                Container(
                                  key: Key(
                                    'vehicle_status_${vehicle.registrationNumber}',
                                  ),
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 2,
                                  ),
                                  decoration: BoxDecoration(
                                    color: (vehicle.isActive
                                            ? AppColors.success
                                            : AppColors.textSecondary)
                                        .withValues(alpha: 0.15),
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(
                                    vehicle.isActive ? 'Active' : 'Inactive',
                                    style: textTheme.bodySmall?.copyWith(
                                      color: vehicle.isActive
                                          ? AppColors.success
                                          : AppColors.textSecondary,
                                      fontWeight: FontWeight.bold,
                                      fontSize: 11,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        'Model',
                                        style: textTheme.bodySmall?.copyWith(
                                          color: AppColors.textSecondary,
                                        ),
                                      ),
                                      Text(
                                        vehicle.makeModel,
                                        key: Key(
                                          'vehicle_model_${vehicle.registrationNumber}',
                                        ),
                                        style: textTheme.bodyMedium?.copyWith(
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        'Type',
                                        style: textTheme.bodySmall?.copyWith(
                                          color: AppColors.textSecondary,
                                        ),
                                      ),
                                      Text(
                                        vehicle.vehicleType,
                                        key: Key(
                                          'vehicle_type_${vehicle.registrationNumber}',
                                        ),
                                        style: textTheme.bodyMedium?.copyWith(
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'Capacity',
                                      style: textTheme.bodySmall?.copyWith(
                                        color: AppColors.textSecondary,
                                      ),
                                    ),
                                    Row(
                                      children: [
                                        const Icon(
                                          Icons.people_outline,
                                          size: 16,
                                          color: AppColors.textSecondary,
                                        ),
                                        const SizedBox(width: 4),
                                        Text(
                                          '${vehicle.passengerCapacity}',
                                          key: Key(
                                            'vehicle_capacity_${vehicle.registrationNumber}',
                                          ),
                                          style: textTheme.bodyMedium?.copyWith(
                                            fontWeight: FontWeight.w600,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ],
              ],
            ],
          ),
        ),
      ),
    ),
  );
  }
}
