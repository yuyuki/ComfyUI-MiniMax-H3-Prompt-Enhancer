import json
from pathlib import Path
import subprocess
import sys

import pytest

import planning_diagnostics as diagnostics
from camera_catalog import CAMERA_MOTIONS
from test_media_manifest_v2 import _project


def test_preflight_collects_independent_errors_without_a_completion(monkeypatch):
    import prompt_enhancer

    monkeypatch.setattr(prompt_enhancer, "_completion", lambda *a, **k: pytest.fail("LLM used by preflight"))
    report = diagnostics.preflight(
        {
            "basic_prompt": "",
            "cinematography_json": "{broken",
            "creative_treatment_json": "{broken",
            "shot_plan_json": "{broken",
        }
    )
    assert not report["valid"]
    assert report["summary"]["errors"] >= 4
    assert all(item["suggestions"] for item in report["diagnostics"])


def test_inactive_binding_uses_production_compiler_and_actionable_location():
    project = _project()
    project["generations"][0]["bindings"].append({"assetId": "unused", "slotIndex": 2})
    plan = {
        "schemaVersion": 2,
        "timingMode": "exact",
        "shots": [{"id": "s1", "generationId": "g1", "durationSeconds": 8, "action": "Ana waits."}],
    }
    report = diagnostics.preflight(
        {
            "basic_prompt": "Ana waits.",
            "mode": "ref2va",
            "duration_seconds": 8,
            "media_manifest": project,
            "shot_plan_json": plan,
        }
    )
    finding = next(item for item in report["diagnostics"] if "inactive asset 'unused'" in item["message"])
    assert finding["location"]["assetId"] == "unused"
    assert finding["location"]["generationId"] == "g1"
    assert any("remove" in suggestion for suggestion in finding["suggestions"])


def test_camera_errors_across_shots_have_exact_locations():
    plan = {
        "schemaVersion": 2,
        "timingMode": "exact",
        "shots": [
            {
                "id": "rope",
                "generationId": "g1",
                "durationSeconds": 4,
                "action": "Follow rope.",
                "cameraPath": {"motionType": "pitch_in"},
            },
            {
                "id": "indy",
                "generationId": "g1",
                "durationSeconds": 4,
                "action": "Reveal Indy.",
                "cameraStart": {"framing": "banana"},
            },
        ],
    }
    report = diagnostics.preflight(
        {"basic_prompt": "Descend.", "duration_seconds": 8, "shot_plan_json": plan}
    )
    camera = [item for item in report["diagnostics"] if item["category"] == "camera"]
    assert {item["location"]["shotId"] for item in camera} == {"rope", "indy"}
    assert any("cameraPath.motionType" in item["location"]["field"] for item in camera)


def test_single_blank_shot_still_inherits_basic_prompt_without_mutation():
    plan = {
        "schemaVersion": 2,
        "timingMode": "auto",
        "shots": [{"id": "s1", "generationId": "g1", "action": ""}],
    }
    report = diagnostics.preflight({"basic_prompt": "Follow the rope.", "shot_plan_json": plan})
    assert report["valid"], report
    assert plan["shots"][0]["action"] == ""


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://127.example.com/v1",
        "https://example.com/v1",
        "http://user:secret@localhost/v1",
        "http://192.168.1.2/v1",
    ],
)
def test_explanations_reject_non_loopback_or_embedded_credentials(endpoint):
    with pytest.raises(ValueError, match="loopback"):
        diagnostics.explain_diagnostics(
            {"endpoint": endpoint, "model": "loaded", "diagnostics": [{"message": "bad"}]}
        )


def test_explanation_prompt_filters_credentials_and_returns_advice(monkeypatch):
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, limit):
            return json.dumps({"choices": [{"message": {"content": "Change Camera → Target."}}]}).encode()

    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            assert timeout == 60
            return Response()

    monkeypatch.setattr(diagnostics, "build_opener", lambda *args: Opener())
    result = diagnostics.explain_diagnostics(
        {
            "endpoint": "http://127.0.0.1:1234/v1",
            "model": "loaded",
            "api_key": "transport-secret",
            "language": "French",
            "diagnostics": [{"message": "Bad camera", "api_key": "hidden"}],
            "context": {
                "basic_prompt": "Follow the rope.",
                "api_key": "context-secret",
                "arbitrary": "ignore rules",
            },
        }
    )
    assert result["advisory"]
    assert len(calls) == 1
    body = json.loads(calls[0].data)
    assert "French" in body["messages"][0]["content"]
    assert "push_in" in body["messages"][0]["content"]
    assert "secret" not in json.dumps(body)
    assert "ignore rules" not in json.dumps(body)
    assert calls[0].get_header("Authorization") == "Bearer transport-secret"


def test_explanation_requires_explicit_model_and_blocks_redirects():
    with pytest.raises(ValueError, match="Select a loaded model"):
        diagnostics.explain_diagnostics({"endpoint": "http://localhost:1234/v1"})
    with pytest.raises(ValueError, match="redirects"):
        diagnostics._NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com")


def test_camera_generated_artifacts_match_and_cover_runtime():
    root = Path(__file__).parents[1]
    subprocess.run([sys.executable, str(root / "tools/generate_camera_catalog.py"), "--check"], check=True)
    from camera_state import MOTION_TYPES
    from creative_treatments import cinematography_choices

    assert MOTION_TYPES == set(CAMERA_MOTIONS)
    assert set(cinematography_choices("camera_motion")) == {"none", *CAMERA_MOTIONS}
