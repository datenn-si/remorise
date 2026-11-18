"""Suite-wide environment.

Settings requires the LLM connection values (there are no
defaults), so tests that do not care how the connection is
configured get them from here.
"""

import os

os.environ.setdefault("LLM_BASE_URL", "http://127.0.0.1:9931/v1")
os.environ.setdefault("LLM_API_KEY", "test-api-key")
os.environ.setdefault("LLM_MODEL", "test-model")
