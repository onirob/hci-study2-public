FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client lz4 tar \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir apscheduler pandas pyarrow "psycopg[binary]"

WORKDIR /app
COPY backupd.py /app/backupd.py
ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "backupd.py"]