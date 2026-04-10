import 'package:flutter/material.dart';

class FixLensDiagnosticCard extends StatelessWidget {
  final Map<String, dynamic>? diagnosticCard;
  final List<dynamic> symptomSignals;
  final List<dynamic> actionSteps;
  final Map<String, dynamic>? warningFlag;
  final Map<String, dynamic>? visualLabels;

  const FixLensDiagnosticCard({
    super.key,
    required this.diagnosticCard,
    required this.symptomSignals,
    required this.actionSteps,
    required this.warningFlag,
    required this.visualLabels,
  });

  @override
  Widget build(BuildContext context) {
    if (diagnosticCard == null &&
        symptomSignals.isEmpty &&
        actionSteps.isEmpty &&
        warningFlag == null) {
      return const SizedBox.shrink();
    }

    final labels = visualLabels ?? {};
    final likelyIssueLabel =
        (labels['likely_issue'] ?? 'Likely Issue').toString();
    final whatFixLensSeesLabel =
        (labels['what_fixlens_sees'] ?? 'What FixLens Sees').toString();
    final recommendedActionsLabel =
        (labels['recommended_actions'] ?? 'Recommended Actions').toString();
    final cautionLabel = (labels['caution'] ?? 'Caution').toString();

    final severity = (diagnosticCard?['severity'] ?? 'medium').toString();
    final severityLabel =
        (diagnosticCard?['severity_label'] ?? 'Medium Risk').toString();
    final confidenceLabel =
        (diagnosticCard?['confidence_label'] ?? 'Moderate Confidence')
            .toString();
    final title = (diagnosticCard?['title'] ?? '').toString();
    final summary = (diagnosticCard?['summary'] ?? '').toString();

    final palette = _paletteForSeverity(severity);

    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF0D1326),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: palette.border, width: 1.2),
        boxShadow: const [
          BoxShadow(
            blurRadius: 18,
            offset: Offset(0, 8),
            color: Color(0x22000000),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (diagnosticCard != null) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(
                color: palette.soft,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                likelyIssueLabel,
                style: TextStyle(
                  color: palette.strong,
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              title,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 22,
                height: 1.25,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _InfoBadge(
                  text: severityLabel,
                  background: palette.soft,
                  foreground: palette.strong,
                  icon: _severityIcon(severity),
                ),
                _InfoBadge(
                  text: confidenceLabel,
                  background: const Color(0xFF18233F),
                  foreground: const Color(0xFFC7D2FE),
                  icon: Icons.analytics_outlined,
                ),
              ],
            ),
            if (summary.isNotEmpty) ...[
              const SizedBox(height: 14),
              Text(
                summary,
                style: const TextStyle(
                  color: Color(0xFFD7E1FF),
                  fontSize: 15.5,
                  height: 1.45,
                ),
              ),
            ],
            const SizedBox(height: 16),
          ],
          if (symptomSignals.isNotEmpty) ...[
            _SectionTitle(
              title: whatFixLensSeesLabel,
              icon: Icons.visibility_outlined,
            ),
            const SizedBox(height: 10),
            ...symptomSignals.map((item) {
              final text = (item['text'] ?? '').toString();
              final iconName = (item['icon'] ?? 'signal').toString();
              return Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _SignalRow(
                  text: text,
                  icon: _signalIcon(iconName),
                ),
              );
            }),
            const SizedBox(height: 8),
          ],
          if (actionSteps.isNotEmpty) ...[
            _SectionTitle(
              title: recommendedActionsLabel,
              icon: Icons.check_circle_outline,
            ),
            const SizedBox(height: 10),
            ...actionSteps.map((item) {
              final step = item['step'];
              final text = (item['text'] ?? '').toString();
              return Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _ActionStepRow(
                  step: step is int ? step : int.tryParse('$step') ?? 0,
                  text: text,
                ),
              );
            }),
          ],
          if (warningFlag != null &&
              (warningFlag?['show'] == true ||
                  '${warningFlag?['show']}'.toLowerCase() == 'true')) ...[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF2A1F09),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: const Color(0xFFF4B942),
                  width: 1.1,
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 1),
                    child: Icon(
                      Icons.warning_amber_rounded,
                      color: Color(0xFFF4B942),
                      size: 22,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          cautionLabel,
                          style: const TextStyle(
                            color: Color(0xFFFFD978),
                            fontSize: 14,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          (warningFlag?['message'] ?? '').toString(),
                          style: const TextStyle(
                            color: Color(0xFFFFF4D6),
                            fontSize: 14.5,
                            height: 1.4,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  IconData _signalIcon(String name) {
    switch (name) {
      case 'temperature':
        return Icons.thermostat_outlined;
      case 'fan':
        return Icons.toys_outlined;
      case 'battery':
        return Icons.battery_charging_full_outlined;
      case 'oil':
        return Icons.opacity_outlined;
      case 'brake':
        return Icons.car_repair_outlined;
      case 'vibration':
        return Icons.graphic_eq;
      case 'warning':
        return Icons.warning_amber_rounded;
      default:
        return Icons.trip_origin;
    }
  }

  IconData _severityIcon(String severity) {
    switch (severity) {
      case 'high':
        return Icons.priority_high_rounded;
      case 'low':
        return Icons.verified_outlined;
      default:
        return Icons.warning_amber_rounded;
    }
  }

  _SeverityPalette _paletteForSeverity(String severity) {
    switch (severity) {
      case 'high':
        return const _SeverityPalette(
          soft: Color(0xFF3A1420),
          strong: Color(0xFFFF7A8A),
          border: Color(0x55FF7A8A),
        );
      case 'low':
        return const _SeverityPalette(
          soft: Color(0xFF132A22),
          strong: Color(0xFF69E2A0),
          border: Color(0x5569E2A0),
        );
      default:
        return const _SeverityPalette(
          soft: Color(0xFF2B2414),
          strong: Color(0xFFF4C86A),
          border: Color(0x55F4C86A),
        );
    }
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;
  final IconData icon;

  const _SectionTitle({
    required this.title,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, color: const Color(0xFF8FB3FF), size: 18),
        const SizedBox(width: 8),
        Text(
          title,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 16,
            fontWeight: FontWeight.w800,
          ),
        ),
      ],
    );
  }
}

class _InfoBadge extends StatelessWidget {
  final String text;
  final Color background;
  final Color foreground;
  final IconData icon;

  const _InfoBadge({
    required this.text,
    required this.background,
    required this.foreground,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: foreground),
          const SizedBox(width: 6),
          Text(
            text,
            style: TextStyle(
              color: foreground,
              fontSize: 13.3,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _SignalRow extends StatelessWidget {
  final String text;
  final IconData icon;

  const _SignalRow({
    required this.text,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF131B31),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: const Color(0xFF7FB0FF)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                color: Color(0xFFE5ECFF),
                fontSize: 14.5,
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionStepRow extends StatelessWidget {
  final int step;
  final String text;

  const _ActionStepRow({
    required this.step,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 27,
          height: 27,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: const Color(0xFF183056),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            step > 0 ? '$step' : '•',
            style: const TextStyle(
              color: Color(0xFFAEC8FF),
              fontWeight: FontWeight.w800,
              fontSize: 13,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text(
              text,
              style: const TextStyle(
                color: Color(0xFFEAF0FF),
                fontSize: 14.5,
                height: 1.42,
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SeverityPalette {
  final Color soft;
  final Color strong;
  final Color border;

  const _SeverityPalette({
    required this.soft,
    required this.strong,
    required this.border,
  });
}
