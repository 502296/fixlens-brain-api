import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

class FixLensMemory {
  static const _kRememberEnabled = 'fx_remember_vehicle_enabled';
  static const _kVehicleInfoJson = 'fx_vehicle_info_json';
  static const _kVehicleSavedAtMs = 'fx_vehicle_saved_at_ms';

  // ✅ 5 days
  static const Duration vehicleTtl = Duration(days: 5);

  /// Enable / disable remembering vehicle
  static Future<void> setRememberVehicleEnabled(bool enabled) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_kRememberEnabled, enabled);

    // If user turns it off -> delete immediately (privacy)
    if (!enabled) {
      await clearVehicleMemory();
    }
  }

  static Future<bool> isRememberVehicleEnabled() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_kRememberEnabled) ?? false;
  }

  /// Save vehicle info locally for 5 days
  /// vehicleInfo can be a String OR Map (we store JSON)
  static Future<void> saveVehicleInfo(dynamic vehicleInfo) async {
    final prefs = await SharedPreferences.getInstance();
    final enabled = prefs.getBool(_kRememberEnabled) ?? false;
    if (!enabled) return;

    final jsonStr = (vehicleInfo is String)
        ? jsonEncode({"vehicleInfo": vehicleInfo})
        : jsonEncode(vehicleInfo);

    await prefs.setString(_kVehicleInfoJson, jsonStr);
    await prefs.setInt(_kVehicleSavedAtMs, DateTime.now().millisecondsSinceEpoch);
  }

  /// Returns vehicle info if still valid, otherwise null
  static Future<String?> getVehicleInfoIfValid() async {
    final prefs = await SharedPreferences.getInstance();

    final enabled = prefs.getBool(_kRememberEnabled) ?? false;
    if (!enabled) return null;

    final savedAt = prefs.getInt(_kVehicleSavedAtMs);
    final raw = prefs.getString(_kVehicleInfoJson);

    if (savedAt == null || raw == null || raw.trim().isEmpty) return null;

    final savedTime = DateTime.fromMillisecondsSinceEpoch(savedAt);
    final age = DateTime.now().difference(savedTime);

    if (age > vehicleTtl) {
      // TTL expired -> clear silently
      await clearVehicleMemory();
      return null;
    }

    // If we stored {"vehicleInfo": "..."} return it as string
    try {
      final obj = jsonDecode(raw);
      if (obj is Map && obj['vehicleInfo'] is String) {
        return obj['vehicleInfo'] as String;
      }
      // If user stored a map, return a pretty one-line summary
      return _mapToOneLine(obj);
    } catch (_) {
      // Bad JSON -> clear to be safe
      await clearVehicleMemory();
      return null;
    }
  }

  static String _mapToOneLine(dynamic obj) {
    try {
      if (obj is Map) {
        // pick common fields if exist
        final year = obj['year']?.toString();
        final make = obj['make']?.toString();
        final model = obj['model']?.toString();
        final engine = obj['engine']?.toString();
        final parts = <String>[
          if (year != null && year.isNotEmpty) year,
          if (make != null && make.isNotEmpty) make,
          if (model != null && model.isNotEmpty) model,
          if (engine != null && engine.isNotEmpty) engine,
        ];
        if (parts.isNotEmpty) return parts.join(' ');
        return jsonEncode(obj);
      }
      return obj.toString();
    } catch (_) {
      return obj.toString();
    }
  }

  /// Clear only vehicle memory (button "Clear memory now")
  static Future<void> clearVehicleMemory() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kVehicleInfoJson);
    await prefs.remove(_kVehicleSavedAtMs);
  }
}
