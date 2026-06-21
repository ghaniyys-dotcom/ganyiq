-- Add frozen 3-factor evaluator scores to moments table
ALTER TABLE moments 
ADD COLUMN IF NOT EXISTS information_gain INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS attention_capture INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS harm INTEGER DEFAULT NULL,
ADD COLUMN IF NOT EXISTS final_score NUMERIC(6,2) DEFAULT NULL;

-- Add index for ranking by final_score
CREATE INDEX IF NOT EXISTS idx_moments_final_score ON moments (final_score DESC) WHERE final_score IS NOT NULL;

-- Add evaluator log table for auditing
CREATE TABLE IF NOT EXISTS evaluator_logs (
  id SERIAL PRIMARY KEY,
  moment_id TEXT,
  analysis_id TEXT,
  clip_id TEXT,
  transcript TEXT,
  information_gain INTEGER,
  attention_capture INTEGER,
  harm INTEGER,
  final_score NUMERIC(6,2),
  reasoning TEXT,
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evaluator_logs_analysis ON evaluator_logs (analysis_id);
CREATE INDEX IF NOT EXISTS idx_evaluator_logs_timestamp ON evaluator_logs (timestamp);