import 'package:flutter_test/flutter_test.dart';
import 'package:lastmile_mobile/core/realtime/models/socket_ticket_model.dart';

void main() {
  group('SocketTicketModel', () {
    test('parses valid json correctly', () {
      final json = {
        'ticket': 'c8b4e720-410a-4221-872c-d90048cb1512',
        'expiresIn': 60,
      };

      final model = SocketTicketModel.fromJson(json);

      expect(model.ticket, 'c8b4e720-410a-4221-872c-d90048cb1512');
      expect(model.expiresIn, 60);
      expect(model.toJson(), json);
    });

    test('handles missing or null expiresIn with default 60 seconds', () {
      final json = {
        'ticket': 'test-ticket-uuid',
      };

      final model = SocketTicketModel.fromJson(json);

      expect(model.ticket, 'test-ticket-uuid');
      expect(model.expiresIn, 60);
    });

    test('handles empty json with defaults', () {
      final model = SocketTicketModel.fromJson({});

      expect(model.ticket, '');
      expect(model.expiresIn, 60);
    });
  });
}
