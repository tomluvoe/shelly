FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN install -d -o 10001 -g 10001 /data && touch /data/.keep && chown 10001:10001 /data/.keep
# Set image permissions independently of the checkout's file modes.
COPY --chmod=0644 archive.py shelly.py ./
COPY --chmod=0755 dashboard/ ./dashboard/
USER 10001:10001
RUN ["python", "/app/shelly.py", "--help"]
ENTRYPOINT ["python", "/app/shelly.py"]
