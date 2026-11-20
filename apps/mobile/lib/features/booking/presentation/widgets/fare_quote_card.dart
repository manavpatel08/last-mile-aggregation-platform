import 'package:material_ui/material_ui.dart';

import '../../../../core/theme/app_colors.dart';
import '../../models/fare_quote.dart';

/// Card presenting the authoritative 2-minute binding fare quote details
/// including private vs shared range, fare ceiling, distance, duration, and live countdown.
class FareQuoteCard extends StatelessWidget {
  const FareQuoteCard({
    super.key,
    required this.fareQuote,
    required this.remainingDuration,
    required this.isExpired,
    required this.onRefreshQuote,
    this.isRefreshing = false,
  });

  final FareQuote fareQuote;
  final Duration remainingDuration;
  final bool isExpired;
  final VoidCallback onRefreshQuote;
  final bool isRefreshing;

  String _formatDuration(Duration d) {
    final minutes = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$minutes:$seconds';
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final km = (fareQuote.directDistanceMeters / 1000).toStringAsFixed(1);
    final mins = (fareQuote.directDurationSec / 60).ceil();

    return Card(
      key: const Key('fare_quote_card'),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(
          color: isExpired
              ? AppColors.error
              : AppColors.primary.withValues(alpha: 0.3),
          width: isExpired ? 1.5 : 1,
        ),
      ),
      color: isExpired
          ? AppColors.error.withValues(alpha: 0.05)
          : AppColors.primaryContainer.withValues(alpha: 0.3),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.receipt_outlined,
                      color: AppColors.primary,
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      'Fare Quote (Tariff v${fareQuote.tariffVersion})',
                      style: textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: AppColors.textPrimary,
                      ),
                    ),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: isExpired
                        ? AppColors.error.withValues(alpha: 0.15)
                        : AppColors.primary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        isExpired
                            ? Icons.timer_off_outlined
                            : Icons.timer_outlined,
                        size: 14,
                        color: isExpired ? AppColors.error : AppColors.primary,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        isExpired
                            ? 'Expired'
                            : _formatDuration(remainingDuration),
                        key: const Key('quote_countdown_text'),
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color:
                              isExpired ? AppColors.error : AppColors.primary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: _FareColumn(
                    label: 'Shared Range',
                    value:
                        '₹${fareQuote.sharedEstimatedRange.minFare} – ₹${fareQuote.sharedEstimatedRange.maxFare}',
                    isPrimary: true,
                  ),
                ),
                Container(
                  height: 36,
                  width: 1,
                  color: AppColors.border,
                ),
                Expanded(
                  child: _FareColumn(
                    label: 'Private Fare',
                    value: '₹${fareQuote.privateEstimatedFare}',
                    isPrimary: false,
                  ),
                ),
                Container(
                  height: 36,
                  width: 1,
                  color: AppColors.border,
                ),
                Expanded(
                  child: _FareColumn(
                    label: 'Agreed Ceiling',
                    value: '₹${fareQuote.agreedFareCeiling}',
                    isPrimary: false,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            const Divider(height: 1),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.straighten,
                      size: 16,
                      color: AppColors.textSecondary,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '$km km',
                      style: textTheme.bodySmall?.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Icon(
                      Icons.access_time,
                      size: 16,
                      color: AppColors.textSecondary,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '~$mins min direct',
                      style: textTheme.bodySmall?.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
                if (isExpired)
                  TextButton.icon(
                    key: const Key('refresh_quote_button'),
                    onPressed: isRefreshing ? null : onRefreshQuote,
                    icon: isRefreshing
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.refresh, size: 16),
                    label: const Text('Refresh Quote'),
                  ),
              ],
            ),
            if (isExpired) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Text(
                  'Quote expired after 2 minutes. Please refresh before booking.',
                  key: Key('quote_expired_banner'),
                  style: TextStyle(
                    color: AppColors.error,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _FareColumn extends StatelessWidget {
  const _FareColumn({
    required this.label,
    required this.value,
    required this.isPrimary,
  });

  final String label;
  final String value;
  final bool isPrimary;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 11,
            color: AppColors.textSecondary,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: TextStyle(
            fontSize: isPrimary ? 15 : 14,
            fontWeight: isPrimary ? FontWeight.bold : FontWeight.w600,
            color: isPrimary ? AppColors.primary : AppColors.textPrimary,
          ),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}
