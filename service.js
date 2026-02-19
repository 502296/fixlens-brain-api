async function transcribeAudio(audioBase64) {
  if (!audioBase64 || audioBase64.length < 50) return { text: "", ok: false };

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
          // KEY: ask for verbose + force “empty if no speech”
          response_format: "verbose_json",
          temperature: 0,
          prompt:
            "If there is no human speech in this audio (engine sound/noise only), return an empty transcript.",
        }),
        15000
      )
    );

    const text = String(result?.text || "").trim();

    // Heuristic: ignore non-speech audio (engine sound)
    // verbose_json usually has segments with no_speech_prob
    const segs = Array.isArray(result?.segments) ? result.segments : [];
    if (segs.length > 0) {
      const avgNoSpeech =
        segs.reduce((a, s) => a + Number(s?.no_speech_prob || 0), 0) / segs.length;

      // if mostly no speech => ignore transcript
      if (avgNoSpeech >= 0.6) return { text: "", ok: false };
    }

    // If transcript is tiny or looks useless, ignore it
    if (text.length < 3) return { text: "", ok: false };

    return { text, ok: true };
  } catch (err) {
    console.error("Audio Error:", err?.message);
    return { text: "", ok: false };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}
