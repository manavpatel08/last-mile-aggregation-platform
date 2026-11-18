import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/storage/secure_token_storage.dart';

void main() {
  group('SecureTokenStorage (inMemory)', () {
    test('starts empty when initialized without initial data', () async {
      final storage = SecureTokenStorage.inMemory();
      final token = await storage.getRefreshToken();
      expect(token, isNull);
    });

    test('persists and retrieves refresh token', () async {
      final storage = SecureTokenStorage.inMemory();
      await storage.saveRefreshToken('sample-refresh-token-xyz');

      final token = await storage.getRefreshToken();
      expect(token, 'sample-refresh-token-xyz');
    });

    test('deletes refresh token on single-device logout', () async {
      final storage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'token-to-delete',
      });

      expect(await storage.getRefreshToken(), 'token-to-delete');

      await storage.deleteRefreshToken();
      expect(await storage.getRefreshToken(), isNull);
    });

    test('clearAll wipes all stored data', () async {
      final storage = SecureTokenStorage.inMemory({
        SecureTokenStorage.refreshTokenKey: 'token-1',
        'extra_key': 'extra_val',
      });

      await storage.clearAll();
      expect(await storage.getRefreshToken(), isNull);
    });
  });
}
