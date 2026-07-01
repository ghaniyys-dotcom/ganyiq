import sys
import os

# Add the project root to the Python path.
# This ensures that imports like 'from speaker_hybrid...' work correctly
# when this script is run from the project root directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from speaker_hybrid.pipeline import main as run_pipeline

if __name__ == "__main__":
    print("--- ENTRYPOINT: run.py ---", file=sys.stderr)
    run_pipeline()
