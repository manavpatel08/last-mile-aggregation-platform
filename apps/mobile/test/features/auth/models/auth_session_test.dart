import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/features/auth/models/auth_session.dart';

void main() {
  group('AuthSession & RefreshSessionResult Models', () {
    test('parses AuthSession from backend response JSON', () {
      final json = <String, dynamic>{
        'user': {
          'id': 'user-1',
          'email': 'user@pdeu.ac.in',
          'fullName': 'User Name',
          'role': 'PASSENGER',
          'roles': ['PASSENGER'],
          'driverVerificationStatus': null,
        },
        'accessToken': 'jwt.access.token',
        'refreshToken': 'uuid.refresh.token',
        'expiresIn': 900,
      };

      final session = AuthSession.fromJson(json);

      expect(session.user.id, 'user-1');
      expect(session.accessToken, 'jwt.access.token');
      expect(session.refreshToken, 'uuid.refresh.token');
      expect(session.expiresIn, 900);

      final serialized = session.toJson();
      expect(serialized['accessToken'], 'jwt.access.token');
      expect(serialized['expiresIn'], 900);
    });

    test('parses RefreshSessionResult from POST /auth/refresh response', () {
      final json = <String, dynamic>{
        'accessToken': 'rotated.access.token',
        'refreshToken': 'rotated.refresh.token',
        'expiresIn': 900,
      };

      final result = RefreshSessionResult.fromJson(json);

      expect(result.accessToken, 'rotated.access.token');
      expect(result.refreshToken, 'rotated.refresh.token');
      expect(result.expiresIn, 900);

      final serialized = result.toJson();
      expect(serialized['refreshToken'], 'rotated.refresh.token');
    });
  });
}
