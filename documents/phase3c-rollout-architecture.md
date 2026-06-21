# Phase 3C — Canary Rollout Architecture

**Status:** Pre-deployment (all infrastructure ready, feature flags OFF)  
**Shadow data:** Collecting live production data since June 16, 2026  

---

## 1. Architecture

```
User → POST /api/analyze
         ↓
    Canary Router (lib/canary-controller.ts)
         ↓
    ┌────┴────┐
    ↓         ↓
  V1 (ctl)  V2 (tmt)
    ↓         ↓
  moments   v2_shadow_results
    ↓         ↓
  user sees  user sees V2
  V1 clips   clips (only if canary)
```

**Routing:** Deterministic MD5 hash of `analysisId` → bucket 0-99 → if bucket < canary%, route to V2.

**Feature flag hierarchy:**

| Flag | Purpose | Current |
|------|---------|---------|
| `V2_MULTI_GENERATOR_SHADOW` | Run V2 silently alongside V1 | `true` |
| `V2_MULTI_GENERATOR_OUTPUT` | Return V2 clips to users | `false` |
| `V2_CANARY_ENABLED` | Enable canary routing | `false` |
| `V2_CANARY_PERCENT` | % of traffic to V2 | `0` |

## 2. Rollout Stages

| Stage | % | Duration | Rollback if | Gate |
|-------|---|----------|-------------|------|
| **Stage 1: Shadow** | 0% | Until ready | — | Current status |
| **Stage 2: 1% Canary** | 1% | 24h min | Any rollback trigger | 100+ videos OR 7 days |
| **Stage 3: 5% Canary** | 5% | 48h min | Success <99%, latency >30% | Stage 2 stable |
| **Stage 4: 10% Expansion** | 10% | 72h min | Failure >5%, starvation | Stage 3 stable |
| **Stage 5: 25% Expansion** | 25% | 72h min | Any critical rollback | Stage 4 stable |
| **Stage 6: 50% Expansion** | 50% | 72h min | Any critical rollback | Stage 5 stable |
| **Stage 7: 100% Full** | 100% | 1 week min | Any critical rollback | Stage 6 stable |

## 3. Automatic Rollback Triggers

| Trigger | Threshold | Action | Response time |
|---------|-----------|--------|---------------|
| Success rate | <99% | Set flags=0, alert ops | 15 min (cron cycle) |
| Latency regression | >30% from baseline | Set flags=0, alert ops | 15 min |
| Failure rate | >5% unexpected | Set flags=0, alert ops | 15 min |
| Generator starvation | Any gen <5% raw | Flag as warning, alert | 30 min |
| Strategy dominance | Any gen >60% top-5 | Flag as warning, alert | 30 min |

**Rollback execution:**
```bash
# Manual (anytime)
export V2_CANARY_ENABLED=false
export V2_CANARY_PERCENT=0
pm2 restart ganyiq

# Automatic (by rollout-dashboard cron — advisory only, human must execute)
# Dashboard flags rollback_recommended=true when triggers fire
```

## 4. Metrics Collection

| Category | Metrics | Source |
|----------|---------|--------|
| **Engagement** | clip views, watch time, share rate | YouTube Analytics (external) |
| **Quality** | human override rate, clip acceptance | `analysis_metrics` |
| **Performance** | P50/P95/P99 latency | `v2_shadow_results.latency_ms` |
| **Diversity** | generator contribution %, strategy spread | `generator_attribution` |
| **Reliability** | success rate, failure breakdown | `v2_shadow_results.pipeline_success` |
| **Comparison** | overlap vs V1, new-content rate | `v1_top_clips` vs `fusion_top_clips` |

## 5. Rollback Automation (`lib/canary-controller.ts`)

```typescript
// checkRollbackConditions() returns:
{
  shouldRollback: boolean,  // true = CRITICAL threshold breached
  reasons: string[],        // human-readable explanations
  severity: 'none' | 'warning' | 'critical'
}

// Called by rollout-dashboard.ts every 30 minutes
// Dashboard reports: rollback status, readiness %, generator health
```

## 6. Readiness Checklist

| # | Requirement | How |
|---|-------------|-----|
| 1 | 100+ unique videos shadow-processed | Count `v2_shadow_results.video_id` |
| 2 | OR 7 days of shadow data | Timestamp oldest row |
| 3 | Success rate ≥99% | `pipeline_success=true / total` |
| 4 | Avg latency < 1000ms | `avg(latency_ms)` |
| 5 | No critical rollback conditions | `checkRollbackConditions()` |
| 6 | All generators ≥5% raw | `candidate_counts` |
| 7 | No generator >60% top-5 | `fusion_top_clips.generator` |
| 8 | Failure rate ≤5% | Unexpected failures / total |
| 9 | Rollback automation tested | `canary-controller.ts` deployed |
| 10 | Canary controller deployed | `canary-controller.ts` imported |
| 11 | Metrics instrumentation verified | `rollout-dashboard.ts` working |
| 12 | Feature flags in .env | `V2_CANARY_*` flags present |

## 7. Deployment Procedure

```bash
# PRE-FLIGHT (current state)
grep "V2_CANARY" .env.local
# → V2_CANARY_ENABLED=false
# → V2_CANARY_PERCENT=0

# STAGE 1: Enable 1% canary
sed -i 's/V2_CANARY_ENABLED=false/V2_CANARY_ENABLED=true/' .env.local
sed -i 's/V2_CANARY_PERCENT=0/V2_CANARY_PERCENT=1/' .env.local
pm2 restart ganyiq

# Verify
pm2 logs --lines 30 | grep CANARY
# Expected: "V2_CANARY: enabled=1%" — no errors

# MONITOR
# - 24h min before next stage
# - Check rollout-dashboard.md every 30 min
# - Escalate on any rollback trigger

# PROCEED to 5%, 10%, 25%, 50%, 100%
# Same pattern: update .env → pm2 restart → monitor
```

## 8. Rollback Procedure

```bash
# IMMEDIATE ROLLBACK (<30s)
sed -i 's/V2_CANARY_ENABLED=true/V2_CANARY_ENABLED=false/' .env.local
sed -i 's/V2_CANARY_PERCENT=[0-9]*/V2_CANARY_PERCENT=0/' .env.local
sed -i 's/V2_MULTI_GENERATOR_OUTPUT=true/V2_MULTI_GENERATOR_OUTPUT=false/' .env.local
pm2 restart ganyiq
```

---

*Prepared for Phase 3C rollout decision.*
