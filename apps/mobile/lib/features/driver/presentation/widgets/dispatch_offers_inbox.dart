import 'package:material_ui/material_ui.dart';

import '../../../../core/theme/app_colors.dart';
import '../models/dispatch_offer_item.dart';
import 'dispatch_offer_card.dart';

/// Reusable driver dispatch offers inbox section.
///
/// In Phase 1 production, this section is presented in the [DispatchInboxState.disconnected]
/// state because the backend dispatch engine (Stage 6) is not yet available.
///
/// Other states ([DispatchInboxState.loading], [DispatchInboxState.empty],
/// [DispatchInboxState.error], and [DispatchInboxState.ready]) are supported
/// for testing and ready for future API integration.
class DispatchOffersInbox extends StatelessWidget {
  const DispatchOffersInbox({
    super.key,
    this.state = DispatchInboxState.disconnected,
    this.offers = const [],
    this.errorMessage,
    this.onRetry,
    this.onAcceptOffer,
    this.onRejectOffer,
    this.unresolvedOfferId,
    this.onRetryAccept,
  });

  /// The current presentation state of the dispatch inbox.
  final DispatchInboxState state;

  /// List of offers to display when [state] is [DispatchInboxState.ready].
  final List<DispatchOfferItem> offers;

  /// Error message displayed when [state] is [DispatchInboxState.error].
  final String? errorMessage;

  /// Retry callback triggered when [state] is [DispatchInboxState.error].
  final VoidCallback? onRetry;

  /// Callback when driver accepts an offer.
  final ValueChanged<String>? onAcceptOffer;

  /// Callback when driver declines an offer.
  final ValueChanged<String>? onRejectOffer;

  /// Optional offer ID whose acceptance was attempted but remains unconfirmed.
  final String? unresolvedOfferId;

  /// Optional callback to retry accepting the unresolved offer.
  final ValueChanged<String>? onRetryAccept;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'Dispatch Offers',
              style: textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            if (state == DispatchInboxState.ready && offers.isNotEmpty) ...[
              Container(
                key: const Key('driver_offers_count_badge'),
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 3,
                ),
                decoration: BoxDecoration(
                  color: AppColors.primaryContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '${offers.length} active',
                  style: textTheme.bodySmall?.copyWith(
                    color: AppColors.onPrimaryContainer,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ] else if (state == DispatchInboxState.disconnected) ...[
              Container(
                key: const Key('driver_offers_disconnected_badge'),
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 3,
                ),
                decoration: BoxDecoration(
                  color: AppColors.textSecondary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  'Not Connected',
                  style: textTheme.bodySmall?.copyWith(
                    color: AppColors.textSecondary,
                    fontWeight: FontWeight.bold,
                    fontSize: 11,
                  ),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 12),
        _buildContent(context),
      ],
    );
  }

  Widget _buildContent(BuildContext context) {
    if (unresolvedOfferId != null && !offers.any((o) => o.id == unresolvedOfferId)) {
      return _buildUnresolvedCard(context);
    }

    final textTheme = Theme.of(context).textTheme;

    switch (state) {
      case DispatchInboxState.disconnected:
        return Card(
          key: const Key('driver_offers_disconnected_card'),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: AppColors.border),
          ),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.secondary.withValues(alpha: 0.1),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.cloud_off_outlined,
                    color: AppColors.secondary,
                    size: 24,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Dispatch Offers Not Connected',
                        style: textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Real-time dispatch offers will appear here once the backend dispatch engine (Stage 6) is connected. Dispatch offers are not connected yet.',
                        style: textTheme.bodySmall?.copyWith(
                          color: AppColors.textSecondary,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );

      case DispatchInboxState.loading:
        return Card(
          key: const Key('driver_offers_loading_card'),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: AppColors.border),
          ),
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 32, horizontal: 16),
            child: Center(
              child: Column(
                children: [
                  SizedBox(
                    width: 28,
                    height: 28,
                    child: CircularProgressIndicator(strokeWidth: 2.5),
                  ),
                  SizedBox(height: 12),
                  Text(
                    'Checking for dispatch offers...',
                    key: Key('driver_offers_loading_text'),
                  ),
                ],
              ),
            ),
          ),
        );

      case DispatchInboxState.empty:
        return Card(
          key: const Key('driver_offers_empty_card'),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
            side: const BorderSide(color: AppColors.border),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 16),
            child: Center(
              child: Column(
                children: [
                  const Icon(
                    Icons.inbox_outlined,
                    size: 40,
                    color: AppColors.textSecondary,
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'No Pending Offers',
                    style: textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'No pending offers right now.',
                    textAlign: TextAlign.center,
                    style: textTheme.bodySmall?.copyWith(
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );

      case DispatchInboxState.error:
        return Container(
          key: const Key('driver_offers_error_card'),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.error.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: AppColors.error.withValues(alpha: 0.35),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.error_outline,
                    color: AppColors.error,
                    size: 20,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Failed to load dispatch offers',
                      style: textTheme.titleSmall?.copyWith(
                        color: AppColors.error,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                errorMessage ?? 'A server error occurred while retrieving offers.',
                style: textTheme.bodySmall?.copyWith(
                  color: AppColors.textPrimary,
                ),
              ),
              if (onRetry != null) ...[
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  key: const Key('driver_offers_retry_button'),
                  onPressed: onRetry,
                  icon: const Icon(Icons.refresh, size: 16),
                  label: const Text('Retry'),
                ),
              ],
            ],
          ),
        );

      case DispatchInboxState.ready:
        if (offers.isEmpty) {
          return Card(
            key: const Key('driver_offers_empty_card'),
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: const BorderSide(color: AppColors.border),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 16),
              child: Center(
                child: Column(
                  children: [
                    const Icon(
                      Icons.inbox_outlined,
                      size: 40,
                      color: AppColors.textSecondary,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'No Pending Offers',
                      style: textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'No pending offers right now.',
                      textAlign: TextAlign.center,
                      style: textTheme.bodySmall?.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        }

        return Column(
          key: const Key('driver_offers_list'),
          children: offers
              .map(
                (offer) => DispatchOfferCard(
                  offer: offer,
                  onAccept: onAcceptOffer,
                  onReject: onRejectOffer,
                ),
              )
              .toList(),
        );
    }
  }

  Widget _buildUnresolvedCard(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Card(
      key: const Key('driver_offers_unresolved_card'),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: AppColors.warning.withValues(alpha: 0.5)),
      ),
      color: AppColors.warning.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.sync_problem_outlined,
                  color: AppColors.warning,
                  size: 22,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Offer Acceptance Pending Confirmation',
                    style: textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              errorMessage ??
                  'Acceptance outcome could not be confirmed. Please check your network and retry.',
              style: textTheme.bodySmall?.copyWith(
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              key: const Key('driver_offers_retry_accept_button'),
              onPressed: () {
                final handler = onRetryAccept ?? onAcceptOffer;
                handler?.call(unresolvedOfferId!);
              },
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Retry Acceptance'),
            ),
          ],
        ),
      ),
    );
  }
}
