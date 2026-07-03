/**
 * Hybrid Speaker System - Core Types
 */

export interface FaceDetection {
  frame: number;
  timestamp: number;
  bbox: [number, number, number, number];
  confidence: number;
  trackId?: number;
}

export interface FaceLandmark {
  frame: number;
  timestamp: number;
  landmarks: number[][]; // MediaPipe face mesh points
  lipMovement?: number;
  eyeOpenness?: number;
}

export interface SpeakerCandidate {
  id: string;
  faceDetections: FaceDetection[];
  embeddings: number[][];
  totalAppearTime: number;
}

export interface SpeakerTimeline {
  speakerId: string;
  segments: Array<{
    start: number;
    end: number;
    confidence: number;
  }>;
}