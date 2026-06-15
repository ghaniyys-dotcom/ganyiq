# OpusClip Architecture Reconstruction — EVIDENCE-BASED

## The WASM Engine: AVEditorEngine

**File:** `AVEditorEngine-20260604-09125d5a.wasm.gz` (5.96MB compressed, 21MB uncompressed)  
**Evidence:** Downloaded from `public.cdn.opus.pro/clip-web/wasm/`  
**Confidence:** HIGH

### Core Architecture

OpusClip uses a **Non-Linear Editor (NLE) compositing engine**, NOT ffmpeg filter graphs.

```
┌─────────────────────────────────────────────────────────┐
│                   AVEditTimeline                        │
│  (Timeline-based compositor — like Premiere Pro)       │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Layer 1  │  │ Layer 2  │  │ Layer 3  │  ...         │
│  │ (Video)  │  │ (Crop)   │  │ (Subs)   │              │
│  │ Z-index  │  │ Z-index  │  │ Z-index  │              │
│  │ Scale    │  │ Scale    │  │ Position │              │
│  │ Position │  │ Position │  │ Opacity  │              │
│  │ Rotation │  │ Rotation │  │ Font     │              │
│  │ Opacity  │  │ Opacity  │  │ Color    │              │
│  └──────────┘  └──────────┘  └──────────┘              │
│                                                         │
│  RenderByTime(timestamp, width, height) → Frame         │
└─────────────────────────────────────────────────────────┘
```

### Evidence from WASM Strings

| Finding | String Evidence | Implication |
|---------|----------------|-------------|
| **Layer Compositing** | `OpusClip::OpusLayer`, `GetZIndex()` | Multiple layers with Z-ordering |
| **Per-Layer Transforms** | `SetPositionByLayer`, `SetScaleByLayer`, `SetOpacityByLayer`, `SetRotationByLayer` | Each layer independently positioned/scaled/rotated |
| **Timeline Engine** | `AVEditTimeline::RenderByTime`, `Seek`, `SetPlaying`, `RemoveAllTracks` | Frame-accurate timeline rendering |
| **Segment Transitions** | `ApplyLayerBoundaryFade` | Fade transitions at layer boundaries |
| **Effect System** | `OpusEffect`, `OpusEffectTL`, `OpusEffectInfo`, `GetZIndex()` | Per-layer effects with timeline |
| **Keyframes** | `OpusClip::KeyFrame`, `GetSonType()` | Keyframe-based animation |
| **FFmpeg Decoder** | `OpusClip::FFDecoder`, `DecoderPool::Instance()` | Uses FFmpeg for decoding only |
| **GPU Rendering** | `OpusAsset::ReleaseGL()`, `WebPreview::Play(bool)` | GPU-based WebGL rendering |
| **Lottie Animations** | `OpusLottieAsset` | Lottie JSON vector animations |
| **Custom Text** | `PangoDrawText`, `MultiStyleFontLoader` | Pango/Cairo text rendering, NOT libass |
| **Watermarks** | `TextWatermarkParams` | Branded watermark overlay |
| **Color** | `hexToRgba()`, `RgbaColor` | Hex color parsing to RGBA |
| **Caching** | `DataCacheManager`, `OpusMediaAsset cache` | Smart asset caching |
| **Format** | VP8, WebP, LZW, ZIP | Encoder support |
| **Frame Data** | `OpusFrameData` | Frame-level access for analysis |

### How Rendering Works (Reconstructed)

```
1. DECODE: FFDecoder reads source video frame-by-frame
   ├── Uses FFmpeg (libavcodec) for decoding
   └── Pooled decoders (DecoderPool::Instance)

2. COMPOSITE: Layers are stacked by Z-index
   ├── Layer 0: Full background video (fit/fill/screen)
   ├── Layer 1: Face crop (cropped + scaled segment)
   ├── Layer 2: Subtitle text (PangoDrawText rendered)
   ├── Layer 3: Watermark/overlay (TextWatermarkParams)
   └── Each layer can have: position, scale, opacity, rotation

3. RENDER: AVEditTimeline::RenderByTime(timestamp, w, h)
   ├── Called per-frame for preview (WebGL)
   └── Called for export (likely server-side FFmpeg encode)

4. ENCODE: Output encoded to target format
   └── VP8/WebP for preview, H.264/H.265 for export
```

### Key Difference from GANYIQ

| Aspect | GANYIQ | OpusClip |
|--------|--------|----------|
| **Approach** | FFmpeg filter graph (single string) | NLE compositor (layer-based) |
| **Rendering** | Single ffmpeg command per clip | `RenderByTime` per frame |
| **Text** | libass (ASS format) | Pango/Cairo (native render) |
| **Transforms** | FFmpeg filters (crop, scale) | Per-layer position/scale/rotation |
| **Animation** | Zoompan filter | Keyframe system + Lottie |
| **Preview** | None (must render) | WebGL in-browser preview |
| **Decoders** | FFmpeg subprocess | Pooled decoder instances |
| **Effects** | Unsharp filter | EffectTimeline with Z-ordering |

### GANYIQ Implication

To match OpusClip's quality and flexibility, GANYIQ needs to eventually move from:
- **Single ffmpeg filter graph** → **Layer-based compositor**
- **ASS subtitles** → **Native text rendering (Pango/Cairo)**
- **Static segments** → **Keyframe animations**
- **No preview** → **WebGL/WebGPU in-browser preview**

This is a **Phase 3 (P3)** architectural change. For now, GANYIQ can continue improving its ffmpeg pipeline while understanding the long-term target.
