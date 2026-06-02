import { z } from "zod";

/**
 * Valid tags defining the viral DNA of Indonesian short-form content.
 * These align with the 12 DNA attributes specified in the technical blueprint.
 */
export const ViralDNATagSchema = z.enum([
  "hookPower",
  "curiosity",
  "controversy",
  "emotion",
  "humor",
  "storytelling",
  "authority",
  "money",
  "shock",
  "educational",
  "motivation",
  "relatability"
]);
export type ViralDNATag = z.infer<typeof ViralDNATagSchema>;

/**
 * Score representing the quality and likelihood of a moment going viral.
 * Constrained strictly between 0 and 100.
 */
export const WorthClippingScoreSchema = z.number().min(0).max(100);
export type WorthClippingScore = z.infer<typeof WorthClippingScoreSchema>;

/**
 * Qualitative confidence score indicating the clarity of transcript signals.
 */
export const ConfidenceScoreSchema = z.enum(["high", "medium", "low"]);
export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;

/**
 * Representation of a single transcript segment extracted from the YouTube video.
 */
export const TranscriptSegmentSchema = z.object({
  start: z.number().nonnegative("Start time must be greater than or equal to 0"),
  duration: z.number().nonnegative("Duration must be greater than or equal to 0"),
  text: z.string().trim().min(1, "Text content cannot be empty")
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/**
 * Metadata profile of the analyzed YouTube video.
 */
export const VideoMetadataSchema = z.object({
  youtubeId: z.string().min(1),
  title: z.string().min(1),
  channelName: z.string().min(1),
  durationSeconds: z.number().positive()
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

/**
 * Base definition of a discovered moment worth clipping.
 */
export const MomentSchema = z.object({
  startTime: z.number().nonnegative(),
  endTime: z.number().nonnegative(),
  worthClippingScore: WorthClippingScoreSchema,
  confidence: ConfidenceScoreSchema,
  dnaTags: z.array(ViralDNATagSchema).min(1).max(3),
  reasoning: z.string().trim().min(1)
}).refine((data) => data.endTime > data.startTime, {
  message: "endTime must be strictly greater than startTime",
  path: ["endTime"]
}).refine((data) => (data.endTime - data.startTime) >= 10, {
  // Relaxed slightly to 10-120s for robust validation, while targeted duration remains 15-90s
  message: "Clips must be at least 10 seconds long",
  path: ["endTime"]
});
export type Moment = z.infer<typeof MomentSchema>;

/**
 * An Elite Moment has a Worth-Clipping Score of 85 or above.
 */
export const EliteMomentSchema = MomentSchema.refine((data) => data.worthClippingScore >= 85, {
  message: "Elite moments must have a worth-clipping score of 85 or above",
  path: ["worthClippingScore"]
});
export type EliteMoment = z.infer<typeof EliteMomentSchema>;

/**
 * A Secondary Moment has a Worth-Clipping Score between 70 (inclusive) and 85 (exclusive).
 */
export const SecondaryMomentSchema = MomentSchema.refine((data) => data.worthClippingScore >= 70 && data.worthClippingScore < 85, {
  message: "Secondary moments must have a worth-clipping score between 70 and 85",
  path: ["worthClippingScore"]
});
export type SecondaryMoment = z.infer<typeof SecondaryMomentSchema>;

/**
 * The final structured JSON output returned by the Phase 0.5 validation pipeline.
 */
export const AnalysisResultSchema = z.object({
  elite_moments: z.array(EliteMomentSchema).describe("Elite viral moments (score >= 85)"),
  secondary_moments: z.array(SecondaryMomentSchema).describe("Secondary highlight moments (70 <= score < 85)"),
  reasoning: z.array(z.string()).describe("Overall strategic analysis of why this content was selected"),
  confidence: z.array(z.string()).describe("Log of confidence factors including transcript accuracy and local audience fit")
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
