# hci-study-chatbot-api/Dockerfile
FROM python:3.11-slim

# Keep images small & predictable
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# (Optional) OS deps you might need; comment out what you don't use.
# If your requirements include packages with native extensions (e.g., psycopg, numpy),
# you'll likely want build-essential. Otherwise you can remove this block.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
    && rm -rf /var/lib/apt/lists/*

# 1) Install Python deps first (better cache)
# Make sure requirements.txt is in hci-study-chatbot-api/
COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --upgrade pip \
 && pip install -r /tmp/requirements.txt

# 2) Then copy the app (so code changes don’t bust the deps cache)
COPY . .

# Default command (compose overrides with --reload in dev)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081"]
