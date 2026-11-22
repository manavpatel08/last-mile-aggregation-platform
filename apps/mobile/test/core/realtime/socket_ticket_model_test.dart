import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/models/socket_ticket_model.dart';

void main() {
  group('SocketTicketModel', () {
    group('valid payloads', () {
      test('parses valid ticket and positive integer expiry correctly', () {
        final json = {
          'ticket': 'c8b4e720-410a-4221-872c-d90048cb1512',
          'expiresIn': 60,
        };

        final model = SocketTicketModel.fromJson(json);

        expect(model.ticket, 'c8b4e720-410a-4221-872c-d90048cb1512');
        expect(model.expiresIn, 60);
        expect(model.toJson(), json);
      });

      test('trims surrounding whitespace from otherwise valid ticket', () {
        final json = {
          'ticket': '  valid-ticket-uuid  ',
          'expiresIn': 30,
        };

        final model = SocketTicketModel.fromJson(json);

        expect(model.ticket, 'valid-ticket-uuid');
        expect(model.expiresIn, 30);
      });
    });

    group('ticket validation failures', () {
      test('rejects missing ticket with FormatException', () {
        final json = {
          'expiresIn': 60,
        };

        expect(
          () => SocketTicketModel.fromJson(json),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('Missing required field "ticket"'),
            ),
          ),
        );
      });

      test('rejects null ticket with FormatException', () {
        final json = {
          'ticket': null,
          'expiresIn': 60,
        };

        expect(
          () => SocketTicketModel.fromJson(json),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('Field "ticket" cannot be null'),
            ),
          ),
        );
      });

      test('rejects empty ticket with FormatException', () {
        final json = {
          'ticket': '',
          'expiresIn': 60,
        };

        expect(
          () => SocketTicketModel.fromJson(json),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('cannot be empty or whitespace-only'),
            ),
          ),
        );
      });

      test('rejects whitespace-only ticket with FormatException', () {
        final json = {
          'ticket': '   \t\n  ',
          'expiresIn': 60,
        };

        expect(
          () => SocketTicketModel.fromJson(json),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('cannot be empty or whitespace-only'),
            ),
          ),
        );
      });

      test('rejects non-string ticket (int, bool, map) with FormatException', () {
        for (final invalidTicket in [12345, true, {'id': 'uuid'}]) {
          final json = {
            'ticket': invalidTicket,
            'expiresIn': 60,
          };

          expect(
            () => SocketTicketModel.fromJson(json),
            throwsA(
              isA<FormatException>().having(
                (e) => e.message,
                'message',
                contains('Field "ticket" must be a string'),
              ),
            ),
          );
        }
      });
    });

    group('expiresIn validation failures', () {
      test('rejects missing expiry with FormatException', () {
        final json = {
          'ticket': 'valid-ticket-uuid',
        };

        expect(
          () => SocketTicketModel.fromJson(json),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('Missing required field "expiresIn"'),
            ),
          ),
        );
      });

      test('rejects null expiry with FormatException', () {
        final json = {
          'ticket': 'valid-ticket-uuid',
          'expiresIn': null,
        };

        expect(
          () => SocketTicketModel.fromJson(json),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              contains('Field "expiresIn" cannot be null'),
            ),
          ),
        );
      });

      test('rejects non-numeric expiry with FormatException', () {
        for (final invalidExpiry in ['60', 'invalid', true, [60]]) {
          final json = {
            'ticket': 'valid-ticket-uuid',
            'expiresIn': invalidExpiry,
          };

          expect(
            () => SocketTicketModel.fromJson(json),
            throwsA(
              isA<FormatException>().having(
                (e) => e.message,
                'message',
                contains('Field "expiresIn" must be an integer'),
              ),
            ),
          );
        }
      });

      test('rejects fractional expiry with FormatException', () {
        for (final fractional in [60.5, 0.5, 1.0001]) {
          final json = {
            'ticket': 'valid-ticket-uuid',
            'expiresIn': fractional,
          };

          expect(
            () => SocketTicketModel.fromJson(json),
            throwsA(
              isA<FormatException>().having(
                (e) => e.message,
                'message',
                contains('Field "expiresIn" must be an integer'),
              ),
            ),
          );
        }
      });

      test('rejects zero and negative expiry with FormatException', () {
        for (final invalidExpiry in [0, -1, -60]) {
          final json = {
            'ticket': 'valid-ticket-uuid',
            'expiresIn': invalidExpiry,
          };

          expect(
            () => SocketTicketModel.fromJson(json),
            throwsA(
              isA<FormatException>().having(
                (e) => e.message,
                'message',
                contains('must be a positive integer'),
              ),
            ),
          );
        }
      });
    });
  });
}
