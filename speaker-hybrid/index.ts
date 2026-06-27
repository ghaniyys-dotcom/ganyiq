/**
 * Speaker Hybrid Module - Main Exports
 *
 * This module combines YOLOv8-face + MediaPipe Face Mesh
 * for high-quality speaker identification and dynamic split decisions.
 */

// Core
export * from './core/types';
export { detectFacesInFrame, trackFaces, processVideoFaces, defaultYoloConfig } from './core/face-detection';
export { extractFaceLandmarks, calculateLipMovement, detectEyeState, defaultMediaPipeConfig } from './core/face-landmark';

// Identification
export { clusterFaces, mergeSpeakers, defaultClusteringConfig } from './identification/speaker-clustering';
export { matchAudioWithVisual } from './identification/audio-visual-matcher';

// Reaction
export { detectReaction, defaultReactionConfig } from './reaction/reaction-detector';

// Split Decision
export { decideSplit, defaultSplitConfig } from './split/split-decision-engine';

// Main Orchestrator (to be implemented)
export { identifySpeakers } from './identification/speaker-identifier';