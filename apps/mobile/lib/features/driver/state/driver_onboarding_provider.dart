import 'package:flutter/foundation.dart';

import '../../../app/state/app_mode_provider.dart';
import '../../../core/config/app_config.dart';
import '../../../core/network/api_exception.dart';
import '../../auth/state/auth_provider.dart';
import '../data/driver_repository.dart';
import '../models/driver_onboarding_request.dart';

/// Presentation state and submission controller for driver onboarding.
class DriverOnboardingProvider extends ChangeNotifier {
  DriverOnboardingProvider({
    required this.driverRepository,
  });

  final DriverRepository driverRepository;

  bool _isSubmitting = false;
  bool _applicationSubmitted = false;
  bool _profileRefreshPending = false;
  String? _errorMessage;
  String? _warningMessage;

  bool get isSubmitting => _isSubmitting;
  bool get applicationSubmitted => _applicationSubmitted;
  bool get profileRefreshPending => _profileRefreshPending;
  String? get errorMessage => _errorMessage;
  String? get warningMessage => _warningMessage;

  @visibleForTesting
  void setProfileRefreshPending(bool pending) {
    _profileRefreshPending = pending;
    notifyListeners();
  }

  /// Submits the onboarding application to `POST /api/v1/drivers/onboard`.
  ///
  /// Upon successful submission:
  /// 1. Marks the application as submitted.
  /// 2. Attempts to refresh the current user profile from `/users/me`.
  /// 3. If profile refresh succeeds, updates [AuthProvider] and sets active mode to [AppMode.driver].
  /// 4. If profile refresh fails due to transient network error, sets [profileRefreshPending] to true,
  ///    sets a clear warning message, updates the local driver profile with the backend PENDING status,
  ///    and switches mode WITHOUT attempting to re-submit the onboarding payload.
  Future<bool> submitOnboarding({
    required DriverOnboardingRequest request,
    required AuthProvider authProvider,
    required AppModeProvider appModeProvider,
  }) async {
    if (_isSubmitting) {
      return false;
    }

    if (_applicationSubmitted) {
      _warningMessage =
          'Your driver onboarding application has already been submitted. You do not need to reapply.';
      notifyListeners();
      return true;
    }

    _isSubmitting = true;
    _errorMessage = null;
    _warningMessage = null;
    notifyListeners();

    try {
      final response = await driverRepository.onboardDriver(request);
      _applicationSubmitted = true;

      // Refresh authoritative user profile from backend
      final refreshSuccess = await authProvider.refreshProfile();

      if (!refreshSuccess) {
        // Backend onboarding committed, but GET /users/me failed or timed out.
        // Update local state gracefully so user can proceed to Driver Home with PENDING status.
        _profileRefreshPending = true;
        authProvider.updateDriverProfile(response.driverProfile);
        _warningMessage =
            'Application submitted successfully! Your driver verification is PENDING review. Refreshing your profile timed out; you do not need to re-submit.';
      } else {
        _profileRefreshPending = false;
        _warningMessage = null;
      }

      appModeProvider.selectMode(AppMode.driver);
      _errorMessage = null;
      return true;
    } on ApiException catch (e) {
      if (e.statusCode == 409 || e.errorCode == 'CONFLICT') {
        _errorMessage = e.message;
      } else if (e.errorCode == 'NETWORK_UNAVAILABLE') {
        _errorMessage =
            'Unable to reach server. Please check your network connection and try again.';
      } else if (e.errorCode == 'REQUEST_TIMEOUT') {
        _errorMessage =
            'The request timed out. Please verify your connection and try again.';
      } else {
        _errorMessage = e.message;
      }
      return false;
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[DriverOnboardingProvider] Unexpected submission error: $e');
      }
      _errorMessage =
          'An unexpected error occurred while submitting your application. Please try again.';
      return false;
    } finally {
      _isSubmitting = false;
      notifyListeners();
    }
  }

  /// Retries fetching the updated user profile from `/users/me`.
  ///
  /// CRITICAL INVARIANT: This method NEVER invokes [DriverRepository.onboardDriver]
  /// or sends `POST /api/v1/drivers/onboard`. It only synchronizes profile state.
  Future<bool> retryProfileSync({
    required AuthProvider authProvider,
  }) async {
    if (_isSubmitting) {
      return false;
    }

    _isSubmitting = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final refreshSuccess = await authProvider.refreshProfile();
      if (refreshSuccess) {
        _profileRefreshPending = false;
        _warningMessage = null;
        _errorMessage = null;
      } else {
        _profileRefreshPending = true;
        _warningMessage =
            'Profile synchronization failed. Please check your network connection and try again.';
      }
      return refreshSuccess;
    } catch (e) {
      _profileRefreshPending = true;
      _errorMessage = 'Failed to refresh profile. Please try again.';
      return false;
    } finally {
      _isSubmitting = false;
      notifyListeners();
    }
  }

  void clearErrors() {
    _errorMessage = null;
    _warningMessage = null;
    notifyListeners();
  }
}
