"""Server-only configuration: no embedded credentials or production defaults."""
import os
from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()
WRITE_TOKEN_HEADER = "x-session-write-token"
SESSION_MAX_MINUTES = int(os.getenv("SESSION_MAX_MINUTES", "60"))


def required_setting(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value or "REPLACE_" in value:
        raise RuntimeError(f"Set {name} in your local environment; see docs/SETUP.md.")
    return value


class Settings(BaseModel):
    DATABASE_URL: str = required_setting("DATABASE_URL")
    IP_HASH_SALT: str = required_setting("IP_HASH_SALT")
    STAGING: bool = os.getenv("STAGING", "true").lower() in ("1", "true", "yes")


settings = Settings()
if not settings.DATABASE_URL.startswith(("postgresql://", "postgres://")):
    raise RuntimeError("DATABASE_URL must be a PostgreSQL connection URI (not a SQLAlchemy URL).")
