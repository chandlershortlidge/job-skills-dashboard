"""Locks the offline JD model boundary.

The vision model emits extracted_skill labels. This test does not call an LLM or exercise
normalization; final canonical identity belongs to normalize.py.
"""

import pytest
from pydantic import ValidationError

from extract import Skill


def test_skill_schema_uses_extracted_skill_not_canonical():
    assert set(Skill.model_fields) == {
        "raw_text",
        "extracted_skill",
        "requirement",
        "alternative_group",
    }

    skill = Skill.model_validate({
        "raw_text": "large language models",
        "extracted_skill": "LLMs",
        "requirement": "required",
        "alternative_group": None,
    })
    assert skill.model_dump()["extracted_skill"] == "LLMs"
    assert "canonical" not in skill.model_dump()


def test_legacy_canonical_is_not_enough_for_new_model_output():
    with pytest.raises(ValidationError):
        Skill.model_validate({
            "raw_text": "large language models",
            "canonical": "LLMs",
            "requirement": "required",
            "alternative_group": None,
        })
