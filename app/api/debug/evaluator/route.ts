import { enforceEvaluatorRules } from "@/lib/evaluator-validator";
import { NextRequest, NextResponse } from 'next/server';
import { EvaluatorRunner } from '@/lib/evaluator-runner';
import { calculateHybridScore } from '@/lib/hybrid-ranking';

const runner = new EvaluatorRunner();

export async function POST(req: NextRequest) {
  try {
    const { transcript } = await req.json();

    if (!transcript || typeof transcript !== 'string') {
      return NextResponse.json({ error: 'transcript is required' }, { status: 400 });
    }

    let result = await runner.evaluateClip({
      clipId: 'debug',
      transcript: transcript,
    });
    result = enforceEvaluatorRules(result);

    const final_score = (result.information_gain * 5.0) + (result.attention_capture * 2.0) - (result.harm * 4.0);

    return NextResponse.json({
      information_gain: result.information_gain,
      attention_capture: result.attention_capture,
      harm: result.harm,
      final_score: Number(final_score.toFixed(2)),
      reasoning: result.reasoning,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
