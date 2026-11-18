import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/network/auth_token_store.dart';

void main() {
  group('AuthTokenStore', () {
    test('starts with no token and isExpired true', () {
      final store = AuthTokenStore();
      expect(store.accessToken, isNull);
      expect(store.hasValidToken, isFalse);
      expect(store.isExpired, isTrue);
      expect(store.expiresAt, isNull);
    });

    test('stores access token and marks as valid when unexpired', () {
      final store = AuthTokenStore();
      store.setToken(
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
        expiresInSeconds: 900,
      );

      expect(
        store.accessToken,
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      );
      expect(store.hasValidToken, isTrue);
      expect(store.isExpired, isFalse);
      expect(store.expiresAt, isNotNull);
    });

    test('detects expired token when expiresInSeconds is zero or negative', () {
      final store = AuthTokenStore();
      store.setToken(
        accessToken: 'expired-token',
        expiresInSeconds: 0,
      );

      // Buffer of 5 seconds treats 0s as invalid
      expect(store.hasValidToken, isFalse);
    });

    test('clear() wipes in-memory token and expiration', () {
      final store = AuthTokenStore();
      store.setToken(
        accessToken: 'valid-token',
        expiresInSeconds: 900,
      );

      expect(store.hasValidToken, isTrue);

      store.clear();

      expect(store.accessToken, isNull);
      expect(store.hasValidToken, isFalse);
      expect(store.isExpired, isTrue);
      expect(store.expiresAt, isNull);
    });
  });
}
