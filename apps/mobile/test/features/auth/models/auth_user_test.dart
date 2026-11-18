import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/auth/models/auth_user.dart';

void main() {
  group('AuthUser Model', () {
    test('parses compact Google Auth response user', () {
      final json = <String, dynamic>{
        'id': 'user-uuid-1',
        'email': 'student@pdeu.ac.in',
        'fullName': 'PDEU Student',
        'role': 'PASSENGER',
        'roles': ['PASSENGER'],
        'driverVerificationStatus': null,
      };

      final user = AuthUser.fromJson(json);

      expect(user.id, 'user-uuid-1');
      expect(user.email, 'student@pdeu.ac.in');
      expect(user.fullName, 'PDEU Student');
      expect(user.role, 'PASSENGER');
      expect(user.roles, ['PASSENGER']);
      expect(user.isPassenger, isTrue);
      expect(user.isDriver, isFalse);
      expect(user.isAdmin, isFalse);
      expect(user.isDualRole, isFalse);
      expect(user.isApprovedDriver, isFalse);
    });

    test('parses comprehensive /users/me driver profile response', () {
      final json = <String, dynamic>{
        'id': 'driver-uuid-1',
        'email': 'driver@pdeu.ac.in',
        'fullName': 'PDEU Driver',
        'phoneNumber': '+919876543210',
        'avatarUrl': 'https://example.com/avatar.jpg',
        'role': 'DRIVER',
        'roles': ['DRIVER'],
        'passengerProfile': null,
        'driverProfile': {
          'id': 'profile-uuid-1',
          'licenseNumber': 'GJ-18-2024-0012',
          'verificationStatus': 'APPROVED',
          'operationalStatus': 'AVAILABLE',
          'isOnline': true,
          'vehicles': [
            {'id': 'v-1', 'plateNumber': 'GJ-18-E-1234'},
          ],
        },
        'outstandingCancellationFees': {
          'count': 1,
          'totalPaise': 3000,
          'formattedRupees': '30.00',
        },
      };

      final user = AuthUser.fromJson(json);

      expect(user.id, 'driver-uuid-1');
      expect(user.isDriver, isTrue);
      expect(user.isPassenger, isFalse);
      expect(user.isApprovedDriver, isTrue);
      expect(user.driverProfile?.licenseNumber, 'GJ-18-2024-0012');
      expect(user.driverProfile?.isAvailable, isTrue);
      expect(user.driverProfile?.isApproved, isTrue);
      expect(user.outstandingFees?.totalPaise, 3000);
      expect(user.outstandingFees?.formattedRupees, '30.00');
    });

    test('correctly identifies dual-role users and admin accounts', () {
      const dualRole = AuthUser(
        id: 'dual-1',
        email: 'dual@pdeu.ac.in',
        fullName: 'Dual Role',
        role: 'PASSENGER',
        roles: ['PASSENGER', 'DRIVER'],
      );

      expect(dualRole.isDualRole, isTrue);
      expect(dualRole.isPassenger, isTrue);
      expect(dualRole.isDriver, isTrue);
      expect(dualRole.isAdmin, isFalse);

      const admin = AuthUser(
        id: 'admin-1',
        email: 'admin@pdeu.ac.in',
        fullName: 'Campus Admin',
        role: 'ADMIN',
        roles: ['ADMIN'],
      );

      expect(admin.isAdmin, isTrue);
      expect(admin.isPassenger, isFalse);
      expect(admin.isDriver, isFalse);
    });

    test('serializes to JSON and round-trips via copyWith', () {
      const user = AuthUser(
        id: 'u-1',
        email: 'user@pdeu.ac.in',
        fullName: 'User Name',
        role: 'PASSENGER',
        roles: ['PASSENGER'],
      );

      final json = user.toJson();
      expect(json['id'], 'u-1');
      expect(json['email'], 'user@pdeu.ac.in');

      final updated = user.copyWith(fullName: 'Updated Name');
      expect(updated.fullName, 'Updated Name');
      expect(updated.id, 'u-1');
    });
  });
}
