# Python 3.12 (soportado; el 3.9 local ya está EOL y las libs de Google avisan)
FROM python:3.12-slim

WORKDIR /app

# Dependencias primero (mejor cacheo de capas)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Código
COPY main.py .

# El job corre sin argumentos → ventana móvil de 7 días (incremental).
# Para backfill manual se sobreescribe el entrypoint con --since/--until.
ENTRYPOINT ["python", "main.py"]
