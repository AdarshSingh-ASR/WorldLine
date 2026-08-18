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

function parseRankResponse(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const json = cleaned.match(/\{[\s\S]*?\}/)?.[0] ?? cleaned;
  return rankSchema.parse(JSON.parse(json));
}

export class WorldlineProviders {
  constructor(config) {
    this.config = config;
    this.client = new BedrockRuntimeClient({ region: config.bedrockRegion });
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

    const memory = memories[0];
    const prompt = [
      "Choose one pre-validated drone separation maneuver.",
      "A recalled verified-safe episode must causally influence the choice.",
      `Scenario: ${scenario.description}`,
      `Recalled episode: id=${memory.id}; maneuver=${memory.maneuverId}; outcome=${memory.outcome}; similarity=${Number(memory.similarity).toFixed(2)}.`,
      `Allowed candidates: ${maneuvers.map((candidate) => `${candidate.id} (${candidate.label})`).join("; ")}.`,
      'Return exactly one single-line JSON object, with no markdown or extra text: {"maneuverId":"MANEUVER-03","reason":"short reason without quotation marks"}',
    ].join("\n");

    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.config.bedrockModelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            messages: [{ role: "user", content: [{ text: prompt }] }],
            inferenceConfig: { maxTokens: 120, temperature: 0 },
          }),
        }),
      );
      const payload = JSON.parse(new TextDecoder().decode(response.body));
      const text =
        payload.output?.message?.content?.[0]?.text ??
        payload.content?.[0]?.text ??
        "";
      const parsed = parseRankResponse(text);
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
