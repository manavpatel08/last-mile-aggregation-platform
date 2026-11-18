/// Domain representations for authenticated users and associated profiles.
library;

class PassengerProfile {
  const PassengerProfile({
    required this.id,
    required this.defaultMinGroupPreference,
    required this.totalRidesCompleted,
  });

  factory PassengerProfile.fromJson(Map<String, dynamic> json) {
    return PassengerProfile(
      id: json['id'] as String,
      defaultMinGroupPreference:
          json['defaultMinGroupPreference'] as int? ?? 2,
      totalRidesCompleted: json['totalRidesCompleted'] as int? ?? 0,
    );
  }

  final String id;
  final int defaultMinGroupPreference;
  final int totalRidesCompleted;

  Map<String, dynamic> toJson() => {
        'id': id,
        'defaultMinGroupPreference': defaultMinGroupPreference,
        'totalRidesCompleted': totalRidesCompleted,
      };
}

class DriverProfile {
  const DriverProfile({
    required this.id,
    this.licenseNumber,
    required this.verificationStatus,
    required this.operationalStatus,
    required this.isOnline,
    this.vehicles = const [],
  });

  factory DriverProfile.fromJson(Map<String, dynamic> json) {
    return DriverProfile(
      id: json['id'] as String,
      licenseNumber: json['licenseNumber'] as String?,
      verificationStatus:
          json['verificationStatus'] as String? ?? 'PENDING',
      operationalStatus:
          json['operationalStatus'] as String? ?? 'OFFLINE',
      isOnline: json['isOnline'] as bool? ?? false,
      vehicles: json['vehicles'] is List ? (json['vehicles'] as List) : const [],
    );
  }

  final String id;
  final String? licenseNumber;
  final String verificationStatus;
  final String operationalStatus;
  final bool isOnline;
  final List<dynamic> vehicles;

  bool get isApproved => verificationStatus == 'APPROVED';
  bool get isAvailable => operationalStatus == 'AVAILABLE';

  Map<String, dynamic> toJson() => {
        'id': id,
        'licenseNumber': licenseNumber,
        'verificationStatus': verificationStatus,
        'operationalStatus': operationalStatus,
        'isOnline': isOnline,
        'vehicles': vehicles,
      };
}

class OutstandingCancellationFees {
  const OutstandingCancellationFees({
    required this.count,
    required this.totalPaise,
    required this.formattedRupees,
  });

  factory OutstandingCancellationFees.fromJson(Map<String, dynamic> json) {
    return OutstandingCancellationFees(
      count: json['count'] as int? ?? 0,
      totalPaise: json['totalPaise'] as int? ?? 0,
      formattedRupees: json['formattedRupees'] as String? ?? '0.00',
    );
  }

  final int count;
  final int totalPaise;
  final String formattedRupees;

  Map<String, dynamic> toJson() => {
        'count': count,
        'totalPaise': totalPaise,
        'formattedRupees': formattedRupees,
      };
}

class AuthUser {
  const AuthUser({
    required this.id,
    required this.email,
    required this.fullName,
    this.phoneNumber,
    this.avatarUrl,
    required this.role,
    this.roles = const [],
    this.driverVerificationStatus,
    this.passengerProfile,
    this.driverProfile,
    this.outstandingFees,
  });

  factory AuthUser.fromJson(Map<String, dynamic> json) {
    final rawRoles = json['roles'];
    final rolesList = rawRoles is List
        ? rawRoles.map((r) => r.toString()).toList()
        : <String>[];

    final rawPassenger = json['passengerProfile'];
    final rawDriver = json['driverProfile'];
    final rawFees = json['outstandingCancellationFees'];

    return AuthUser(
      id: json['id'] as String,
      email: json['email'] as String,
      fullName: json['fullName'] as String? ?? '',
      phoneNumber: json['phoneNumber'] as String?,
      avatarUrl: json['avatarUrl'] as String?,
      role: json['role'] as String? ?? 'PASSENGER',
      roles: rolesList,
      driverVerificationStatus: json['driverVerificationStatus'] as String?,
      passengerProfile: rawPassenger is Map<String, dynamic>
          ? PassengerProfile.fromJson(rawPassenger)
          : null,
      driverProfile: rawDriver is Map<String, dynamic>
          ? DriverProfile.fromJson(rawDriver)
          : null,
      outstandingFees: rawFees is Map<String, dynamic>
          ? OutstandingCancellationFees.fromJson(rawFees)
          : null,
    );
  }

  final String id;
  final String email;
  final String fullName;
  final String? phoneNumber;
  final String? avatarUrl;
  final String role;
  final List<String> roles;
  final String? driverVerificationStatus;
  final PassengerProfile? passengerProfile;
  final DriverProfile? driverProfile;
  final OutstandingCancellationFees? outstandingFees;

  bool get isDriver =>
      role == 'DRIVER' ||
      roles.contains('DRIVER') ||
      driverProfile != null;

  bool get isPassenger =>
      role == 'PASSENGER' ||
      roles.contains('PASSENGER') ||
      passengerProfile != null;

  bool get isAdmin =>
      role == 'ADMIN' ||
      role == 'SUPER_ADMIN' ||
      roles.contains('ADMIN') ||
      roles.contains('SUPER_ADMIN');

  bool get isApprovedDriver =>
      driverProfile?.isApproved == true ||
      driverVerificationStatus == 'APPROVED';

  bool get isDualRole => isDriver && isPassenger;

  AuthUser copyWith({
    String? id,
    String? email,
    String? fullName,
    String? phoneNumber,
    String? avatarUrl,
    String? role,
    List<String>? roles,
    String? driverVerificationStatus,
    PassengerProfile? passengerProfile,
    DriverProfile? driverProfile,
    OutstandingCancellationFees? outstandingFees,
  }) {
    return AuthUser(
      id: id ?? this.id,
      email: email ?? this.email,
      fullName: fullName ?? this.fullName,
      phoneNumber: phoneNumber ?? this.phoneNumber,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      role: role ?? this.role,
      roles: roles ?? this.roles,
      driverVerificationStatus:
          driverVerificationStatus ?? this.driverVerificationStatus,
      passengerProfile: passengerProfile ?? this.passengerProfile,
      driverProfile: driverProfile ?? this.driverProfile,
      outstandingFees: outstandingFees ?? this.outstandingFees,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        'fullName': fullName,
        'phoneNumber': phoneNumber,
        'avatarUrl': avatarUrl,
        'role': role,
        'roles': roles,
        'driverVerificationStatus': driverVerificationStatus,
        'passengerProfile': passengerProfile?.toJson(),
        'driverProfile': driverProfile?.toJson(),
        'outstandingCancellationFees': outstandingFees?.toJson(),
      };
}
