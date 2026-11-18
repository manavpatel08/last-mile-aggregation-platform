import 'auth_user.dart';

/// Representation of successful Google OAuth authentication payload from backend.
class AuthSession {
  const AuthSession({
    required this.user,
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
  });

  factory AuthSession.fromJson(Map<String, dynamic> json) {
    return AuthSession(
      user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
      expiresIn: json['expiresIn'] as int,
    );
  }

  final AuthUser user;
  final String accessToken;
  final String refreshToken;
  final int expiresIn;

  Map<String, dynamic> toJson() => {
        'user': user.toJson(),
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'expiresIn': expiresIn,
      };
}

/// Representation of session rotation payload from `POST /auth/refresh`.
///
/// Note: Per backend API contract, `/auth/refresh` returns only `{ accessToken, refreshToken, expiresIn }`.
class RefreshSessionResult {
  const RefreshSessionResult({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresIn,
  });

  factory RefreshSessionResult.fromJson(Map<String, dynamic> json) {
    return RefreshSessionResult(
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
      expiresIn: json['expiresIn'] as int,
    );
  }

  final String accessToken;
  final String refreshToken;
  final int expiresIn;

  Map<String, dynamic> toJson() => {
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'expiresIn': expiresIn,
      };
}
