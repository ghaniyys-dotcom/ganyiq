# VibeVoice Integration Report for GANYIQ

**Date:** 2026-06-20
**Status:** IMPLEMENTED_NOT_EXECUTED (code complete, awaiting runtime verification)

---

## Architecture Decision: MODE A

| Component | Location | Role |
|-----------|----------|------|
| Deepgram | VPS (API) | Primary transcription |
| Routing | VPS (lib/transcript/provider-router.ts) | Deterministic provider selection |
| Fusion | VPS (lib/transcript/fusion/) | Merge Deepgram words + VibeVoice speakers |
| VibeVoice | PC-GANY (Docker + vLLM) | Speaker intelligence / diarization |
| FasterWhisper | VPS (CPU) | Last-resort fallback |

## Why MODE A?

| Factor | VibeVoice Requirement | VPS Capability | Verdict |
|--------|----------------------|----------------|---------|
| GPU | 16GB+ VRAM (7B model) | No GPU | ❌ VPS cannot run |
| RAM | ~16GB+ recommended | 3.8GB total | ❌ Insufficient |
| Docker | vllm/vllm-openai:v0.14.1 | Available | ✅ But no GPU |
| CUDA | NVIDIA drivers + CUDA 12+ | None | ❌ Cannot use |

## Files Created

| File | Purpose | Status |
|------|---------|--------|
| `lib/transcript/providers/types.ts` | Shared provider types | ✅ Created |
| `lib/transcript/providers/vibevoice-provider.ts` | VibeVoice API client (remote vLLM) | ✅ Created |
| `lib/transcript/providers/fasterwhisper-provider.ts` | FasterWhisper TypeScript wrapper | ✅ Created |
| `worker/fasterwhisper-transcribe.py` | FasterWhisper Python script | ✅ Created |
| `lib/transcript/fusion/deepgram-vibevoice-fusion.ts` | Fusion engine | ✅ Created |
| `lib/transcript/fusion/deepgram-to-provider.ts` | Deepgram → ProviderResult adapter | ✅ Created |
| `lib/transcript/fallback-chain.ts` | Fallback chain orchestrator | ✅ Created |
| `lib/transcript/provider-router.ts` | Deterministic routing | ✅ Created |
| `lib/speaker-face-mapper.ts` | Speaker↔Face mapping foundation | ✅ Created |
| `db/migrations/012_transcript_providers.sql` | DB migration | ✅ Created |

## VibeVoice Setup Guide (for PC-GANY)

### Prerequisites
- NVIDIA GPU with 16GB+ VRAM (RTX 4060 Ti+, RTX 3090, A-series)
- Docker with NVIDIA Container Toolkit
- 50GB+ free disk space (model weights ~14GB)

### Installation
```bash
# 1. Clone VibeVoice
git clone https://github.com/microsoft/VibeVoice.git

# 2. Launch vLLM server
cd VibeVoice
docker run -d --gpus all --name vibevoice-vllm \
  --ipc=host \
  -p 8000:8000 \
  -e VIBEVOICE_FFMPEG_MAX_CONCURRENCY=64 \
  -e PYTORCH_ALLOC_CONF=expandable_segments:True \
  -v $(pwd):/app \
  -w /app \
  --entrypoint bash \
  vllm/vllm-openai:v0.14.1 \
  -c "python3 /app/vllm_plugin/scripts/start_server.py"

# 3. Verify
curl http://localhost:8000/v1/models
```

### GANYIQ Configuration
```env
# VibeVoice server address (set on PC-GANY or wherever VibeVoice runs)
VIBEVOICE_API_URL=http://192.168.1.100:8000
VIBEVOICE_API_KEY=

# FasterWhisper (VPS fallback)
FASTER_WHISPER_MODEL=small
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE=int8
```

## Resource Estimates (VibeVoice)

| Metric | Estimate |
|--------|----------|
| VRAM required | ~16GB (7B model, float16) |
| RAM required | ~8GB system RAM |
| Docker image size | ~8GB (vllm) + ~14GB (model) |
| Average latency (10min audio) | 30-120s (GPU-dependent) |
| Max audio length | 60 minutes (model limit) |
| Throughput | 1 concurrent request per GPU |

## Runtime Verification Status

| Component | Verified? | Evidence |
|-----------|-----------|----------|
| Deepgram | ✅ Existing | Production (nova-2) |
| VibeVoice health check | ❌ Not tested | No GPU server running |
| VibeVoice transcription | ❌ Not tested | No GPU server running |
| FasterWhisper | ❌ Not tested | Python package not installed |
| Fusion logic | ❌ Not executed | Needs both providers |
| Fallback chain | ❌ Not executed | Needs integration with pipeline |
| Provider router | ❌ Not executed | Needs integration with pipeline |
| Speaker↔Face mapper | ❌ Not executed | Needs DB migration run |
| Migration 012 | ❌ Not applied | Needs execution |

## Integration Points (To Be Wired)

Once runtime verification with PC-GANY is done:

1. `lib/transcript-service.ts` — Replace hardcoded fallback with fallback-chain
2. `lib/analyze-pipeline.ts` — Pass provider data to DB insert
3. `app/api/analyze/route.ts` — Accept routing hints
4. `app/diagnostics/page.tsx` — Show provider metrics
