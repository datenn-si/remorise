from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.main import create_app
from app.schemas.state import CharacterStateResponse


def test_chat_openapi_describes_sse_content_errors_and_event_data() -> None:
    schema = create_app().openapi()
    operation = schema["paths"]["/api/chat"]["post"]
    response = operation["responses"]["200"]

    assert "text/event-stream" in response["content"]
    event_schemas = response["content"]["text/event-stream"]["x-sse-events"]
    assert set(event_schemas) == {
        "message_start",
        "token",
        "usage",
        "state_analysis",
        "character_state",
        "message_end",
        "error",
    }
    assert event_schemas["message_start"]["properties"]["message_id"]["type"] == "integer"
    assert event_schemas["token"]["properties"]["content"]["type"] == "string"
    code_schema = event_schemas["error"]["properties"]["code"]
    assert code_schema.get("enum", [code_schema.get("const")]) == ["generation_failed"]
    assert "error` events" in operation["description"]
    assert {"409", "422", "502", "503", "504"} <= set(operation["responses"])
    assert "application/json" in operation["responses"]["503"]["content"]
    api_error = operation["responses"]["503"]["content"]["application/json"]["schema"]
    assert api_error["$ref"].endswith("/APIError")
    assert schema["components"]["schemas"]["APIError"]["properties"]["detail"]["$ref"].endswith(
        "/HTTPErrorData"
    )


def test_state_response_and_openapi_bound_both_emotion_intensities() -> None:
    schema = create_app().openapi()
    response_schema = schema["components"]["schemas"]["CharacterStateResponse"]
    for field in ("intensity", "secondary_intensity"):
        assert response_schema["properties"][field]["minimum"] == 0.0
        assert response_schema["properties"][field]["maximum"] == 1.0

    response = CharacterStateResponse.model_validate(
        {
            "emotion": "happy",
            "intensity": 0.5,
            "secondary_emotion": None,
            "secondary_intensity": 1.0,
            "mood": "positive",
            "affinity": 50,
            "last_emotion_update": "2026-10-31T12:00:00Z",
            "updated_at": "2026-10-31T12:00:00Z",
        }
    )
    assert response.intensity == 0.5
    with pytest.raises(ValidationError):
        CharacterStateResponse.model_validate(
            {
                **response.model_dump(),
                "intensity": 1.01,
            }
        )
    with pytest.raises(ValidationError):
        CharacterStateResponse.model_validate(
            {
                **response.model_dump(),
                "secondary_intensity": -0.01,
            }
        )


def test_state_response_reads_attributes_from_the_database_row() -> None:
    class Row:
        emotion = "happy"
        intensity = 0.4
        secondary_emotion = None
        secondary_intensity = 0.0
        mood = "calm"
        affinity = 55
        last_emotion_update = datetime(2026, 10, 31, tzinfo=UTC)
        updated_at = datetime(2026, 10, 31, tzinfo=UTC)

    parsed = CharacterStateResponse.model_validate(Row())
    assert parsed.model_dump(mode="json")["emotion"] == "happy"
    assert parsed.affinity == 55
