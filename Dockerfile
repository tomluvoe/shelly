FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN install -d -o 10001 -g 10001 /data && touch /data/.keep && chown 10001:10001 /data/.keep
COPY archive.py shelly.py ./
COPY dashboard/ ./dashboard/
USER 10001:10001
ENTRYPOINT ["python", "shelly.py"]
