FROM python:3.13-slim

WORKDIR /app

# Poetry pinned to the version that wrote poetry.lock
RUN pip install --no-cache-dir poetry==2.3.2

ENV POETRY_VIRTUALENVS_CREATE=false

# Install the runtime dependencies from the lock file only
COPY pyproject.toml poetry.lock ./
RUN poetry install --only main --no-root --no-interaction --no-ansi

COPY main.py strategy.py ./

ENV PYTHONUNBUFFERED=1
ENV ENVIRONMENT=production

# Run as a non-root user
RUN useradd --create-home --uid 10001 engine
USER engine

# Railway sets PORT
EXPOSE 8000
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips "*"
