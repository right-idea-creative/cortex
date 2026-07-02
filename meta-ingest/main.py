"""
Meta Ads → BigQuery: ingesta de spend diario a nivel campaña.

Replica el schema de `budget.other_channels_live` (6 columnas) y escribe en
`budget.meta_spend_daily`, particionada por `date`.

Un solo job, parametrizable por rango de fechas:
  - Backfill:    python main.py --since 2026-01-01 --until 2026-07-02
  - Incremental: python main.py            (por defecto: últimos 7 días)

Patrón de escritura: staging + reemplazo del rango (DELETE + INSERT atómico).
Re-correr el mismo rango reemplaza esas fechas — nunca duplica.

Credenciales por variable de entorno (nunca hardcodeadas):
  META_ACCESS_TOKEN   token del System User cortex-bigquery
  GCP_PROJECT         rightidea-cortex   (opcional, default abajo)
"""

import argparse
import datetime as dt
import os
import time

import requests
from google.cloud import bigquery

# ----------------------------------------------------------------------------
# Configuración
# ----------------------------------------------------------------------------
GRAPH_VERSION = "v21.0"
GRAPH_BASE = f"https://graph.facebook.com/{GRAPH_VERSION}"

PROJECT = os.environ.get("GCP_PROJECT", "rightidea-cortex")
DATASET = "budget"
TABLE = "meta_spend_daily"
STAGING = "meta_spend_daily_staging"
CHANNEL_LABEL = "Meta Ads"

ACCESS_TOKEN = os.environ.get("META_ACCESS_TOKEN")

# Rate limit / reintentos
MAX_RETRIES = 5
BACKOFF_BASE_SECONDS = 5


# ----------------------------------------------------------------------------
# Meta Graph API
# ----------------------------------------------------------------------------
def _get(url, params):
    """GET con backoff simple ante rate limit / errores transitorios."""
    for attempt in range(MAX_RETRIES):
        resp = requests.get(url, params=params, timeout=60)
        if resp.status_code == 200:
            return resp.json()

        # 4 = rate limit app-level, 17 = user rate, 613 = calls/hour
        try:
            err_code = resp.json().get("error", {}).get("code")
        except Exception:
            err_code = None

        if resp.status_code in (429, 500, 503) or err_code in (4, 17, 613, 1, 2):
            wait = BACKOFF_BASE_SECONDS * (2 ** attempt)
            print(f"  rate/transitorio (HTTP {resp.status_code}, code {err_code}). "
                  f"Esperando {wait}s...")
            time.sleep(wait)
            continue

        # Error no recuperable: cortar con detalle
        raise RuntimeError(f"Meta API error HTTP {resp.status_code}: {resp.text}")

    raise RuntimeError(f"Agotados {MAX_RETRIES} reintentos en {url}")


def list_active_accounts():
    """Enumera dinámicamente las cuentas activas del System User."""
    accounts = []
    url = f"{GRAPH_BASE}/me/adaccounts"
    params = {
        "fields": "name,account_id,account_status",
        "access_token": ACCESS_TOKEN,
        "limit": 100,
    }
    while True:
        data = _get(url, params)
        for acc in data.get("data", []):
            if acc.get("account_status") == 1:  # 1 = ACTIVE
                accounts.append({
                    "account_name": acc.get("name"),
                    "customer_id": acc.get("account_id"),
                    "act_id": acc.get("id"),  # formato act_XXXX para insights
                })
        next_url = data.get("paging", {}).get("next")
        if not next_url:
            break
        url, params = next_url, {}  # el next ya trae todos los params
    return accounts


def pull_insights(act_id, since, until):
    """Insights diarios a nivel campaña para una cuenta y rango."""
    rows = []
    url = f"{GRAPH_BASE}/{act_id}/insights"
    params = {
        "level": "campaign",
        "fields": "campaign_name,spend",
        "time_increment": 1,
        "time_range": f'{{"since":"{since}","until":"{until}"}}',
        "access_token": ACCESS_TOKEN,
        "limit": 500,
    }
    while True:
        data = _get(url, params)
        for r in data.get("data", []):
            rows.append({
                "campaign": r.get("campaign_name"),
                "date": r.get("date_start"),
                "cost": r.get("spend"),
            })
        next_url = data.get("paging", {}).get("next")
        if not next_url:
            break
        url, params = next_url, {}
    return rows


