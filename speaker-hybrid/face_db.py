"""
face_db.py — Persistent face identity database.

Uses deepface Facenet embeddings + sqlite3 to give each face a stable
person_id that survives ByteTrack track_id reassignment (FASE 14).

Usage:
    db = FaceDB("face_identities.db")
    pid, is_new = db.identify(face_crop_rgb)
    pid = db.lookup_by_track(track_id, face_crop_rgb)
    db.close()
"""

import sqlite3
import numpy as np
from pathlib import Path

class FaceDB:
    """Persistent face identity via embedding matching."""

    def __init__(self, db_path: str = "face_identities.db"):
        self.db_path = db_path
        self._cache: dict[int, int] = {}        # track_id -> person_id
        self._emb_cache: dict[int, bool] = {}    # person_id -> embedding stored
        self._conn = sqlite3.connect(db_path)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS faces (
                person_id INTEGER PRIMARY KEY AUTOINCREMENT,
                embedding BLOB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_faces_pid ON faces(person_id)
        """)
        self._conn.commit()
        row = self._conn.execute("SELECT COALESCE(MAX(person_id), 0) + 1 FROM faces").fetchone()
        self._next_id = row[0] if row else 1
        self._embedder_loaded = False
        self._model = None
        self._model_name = "Facenet"

    # ── Lazy-load deepface ──────────────────────────────────────────
    def _load_embedder(self) -> bool:
        if self._embedder_loaded:
            return True
        try:
            from deepface.commons.logger import Logger
            import os
            os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
            # Suppress deepface welcome
            Logger.disable = True
            self._model = True  # marker; deepface loads internally
            # Warm-up: try a trivial embedding
            import deepface
            self._embedder_loaded = True
            return True
        except Exception:
            print("[FaceDB] deepface not available — person_id disabled", file=__import__('sys').stderr)
            return False

    # ── Embedding extraction ───────────────────────────────────────
    def _extract_embedding(self, face_rgb: np.ndarray) -> list | None:
        """Facenet embedding from RGB face crop. Returns None on failure."""
        if face_rgb is None or face_rgb.size == 0:
            return None
        h, w = face_rgb.shape[:2]
        if h < 40 or w < 40:
            return None
        try:
            from deepface import DeepFace
            result = DeepFace.represent(
                face_rgb,
                model_name=self._model_name,
                enforce_detection=False,
                detector_backend="skip",  # already a crop
                silent=True,
            )
            if result and isinstance(result, list) and len(result) > 0:
                emb = result[0].get("embedding")
                if emb is not None and len(emb) > 0:
                    return emb
        except Exception:
            pass
        return None

    # ── DB matching ────────────────────────────────────────────────
    def _match(self, embedding: list, threshold: float = 0.40) -> int | None:
        """Find closest match in DB within threshold. Returns person_id or None."""
        query_emb = np.array(embedding, dtype=np.float32)
        rows = self._conn.execute("SELECT person_id, embedding FROM faces").fetchall()
        best_id, best_dist = None, threshold
        for pid, blob in rows:
            stored = np.frombuffer(blob, dtype=np.float32)
            dist = float(np.linalg.norm(query_emb - stored))
            if dist < best_dist:
                best_dist = dist
                best_id = pid
        return best_id

    def _register(self, embedding: list) -> int:
        """Register new face. Returns new person_id."""
        pid = self._next_id
        self._next_id += 1
        emb_bytes = np.array(embedding, dtype=np.float32).tobytes()
        self._conn.execute(
            "INSERT INTO faces (person_id, embedding) VALUES (?, ?)",
            (pid, emb_bytes),
        )
        self._conn.commit()
        self._emb_cache[pid] = True
        return pid

    # ── Public API ─────────────────────────────────────────────────
    def identify(self, face_rgb: np.ndarray, min_size: int = 60) -> tuple:
        """
        Match face crop against DB or register new.
        Returns (person_id: int|None, is_new: bool).
        """
        if face_rgb is None or face_rgb.shape[0] < min_size or face_rgb.shape[1] < min_size:
            return None, False
        if not self._load_embedder():
            return None, False
        emb = self._extract_embedding(face_rgb)
        if emb is None:
            return None, False
        matched = self._match(emb)
        if matched is not None:
            return matched, False
        return self._register(emb), True

    def lookup_by_track(self, track_id: int, face_rgb: np.ndarray, min_size: int = 60) -> int | None:
        """Cached variant — skip deepface if track_id already mapped."""
        if track_id in self._cache:
            return self._cache[track_id]
        pid, _ = self.identify(face_rgb, min_size)
        if pid is not None:
            self._cache[track_id] = pid
        return pid

    def close(self):
        self._cache.clear()
        self._emb_cache.clear()
        self._conn.close()
