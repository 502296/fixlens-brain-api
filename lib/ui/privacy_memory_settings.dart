// lib/ui/privacy_memory_settings.dart
import 'package:flutter/material.dart';

class PrivacyMemorySettings extends StatefulWidget {
  PrivacyMemorySettings({super.key});

  @override
  State<PrivacyMemorySettings> createState() => _PrivacyMemorySettingsState();
}

class _PrivacyMemorySettingsState extends State<PrivacyMemorySettings> {
  bool _vehicleMemoryEnabled = true;
  bool _allowImages = true;
  bool _allowAudio = true;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF050712),
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: const Text(
          'Privacy & Memory',
          style: TextStyle(color: Colors.white),
        ),
        iconTheme: const IconThemeData(color: Colors.white),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _sectionTitle('Vehicle Memory'),
          _card(
            child: Column(
              children: [
                SwitchListTile(
                  value: _vehicleMemoryEnabled,
                  onChanged: (v) => setState(() => _vehicleMemoryEnabled = v),
                  activeColor: Colors.cyanAccent,
                  title: const Text(
                    'Enable vehicle memory (5 days)',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: const Text(
                    'Stored locally on your device only.',
                    style: TextStyle(color: Colors.white54),
                  ),
                ),
                const Divider(color: Colors.white12),
                ListTile(
                  leading: const Icon(Icons.delete_outline, color: Colors.cyanAccent),
                  title: const Text(
                    'Clear saved memory now',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: const Text(
                    'This removes local saved context.',
                    style: TextStyle(color: Colors.white54),
                  ),
                  onTap: () => _confirmClear(),
                ),
              ],
            ),
          ),

          const SizedBox(height: 16),
          _sectionTitle('Permissions'),
          _card(
            child: Column(
              children: [
                SwitchListTile(
                  value: _allowImages,
                  onChanged: (v) => setState(() => _allowImages = v),
                  activeColor: Colors.cyanAccent,
                  title: const Text(
                    'Allow image diagnosis',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: const Text(
                    'You can turn this off anytime.',
                    style: TextStyle(color: Colors.white54),
                  ),
                ),
                SwitchListTile(
                  value: _allowAudio,
                  onChanged: (v) => setState(() => _allowAudio = v),
                  activeColor: Colors.cyanAccent,
                  title: const Text(
                    'Allow audio diagnosis',
                    style: TextStyle(color: Colors.white),
                  ),
                  subtitle: const Text(
                    'You can turn this off anytime.',
                    style: TextStyle(color: Colors.white54),
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 16),
          _sectionTitle('Notes'),
          const Text(
            'FixLens uses your inputs to generate a diagnosis. You control what you share.\n\n(We can later connect these toggles to real storage using SharedPreferences if you want.)',
            style: TextStyle(color: Colors.white70, fontSize: 14),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(
          t,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
        ),
      );

  Widget _card({required Widget child}) => Container(
        decoration: BoxDecoration(
          color: const Color(0xFF0B1022),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Colors.white12),
        ),
        child: child,
      );

  Future<void> _confirmClear() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0B1022),
        title: const Text('Clear memory?', style: TextStyle(color: Colors.white)),
        content: const Text(
          'This will remove saved local memory.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: Colors.white70)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Clear', style: TextStyle(color: Colors.cyanAccent)),
          ),
        ],
      ),
    );

    if (ok == true) {
      // حالياً مجرد واجهة - نربطها لاحقاً بالتخزين الحقيقي
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Local memory cleared.')),
      );
    }
  }
}