# ----------------------------------------------------------------------------
# BigQuery
# ----------------------------------------------------------------------------
def build_records(accounts, since, until):
    """Recorre cuentas y arma las filas mapeadas al schema de 6 columnas."""
    records = []
    for acc in accounts:
        print(f"  {acc['account_name']} ({acc['customer_id']})...")
        insights = pull_insights(acc["act_id"], since, until)
        for row in insights:
            records.append({
                "account_name": acc["account_name"],
                "customer_id": acc["customer_id"],
                "campaign": row["campaign"],
                "date": row["date"],
                "cost": float(row["cost"]) if row["cost"] is not None else 0.0,
                "channel": CHANNEL_LABEL,
            })
        print(f"    {len(insights)} filas")
    return records


def write_to_bigquery(records, since, until):
    """Staging + reemplazo atómico del rango [since, until]."""
    client = bigquery.Client(project=PROJECT)
    staging_ref = f"{PROJECT}.{DATASET}.{STAGING}"
    prod_ref = f"{PROJECT}.{DATASET}.{TABLE}"

    schema = [
        bigquery.SchemaField("account_name", "STRING"),
        bigquery.SchemaField("customer_id", "STRING"),
        bigquery.SchemaField("campaign", "STRING"),
        bigquery.SchemaField("date", "DATE"),
        bigquery.SchemaField("cost", "NUMERIC"),
        bigquery.SchemaField("channel", "STRING"),
    ]

    # 1. Cargar a staging (reemplaza el contenido previo del staging)
    job_config = bigquery.LoadJobConfig(
        schema=schema,
        write_disposition="WRITE_TRUNCATE",
    )
    load_job = client.load_table_from_json(records, staging_ref, job_config=job_config)
    load_job.result()
    print(f"  staging cargado: {len(records)} filas")

    # 2. Reemplazo atómico del rango en producción (DELETE + INSERT en transacción)
    #    DELETE por rango exacto: limpia también campañas que hoy tienen 0 spend.
    #    La tabla está particionada por date → el DELETE hace partition pruning.
    swap_sql = f"""
    BEGIN TRANSACTION;
      DELETE FROM `{prod_ref}`
      WHERE date BETWEEN DATE('{since}') AND DATE('{until}');

      INSERT INTO `{prod_ref}` (account_name, customer_id, campaign, date, cost, channel)
      SELECT account_name, customer_id, campaign, date, cost, channel
      FROM `{staging_ref}`;
    COMMIT TRANSACTION;
    """
    client.query(swap_sql).result()
    print(f"  swap completado: rango {since} → {until} reemplazado en producción")


# ----------------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------------
def parse_args():
    today = dt.date.today()
    default_until = today.isoformat()
    default_since = (today - dt.timedelta(days=7)).isoformat()

    p = argparse.ArgumentParser(description="Meta Ads → BigQuery spend ingest")
    p.add_argument("--since", default=default_since, help="YYYY-MM-DD (default: hace 7 días)")
    p.add_argument("--until", default=default_until, help="YYYY-MM-DD (default: hoy)")
    return p.parse_args()


def main():
    if not ACCESS_TOKEN:
        raise SystemExit("Falta META_ACCESS_TOKEN en el entorno.")

    args = parse_args()
    print(f"Rango: {args.since} → {args.until}")

    print("Enumerando cuentas activas...")
    accounts = list_active_accounts()
    print(f"  {len(accounts)} cuentas activas")

    print("Trayendo insights...")
    records = build_records(accounts, args.since, args.until)
    print(f"Total filas: {len(records)}")

    if not records:
        print("Sin datos para el rango. Nada que escribir.")
        return

    print("Escribiendo a BigQuery...")
    write_to_bigquery(records, args.since, args.until)
    print("Listo.")


if __name__ == "__main__":
    main()
