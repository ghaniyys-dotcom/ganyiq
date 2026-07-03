/**
 * Face Detection Module using YOLOv8-face
 *
 * This is the core visual detection component of the Hybrid Speaker system.
 * It detects faces, tracks them across frames, and prepares data for speaker clustering.
 */

import { existsSync } from 'fs';
import type { FaceDetection } from './types';

export interface YoloFaceConfig {
  modelPath: string;
  confidenceThreshold: number;
  iouThreshold: number;
  maxFaces: number;
  device: 'cpu' | 'cuda' | 'amd';
  enableTracking: boolean;
}

export const defaultYoloConfig: YoloFaceConfig = {
  modelPath: 'models/yolov8n-face.onnx',
  confidenceThreshold: 0.55,
  iouThreshold: 0.45,
  maxFaces: 12,
  device: 'amd',
  enableTracking: true
};

let isModelLoaded = false;

/**
 * Load YOLOv8-face model (ONNX)
 */
async function loadYoloModel(config: YoloFaceConfig): Promise<void> {
  if (isModelLoaded) return;

  if (!existsSync(config.modelPath)) {
    throw new Error(`[YOLOv8-face] Model not found: ${config.modelPath}`);
  }

  console.log(`[YOLOv8-face] Loading model on ${config.device}...`);
  // TODO: Load model using onnxruntime-node
  isModelLoaded = true;
}

/**
 * Detect faces in a single frame
 */
export async function detectFacesInFrame(
  frame: Buffer,
  config: Partial<YoloFaceConfig> = {}
): Promise<FaceDetection[]> {
  const cfg = { ...defaultYoloConfig, ...config };
  await loadYoloModel(cfg);

  // TODO: Actual inference here
  // For now returning placeholder
  return [];
}

/**
 * Track faces across frames using simple IoU matching
 */
export function trackFaces(
  current: FaceDetection[],
  previous: FaceDetection[],
  iouThreshold = 0.4
): FaceDetection[] {
  if (!previous.length) {
    return current.map((det, idx) => ({ ...det, trackId: idx }));
  }

  const result: FaceDetection[] = [];
  const used = new Set<number>();

  for (const curr of current) {
    let bestPrev: FaceDetection | null = null;
    let bestScore = 0;

    previous.forEach((prev, idx) => {
      if (used.has(idx)) return;
      const iou = calculateIoU(curr.bbox, prev.bbox);
      if (iou > bestScore && iou >= iouThreshold) {
        bestScore = iou;
        bestPrev = prev;
      }
    });

    if (bestPrev) {
      result.push({ ...curr, trackId: bestPrev.trackId });
      used.add(previous.indexOf(bestPrev));
    } else {
      result.push({ ...curr, trackId: Date.now() + result.length });
    }
  }

  return result;
}

function calculateIoU(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;

  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);

  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = aw * ah + bw * bh - inter;

  return union > 0 ? inter / union : 0;
}