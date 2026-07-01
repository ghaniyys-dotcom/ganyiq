#!/usr/bin/env python3
"""
run.py — GANYIQ Speaker Hybrid Pipeline Entrypoint

This executes the pipeline script directly from the speaker-hybrid
directory, bypassing all import path issues on Windows.
"""
import sys
from pathlib import Path

def main():
    project_root = Path(__file__).resolve().parent
    pipeline_file = project_root / "speaker-hybrid" / "pipeline.py"
    
    if not pipeline_file.exists():
        print(f"[ERROR] Pipeline script not found at: {pipeline_file}", file=sys.stderr)
        sys.exit(1)
    
    # Change to speaker-hybrid dir so relative imports work
    old_cwd = Path.cwd()
    os.chdir(str(pipeline_file.parent))
    
    # Execute the pipeline script directly from its source file.
    # This is the most reliable way to run scripts that use relative imports.
    compiled = compile(open(pipeline_file).read(), "pipeline.py", "exec")
    exec(compiled, {"__file__": str(pipeline_file.resolve()),
                     "__name__": "__main__",
                     "__package__": None})
    
    # Restore original CWD (important for temp file cleanup paths)
    os.chdir(old_cwd)

if __name__ == "__main__":
    import os  # needed for chdir above
    print("--- ENTRYPOINT: run.py ---", file=sys.stderr)
    main()
