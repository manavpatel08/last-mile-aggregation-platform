import 'package:material_ui/material_ui.dart';
import 'package:provider/provider.dart';

import '../../../../core/theme/app_colors.dart';
import '../../data/trip_repository.dart';
import '../../state/passenger_active_trip_provider.dart';

/// Screen displaying the passenger active trip status, driver & vehicle details,
/// pickup hub confirmation, and the authoritative 4-digit boarding OTP.
class PassengerActiveTripScreen extends StatefulWidget {
  const PassengerActiveTripScreen({
    super.key,
    required this.bookingId,
    this.repository,
    this.provider,
  });

  final String bookingId;
  final TripRepository? repository;
  final PassengerActiveTripProvider? provider;

  @override
  State<PassengerActiveTripScreen> createState() =>
      _PassengerActiveTripScreenState();
}

class _PassengerActiveTripScreenState extends State<PassengerActiveTripScreen> {
  late final PassengerActiveTripProvider _provider;
  bool _ownsProvider = false;

  @override
  void initState() {
    super.initState();
    if (widget.provider != null) {
      _provider = widget.provider!;
      _ownsProvider = false;
    } else {
      _provider = PassengerActiveTripProvider(repository: widget.repository);
      _ownsProvider = true;
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _provider.loadBoardingPass(
          widget.bookingId,
          repository: widget.repository,
        );
      }
    });
  }

  @override
  void dispose() {
    if (_ownsProvider) {
      _provider.dispose();
    }
    super.dispose();
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'DRIVER_ASSIGNED':
        return AppColors.warning;
      case 'DRIVER_ARRIVED':
      case 'BOARDED':
      case 'IN_PROGRESS':
        return AppColors.success;
      case 'COMPLETED':
        return AppColors.primary;
      default:
        return AppColors.textSecondary;
    }
  }

  String _statusLabel(String status) {
    switch (status) {
      case 'DRIVER_ASSIGNED':
        return 'Driver En Route to Hub';
      case 'DRIVER_ARRIVED':
        return 'Driver Arrived at Hub';
      case 'BOARDED':
        return 'Boarded — Ride Starting';
      case 'IN_PROGRESS':
        return 'Trip In Progress';
      case 'COMPLETED':
        return 'Trip Completed';
      default:
        return status;
    }
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<PassengerActiveTripProvider>.value(
      value: _provider,
      child: Consumer<PassengerActiveTripProvider>(
        builder: (context, provider, _) {
          return Scaffold(
            appBar: AppBar(
              title: const Text('Active Trip'),
              actions: [
                IconButton(
                  key: const Key('refresh_boarding_pass_button'),
                  icon: const Icon(Icons.refresh),
                  tooltip: 'Refresh',
                  onPressed: provider.isLoading
                      ? null
                      : () => provider.refresh(repository: widget.repository),
                ),
              ],
            ),
            body: SafeArea(
              child: Builder(
                builder: (context) {
                  if (provider.isLoading && !provider.hasBoardingPass) {
                    return const Center(
                      child: CircularProgressIndicator(
                        key: Key('active_trip_loading_indicator'),
                      ),
                    );
                  }

                  if (provider.errorMessage != null &&
                      !provider.hasBoardingPass) {
                    return Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.error_outline,
                              size: 48,
                              color: AppColors.error,
                            ),
                            const SizedBox(height: 16),
                            Text(
                              provider.errorMessage!,
                              key: const Key('active_trip_error_banner'),
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 16,
                                color: AppColors.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 24),
                            ElevatedButton.icon(
                              key: const Key('retry_load_boarding_pass_button'),
                              onPressed: () => provider.loadBoardingPass(
                                widget.bookingId,
                                repository: widget.repository,
                              ),
                              icon: const Icon(Icons.refresh),
                              label: const Text('Retry'),
                            ),
                          ],
                        ),
                      ),
                    );
                  }

                  final pass = provider.boardingPass;
                  if (pass == null) {
                    return const Center(
                      child: Text('No active trip information found.'),
                    );
                  }

                  return ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      // Status Banner
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 12,
                        ),
                        decoration: BoxDecoration(
                          color: _statusColor(pass.bookingStatus)
                              .withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(
                            color: _statusColor(pass.bookingStatus)
                                .withValues(alpha: 0.3),
                          ),
                        ),
                        child: Row(
                          children: [
                            Icon(
                              pass.isDriverArrived
                                  ? Icons.check_circle_outline
                                  : Icons.directions_car,
                              color: _statusColor(pass.bookingStatus),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _statusLabel(pass.bookingStatus),
                                    key: const Key('trip_status_text'),
                                    style: TextStyle(
                                      fontWeight: FontWeight.bold,
                                      fontSize: 15,
                                      color: _statusColor(pass.bookingStatus),
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    pass.isDriverArrived
                                        ? 'Your driver is waiting at the hub.'
                                        : 'Driver is traveling to PDEU pickup hub.',
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: AppColors.textSecondary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),

                      // Boarding Pass OTP Card
                      Card(
                        elevation: 3,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                          side: BorderSide(
                            color: AppColors.primary.withValues(alpha: 0.3),
                            width: 1.5,
                          ),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 24,
                            vertical: 24,
                          ),
                          child: Column(
                            children: [
                              const Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(
                                    Icons.pin,
                                    size: 20,
                                    color: AppColors.primary,
                                  ),
                                  SizedBox(width: 6),
                                  Text(
                                    'BOARDING PASS OTP',
                                    style: TextStyle(
                                      letterSpacing: 1.5,
                                      fontSize: 13,
                                      fontWeight: FontWeight.bold,
                                      color: AppColors.primary,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 28,
                                  vertical: 14,
                                ),
                                decoration: BoxDecoration(
                                  color: AppColors.surface,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: AppColors.border,
                                  ),
                                ),
                                child: Text(
                                  provider.formattedOtp,
                                  key: const Key('boarding_otp_display'),
                                  style: const TextStyle(
                                    fontSize: 34,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 6,
                                    color: AppColors.textPrimary,
                                  ),
                                ),
                              ),
                              const SizedBox(height: 16),
                              const Text(
                                'Share this 4-digit OTP with your driver before boarding.',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  fontSize: 13,
                                  color: AppColors.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),

                      // Driver & Vehicle Information Card
                      Card(
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'Assigned Driver & Vehicle',
                                style: TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 15,
                                ),
                              ),
                              const Divider(height: 20),
                              ListTile(
                                contentPadding: EdgeInsets.zero,
                                leading: CircleAvatar(
                                  backgroundColor:
                                      AppColors.primary.withValues(alpha: 0.12),
                                  child: const Icon(
                                    Icons.person,
                                    color: AppColors.primary,
                                  ),
                                ),
                                title: Text(
                                  pass.driver.name,
                                  key: const Key('driver_name_text'),
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                                subtitle: Text(
                                  pass.driver.phoneNumber ??
                                      'Phone not available',
                                  key: const Key('driver_phone_text'),
                                ),
                              ),
                              if (pass.driver.vehicle != null) ...[
                                const SizedBox(height: 8),
                                Container(
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: AppColors.surface,
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(
                                        Icons.electric_rickshaw,
                                        color: AppColors.primary,
                                        size: 28,
                                      ),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              pass.driver.vehicle!.makeModel,
                                              key: const Key(
                                                'vehicle_make_model_text',
                                              ),
                                              style: const TextStyle(
                                                fontWeight: FontWeight.w600,
                                              ),
                                            ),
                                            Text(
                                              pass.driver.vehicle!
                                                  .registrationNumber,
                                              key: const Key(
                                                'vehicle_reg_number_text',
                                              ),
                                              style: const TextStyle(
                                                fontSize: 12,
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
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),

                      // Pickup Hub Details
                      Card(
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Padding(
                          padding: EdgeInsets.all(16),
                          child: Row(
                            children: [
                              Icon(
                                Icons.location_on,
                                color: AppColors.primary,
                                size: 28,
                              ),
                              SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'Pickup Point',
                                      style: TextStyle(
                                        fontSize: 12,
                                        color: AppColors.textSecondary,
                                      ),
                                    ),
                                    SizedBox(height: 2),
                                    Text(
                                      'PDEU Main Gate Hub',
                                      style: TextStyle(
                                        fontWeight: FontWeight.bold,
                                        fontSize: 14,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          );
        },
      ),
    );
  }
}
