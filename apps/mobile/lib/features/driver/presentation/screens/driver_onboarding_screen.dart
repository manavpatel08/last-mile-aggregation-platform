import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../../app/router/app_routes.dart';
import '../../../../app/state/app_mode_provider.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../auth/state/auth_provider.dart';
import '../../models/driver_onboarding_request.dart';
import '../../state/driver_onboarding_provider.dart';

/// Screen allowing registered passengers to apply for campus driver authorization.
class DriverOnboardingScreen extends StatefulWidget {
  const DriverOnboardingScreen({super.key});

  @override
  State<DriverOnboardingScreen> createState() => _DriverOnboardingScreenState();
}

class _DriverOnboardingScreenState extends State<DriverOnboardingScreen> {
  final _formKey = GlobalKey<FormState>();
  final _licenseController = TextEditingController();
  final _registrationController = TextEditingController();
  final _makeModelController = TextEditingController();
  final _capacityController = TextEditingController(text: '4');
  String _selectedVehicleType = 'E_RICKSHAW';

  @override
  void dispose() {
    _licenseController.dispose();
    _registrationController.dispose();
    _makeModelController.dispose();
    _capacityController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    final provider = context.read<DriverOnboardingProvider>();
    final authProvider = context.read<AuthProvider>();
    final appModeProvider = context.read<AppModeProvider>();

    final capacity = int.tryParse(_capacityController.text.trim()) ?? 4;

    final request = DriverOnboardingRequest(
      licenseNumber: _licenseController.text.trim(),
      vehicle: VehicleDetails(
        registrationNumber: _registrationController.text.trim(),
        vehicleType: _selectedVehicleType,
        passengerCapacity: capacity,
        makeModel: _makeModelController.text.trim(),
      ),
    );

    final success = await provider.submitOnboarding(
      request: request,
      authProvider: authProvider,
      appModeProvider: appModeProvider,
    );

    if (!mounted) return;

    if (success) {
      if (provider.warningMessage != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(provider.warningMessage!),
            backgroundColor: AppColors.warning,
            duration: const Duration(seconds: 4),
          ),
        );
      }
      context.go(AppRoutes.driverHome);
    }
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final provider = context.watch<DriverOnboardingProvider>();
    final isSubmitting = provider.isSubmitting;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Driver Onboarding'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Join PDEU Micro-Mobility Fleet',
                  style: textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Submit your driving licence and vehicle details. Once verified by campus administration, you can start accepting shared passenger trips.',
                  style: textTheme.bodyMedium?.copyWith(
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(height: 20),
                if (provider.errorMessage != null) ...[
                  Container(
                    key: const Key('onboarding_error_banner'),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.error.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: AppColors.error.withValues(alpha: 0.4),
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(
                          Icons.error_outline,
                          color: AppColors.error,
                          size: 20,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            provider.errorMessage!,
                            style: textTheme.bodySmall?.copyWith(
                              color: AppColors.error,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
                if (provider.warningMessage != null) ...[
                  Container(
                    key: const Key('onboarding_warning_banner'),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.warning.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: AppColors.warning.withValues(alpha: 0.4),
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(
                          Icons.warning_amber_outlined,
                          color: AppColors.warning,
                          size: 20,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            provider.warningMessage!,
                            style: textTheme.bodySmall?.copyWith(
                              color: AppColors.warning,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
                Text(
                  'Driving Licence',
                  style: textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                TextFormField(
                  key: const Key('license_number_field'),
                  controller: _licenseController,
                  enabled: !isSubmitting,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    labelText: 'Driving Licence Number',
                    hintText: 'e.g. GJ-01-2023-0012345',
                    prefixIcon: Icon(Icons.badge_outlined),
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter your driving licence number';
                    }
                    if (value.trim().length < 5) {
                      return 'Licence number must be at least 5 characters';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 20),
                Text(
                  'Vehicle Details',
                  style: textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                TextFormField(
                  key: const Key('registration_number_field'),
                  controller: _registrationController,
                  enabled: !isSubmitting,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    labelText: 'Vehicle Registration Number',
                    hintText: 'e.g. GJ-01-AA-1234',
                    prefixIcon: Icon(Icons.confirmation_number_outlined),
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter vehicle registration number';
                    }
                    if (value.trim().length < 4) {
                      return 'Registration number must be at least 4 characters';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  key: const Key('vehicle_type_dropdown'),
                  initialValue: _selectedVehicleType,
                  decoration: const InputDecoration(
                    labelText: 'Vehicle Type',
                    prefixIcon: Icon(Icons.electric_rickshaw_outlined),
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'E_RICKSHAW',
                      child: Text('E-Rickshaw (E_RICKSHAW)'),
                    ),
                    DropdownMenuItem(
                      value: 'BIKE_TAXI',
                      child: Text('Bike Taxi (BIKE_TAXI)'),
                    ),
                    DropdownMenuItem(
                      value: 'SHUTTLE_VAN',
                      child: Text('Shuttle Van (SHUTTLE_VAN)'),
                    ),
                  ],
                  onChanged: isSubmitting
                      ? null
                      : (val) {
                          if (val != null) {
                            setState(() {
                              _selectedVehicleType = val;
                            });
                          }
                        },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  key: const Key('passenger_capacity_field'),
                  controller: _capacityController,
                  enabled: !isSubmitting,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Passenger Capacity (1–8)',
                    hintText: '4',
                    prefixIcon: Icon(Icons.group_outlined),
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter passenger capacity';
                    }
                    final parsed = int.tryParse(value.trim());
                    if (parsed == null) {
                      return 'Must be a valid integer';
                    }
                    if (parsed < 1 || parsed > 8) {
                      return 'Capacity must be between 1 and 8';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  key: const Key('make_model_field'),
                  controller: _makeModelController,
                  enabled: !isSubmitting,
                  decoration: const InputDecoration(
                    labelText: 'Vehicle Make & Model',
                    hintText: 'e.g. Mahindra Treo',
                    prefixIcon: Icon(Icons.commute_outlined),
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter vehicle make and model';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 28),
                FilledButton(
                  key: const Key('submit_onboarding_button'),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.driverAccent,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                  ),
                  onPressed: isSubmitting ? null : _submit,
                  child: isSubmitting
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text(
                          'Submit Application',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
