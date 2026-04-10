class FixLensResponse {
  final String reply;
  final Map<String, dynamic>? diagnosticCard;
  final List<dynamic> symptomSignals;
  final List<dynamic> actionSteps;
  final Map<String, dynamic>? warningFlag;
  final Map<String, dynamic>? visualLabels;

  FixLensResponse({
    required this.reply,
    required this.diagnosticCard,
    required this.symptomSignals,
    required this.actionSteps,
    required this.warningFlag,
    required this.visualLabels,
  });

  factory FixLensResponse.fromJson(Map<String, dynamic> json) {
    return FixLensResponse(
      reply: (json['reply'] ?? '').toString(),
      diagnosticCard: json['diagnostic_card'] is Map<String, dynamic>
          ? json['diagnostic_card'] as Map<String, dynamic>
          : null,
      symptomSignals: json['symptom_signals'] is List
          ? List<dynamic>.from(json['symptom_signals'])
          : [],
      actionSteps: json['action_steps'] is List
          ? List<dynamic>.from(json['action_steps'])
          : [],
      warningFlag: json['warning_flag'] is Map<String, dynamic>
          ? json['warning_flag'] as Map<String, dynamic>
          : null,
      visualLabels: json['visual_labels'] is Map<String, dynamic>
          ? json['visual_labels'] as Map<String, dynamic>
          : null,
    );
  }
}
