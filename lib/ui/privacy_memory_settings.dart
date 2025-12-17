import 'package:flutter/material.dart';
import '../memory/fixlens_memory.dart';

class PrivacyMemorySettings extends StatefulWidget {
  const PrivacyMemorySettings({super.key});

  @override
  State<PrivacyMemorySettings> createState() => _PrivacyMemorySettingsState();
}

class _PrivacyMemorySettingsState extends State<PrivacyMemorySettings> {
  bool _enabled = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final e = await FixLensMemory.isRememberVehicleEnabled();
    if (!mounted) return;
    setState(() {
      _enabled = e;
      _loading = false;
    });
  }

  Future<void> _toggle(bool v) async {
    setState(() => _enabled = v);
    await FixLensMemory.setRememberVehicleEnabled(v);

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          v ? "Vehicle memory enabled (5 days)." : "Vehicle memory disabled and cleared.",
        ),
      ),
    );
  }

  Future<void> _clearNow() async {
    await FixLensMemory.clearVehicleMemory();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("Vehicle memory cleared on this device.")),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text("Privacy & Memory"),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            "FixLens stores vehicle info only on this device to improve diagnosis. "
            "No accounts. No cloud storage. No tracking.",
            style: TextStyle(fontSize: 13),
          ),
          const SizedBox(height: 14),

          Card(
            child: Column(
              children: [
                SwitchListTile(
                  title: const Text("Remember my vehicle for 5 days"),
                  subtitle: const Text(
                    "Helps FixLens provide better diagnosis on this device.",
                  ),
                  value: _enabled,
                  onChanged: _toggle,
                ),
                const Divider(height: 1),
                ListTile(
                  title: const Text("Clear memory now"),
                  subtitle: const Text("Deletes saved vehicle info from this device."),
                  trailing: const Icon(Icons.delete_outline),
                  onTap: _clearNow,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
