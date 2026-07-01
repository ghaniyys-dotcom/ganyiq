import sys
from pathlib import Path

# Add the project root (the directory containing 'run.py') to sys.path
# This ensures that 'speaker_hybrid' can be found as a top-level package.
project_root = Path(__file__).resolve().parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from speaker_hybrid.pipeline import main as run_pipeline

if __name__ == "__main__":
    print("--- ENTRYPOINT: run.py ---", file=sys.stderr)
    run_pipeline()
