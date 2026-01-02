export async function diagnoseText({ text, language }) {
  // حالياً من دون OpenAI حتى نثبت الاستقرار
  // (نرجعه بعدين خطوة بخطوة)

  return {
    language,
    summary:
      "Based on the symptom you described, the most common causes are worn suspension or drivetrain components. Further inspection is recommended.",
    confidence: "medium",
  };
}
