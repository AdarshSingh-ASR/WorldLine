import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import {
  chooseManeuver,
  deterministicVector,
  maneuvers,
} from "./invariants.mjs";

const rankSchema = z.object({
  maneuverId: z.enum(maneuvers.map((maneuver) => maneuver.id)),
  reason: z.string().min(8).max(400),
});

export class WorldlineProviders {
  constructor(config) {
    this.config = config;
    this.client = new BedrockRuntimeClient({ region: config.awsRegion });
  }

  async embedScenario(text) {
    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.config.embedModelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            inputText: text,
            dimensions: 1024,
            normalize: true,
          }),
        }),
      );
      const payload = JSON.parse(new TextDecoder().decode(response.body));
      if (!Array.isArray(payload.embedding) || payload.embedding.length !== 1024) {
        throw new Error("Unexpected embedding shape");
      }
      return { vector: payload.embedding, provider: "amazon-bedrock" };
    } catch (error) {
      if (process.env.WORLDLINE_PROVIDER_DIAGNOSTICS === "true") {
        console.error("WORLDLINE embedding provider fallback", error);
      }
      return { vector: deterministicVector(text), provider: "deterministic" };
    }
  }

  async rankManeuvers({ scenario, memories, memoryEnabled }) {
    const fallback = chooseManeuver({ memoryEnabled, memories });
    if (!memoryEnabled || memories.length === 0) {
      return { ...fallback, provider: "deterministic" };
    }

    const prompt = [
      "You are ranking pre-validated drone separation maneuvers.",
      "Choose exactly one candidate. Do not invent a maneuver.",
      `Scenario: ${JSON.stringify(scenario)}`,
      `Verified episodic memories: ${JSON.stringify(memories)}`,
      `Candidates: ${JSON.stringify(maneuvers)}`,
      'Return JSON only: {"maneuverId":"MANEUVER-03","reason":"..."}',
    ].join("\n");

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.config.bedrockModelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            messages: [{ role: "user", content: [{ text: prompt }] }],
            inferenceConfig: { maxTokens: 240, temperature: 0 },
          }),
        }),
      );
      const payload = JSON.parse(new TextDecoder().decode(response.body));
      const text =
        payload.output?.message?.content?.[0]?.text ??
        payload.content?.[0]?.text ??
        "";
      const parsed = rankSchema.parse(JSON.parse(text.replace(/^```json|```$/g, "").trim()));
      const selected = maneuvers.find((item) => item.id === parsed.maneuverId);
      return {
        ...selected,
        memoryId: memories[0].id,
        causalReason: parsed.reason,
        provider: "amazon-bedrock",
      };
    } catch (error) {
      if (process.env.WORLDLINE_PROVIDER_DIAGNOSTICS === "true") {
        console.error("WORLDLINE ranking provider fallback", error);
      }
      return { ...fallback, provider: "deterministic" };
    }
  }
}
