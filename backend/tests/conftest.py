"""Shared pytest setup: every test run gets its own throw-away data directory."""
import os
import tempfile

os.environ.setdefault("ESS_DATA_DIR", tempfile.mkdtemp(prefix="ess-test-data-"))
