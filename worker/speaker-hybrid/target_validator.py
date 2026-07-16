#!/usr/bin/env python3
"""
target_validator.py — Target Namespace Validator for GANYIQ

Validates that Director shot targets use only canonical PERSON_* namespace
before rendering. Rejects mixed SPEAKER_*, LISTENER_*, TRACK_* namespaces.
"""

import sys
from typing import List, Dict, Optional
from dataclasses import dataclass


@dataclass
class ValidationResult:
    """Result of target namespace validation."""
    valid: bool
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    mixed_namespace_count: int = 0
    non_canonical_count: int = 0
    unresolved_count: int = 0
    person_target_count: int = 0
    null_target_count: int = 0


class TargetNamespaceValidator:
    """
    Validates that shot targets use only canonical PERSON_* namespace.
    
    Canonical path accepts:
    - PERSON_XXX (e.g., PERSON_000, PERSON_001)
    - None/null (fallback to wide_shot)
    
    Rejects:
    - SPEAKER_XX
    - LISTENER_XX
    - TRACK_XX
    - Mixed namespaces (SPEAKER_* + PERSON_*)
    """
    
    def __init__(self, log_fn=None):
        """
        Initialize validator.
        
        Parameters
        ----------
        log_fn : callable, optional
            Logging function (default: print to stderr)
        """
        self.log = log_fn or (lambda msg: print(f"[TARGET_VALIDATOR] {msg}", file=sys.stderr, flush=True))
    
    def validate_shot_list(self, scenes: List[Dict]) -> ValidationResult:
        """
        Validate all shot targets in scene list.
        
        Parameters
        ----------
        scenes : list of dict
            Shot list from Director with primary_target_id and secondary_target_id
            
        Returns
        -------
        ValidationResult
            Validation result with error details
        """
        if not scenes:
            self.log("No scenes to validate")
            return ValidationResult(valid=True)
        
        person_count = 0
        null_count = 0
        mixed_count = 0
        non_canonical_count = 0
        unresolved_count = 0
        errors = []
        
        for idx, scene in enumerate(scenes):
            layout = scene.get('layout', 'unknown')
            primary = scene.get('primary_target_id')
            secondary = scene.get('secondary_target_id')
            start = scene.get('start_time', 0)
            end = scene.get('end_time', 0)
            
            # Validate primary target
            primary_status = self._validate_target(primary)
            if primary_status == 'PERSON':
                person_count += 1
            elif primary_status == 'NULL':
                null_count += 1
            elif primary_status == 'NON_CANONICAL':
                non_canonical_count += 1
                errors.append(f"Scene {idx} [{start:.1f}s-{end:.1f}s]: non-canonical primary '{primary}'")
            elif primary_status == 'UNRESOLVED':
                unresolved_count += 1
            
            # Validate secondary target
            if secondary:
                secondary_status = self._validate_target(secondary)
                if secondary_status == 'PERSON':
                    person_count += 1
                elif secondary_status == 'NON_CANONICAL':
                    non_canonical_count += 1
                    errors.append(f"Scene {idx} [{start:.1f}s-{end:.1f}s]: non-canonical secondary '{secondary}'")
                elif secondary_status == 'UNRESOLVED':
                    unresolved_count += 1
                
                # Check for mixed namespace (one PERSON, one non-PERSON)
                if (primary_status == 'PERSON' and secondary_status == 'NON_CANONICAL') or \
                   (primary_status == 'NON_CANONICAL' and secondary_status == 'PERSON'):
                    mixed_count += 1
                    errors.append(f"Scene {idx} [{start:.1f}s-{end:.1f}s]: mixed namespace P={primary} S={secondary}")
            
            # Check for same person in split screen
            if layout == 'split_screen' and primary and secondary and primary == secondary:
                errors.append(f"Scene {idx} [{start:.1f}s-{end:.1f}s]: same person in both panels '{primary}'")
                non_canonical_count += 1
        
        # Determine overall validity
        valid = non_canonical_count == 0 and mixed_count == 0
        
        if not valid:
            error_msg = f"Target validation failed: {non_canonical_count} non-canonical, {mixed_count} mixed namespace"
            self.log(error_msg)
            for err in errors[:10]:  # Log first 10 errors
                self.log(f"  {err}")
            
            return ValidationResult(
                valid=False,
                error_type="MIXED_TARGET_NAMESPACE" if mixed_count > 0 else "NON_CANONICAL_TARGET",
                error_message=error_msg,
                mixed_namespace_count=mixed_count,
                non_canonical_count=non_canonical_count,
                unresolved_count=unresolved_count,
                person_target_count=person_count,
                null_target_count=null_count
            )
        
        self.log(f"Target validation passed: {person_count} PERSON_* targets, {null_count} null targets")
        return ValidationResult(
            valid=True,
            person_target_count=person_count,
            null_target_count=null_count,
            unresolved_count=unresolved_count
        )
    
    def _validate_target(self, target_id) -> str:
        """
        Validate a single target ID.
        
        Returns
        -------
        str
            'PERSON' - Valid canonical PERSON_* ID
            'NULL' - None/null (acceptable fallback)
            'NON_CANONICAL' - SPEAKER_*, LISTENER_*, TRACK_*
            'UNRESOLVED' - Unknown format
        """
        if target_id is None or target_id == 'null':
            return 'NULL'
        
        target_str = str(target_id).upper()
        
        if target_str.startswith('PERSON_'):
            return 'PERSON'
        
        if target_str.startswith('SPEAKER_') or \
           target_str.startswith('LISTENER_') or \
           target_str.startswith('TRACK_'):
            return 'NON_CANONICAL'
        
        return 'UNRESOLVED'
