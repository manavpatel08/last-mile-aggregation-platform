import 'package:material_ui/material_ui.dart';

import '../../../../core/theme/app_colors.dart';
import '../models/dispatch_offer_item.dart';

/// Reusable card component presenting a single ride group dispatch offer.
///
/// Supports full presentation state lifecycle: active/pending, expired/stale,
/// and in-flight action pending (`accepting` or `declining`).
class DispatchOfferCard extends StatelessWidget {
  DispatchOfferCard({
    Key? key,
    required this.offer,
    this.onAccept,
    this.onReject,
  }) : super(key: key ?? Key('dispatch_offer_card_${offer.id}'));

  /// The offer presentation model to display.
  final DispatchOfferItem offer;

  /// Callback when the driver taps Accept on an active offer.
  final ValueChanged<String>? onAccept;

  /// Callback when the driver taps Decline on an active offer.
  final ValueChanged<String>? onReject;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final isExpired = offer.isExpired;
    final isActionPending = offer.isActionPending;

    final Color badgeBg;
    final Color badgeFg;
    final String badgeLabel;

    if (isExpired) {
      badgeBg = AppColors.error.withValues(alpha: 0.12);
      badgeFg = AppColors.error;
      badgeLabel = 'Expired';
    } else if (offer.status == DispatchOfferStatus.accepting) {
      badgeBg = AppColors.primaryContainer;
      badgeFg = AppColors.onPrimaryContainer;
      badgeLabel = 'Accepting...';
    } else if (offer.status == DispatchOfferStatus.declining) {
      badgeBg = AppColors.error.withValues(alpha: 0.12);
      badgeFg = AppColors.error;
      badgeLabel = 'Declining...';
    } else {
      badgeBg = AppColors.warning.withValues(alpha: 0.15);
      badgeFg = AppColors.warning;
      badgeLabel = 'Pending';
    }

    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
          color: isExpired
              ? AppColors.border
              : AppColors.primary.withValues(alpha: 0.4),
          width: isExpired ? 1.0 : 1.5,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Top Row: Offer badge & Status
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(6),
                        decoration: BoxDecoration(
                          color: AppColors.primaryContainer,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Icon(
                          Icons.electric_rickshaw,
                          color: AppColors.primary,
                          size: 16,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          offer.groupId != null
                              ? 'Offer #${offer.id} • Group #${offer.groupId}'
                              : 'Offer #${offer.id}',
                          key: Key('dispatch_offer_title_${offer.id}'),
                          style: textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  key: Key('dispatch_offer_status_${offer.id}'),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: badgeBg,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    badgeLabel,
                    style: textTheme.bodySmall?.copyWith(
                      color: badgeFg,
                      fontWeight: FontWeight.bold,
                      fontSize: 11,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),

            // Route: Pickup and Dropoff
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: const BoxDecoration(
                        color: AppColors.success,
                        shape: BoxShape.circle,
                      ),
                    ),
                    Container(
                      width: 2,
                      height: 24,
                      color: AppColors.border,
                    ),
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: AppColors.error,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ],
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        offer.pickupLocationName,
                        style: textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: AppColors.textPrimary,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 14),
                      Text(
                        offer.dropoffLocationName,
                        style: textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: AppColors.textPrimary,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const Divider(height: 24),

            // Metadata Row: Passengers, Distance, Detour, Fare
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Wrap(
                    spacing: 12,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.people_outline,
                            size: 16,
                            color: AppColors.textSecondary,
                          ),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              '${offer.passengerCount} riders',
                              key: Key('dispatch_offer_passengers_${offer.id}'),
                              style: textTheme.bodySmall?.copyWith(
                                color: AppColors.textSecondary,
                                fontWeight: FontWeight.w500,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                      if (offer.estimatedDistance != null)
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              Icons.straighten_outlined,
                              size: 16,
                              color: AppColors.textSecondary,
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                offer.estimatedDistance!,
                                style: textTheme.bodySmall?.copyWith(
                                  color: AppColors.textSecondary,
                                  fontWeight: FontWeight.w500,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      if (offer.detourPercentage != null)
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(
                              Icons.alt_route_outlined,
                              size: 16,
                              color: AppColors.textSecondary,
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                '+${offer.detourPercentage}% detour',
                                style: textTheme.bodySmall?.copyWith(
                                  color: AppColors.textSecondary,
                                  fontWeight: FontWeight.w500,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  offer.estimatedEarnings,
                  key: Key('dispatch_offer_earnings_${offer.id}'),
                  style: textTheme.titleMedium?.copyWith(
                    color: AppColors.primary,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),

            // Action Buttons
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: Key('dispatch_offer_reject_button_${offer.id}'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.error,
                      side: BorderSide(
                        color: (isExpired || isActionPending || onReject == null)
                            ? AppColors.border
                            : AppColors.error.withValues(alpha: 0.5),
                      ),
                      padding: const EdgeInsets.symmetric(
                        vertical: 12,
                        horizontal: 6,
                      ),
                    ),
                    onPressed: (isExpired || isActionPending || onReject == null)
                        ? null
                        : () => onReject?.call(offer.id),
                    child: offer.status == DispatchOfferStatus.declining
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: AppColors.error,
                            ),
                          )
                        : const FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Text('Decline'),
                          ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton(
                    key: Key('dispatch_offer_accept_button_${offer.id}'),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(
                        vertical: 12,
                        horizontal: 6,
                      ),
                    ),
                    onPressed: (isExpired || isActionPending || onAccept == null)
                        ? null
                        : () => onAccept?.call(offer.id),
                    child: offer.status == DispatchOfferStatus.accepting
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Text('Accept Offer'),
                          ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
