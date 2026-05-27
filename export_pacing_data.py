"""
Cortex OS — Ad Spend Pacing
Exporta `pacing_dashboard_view` desde BigQuery a `pacing-data.json`.

Patrón mimético al `export_data.py` del módulo Call Tracking de Nate:
- Lee BQ con Application Default Credentials (ADC)
- Genera un JSON único con todo embebido
- Lo escribe en la raíz del repo para que Cloudflare Pages lo sirva estático

Uso local:
    gcloud auth application-default login        # una vez
    python export_pacing_data.py                 # genera pacing-data.json

Uso en GitHub Actions:
    Authenticated via google-github-actions/auth (Workload Identity Federation
    o JSON key). Las credenciales quedan en GOOGLE_APPLICATION_CREDENTIALS.
"""
import json
import logging
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from google.cloud import bigquery
from google.oauth2 import service_account

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("pacing-export")

PROJECT_ID = os.environ.get("GCP_PROJECT", "rightidea-cortex")
OUTPUT_PATH = Path(__file__).parent / "pacing-data.json"
BQ_VIEW = f"`{PROJECT_ID}.transformed.pacing_dashboard_view`"


def to_jsonable(v):
    """Convierte tipos no-JSON (Decimal, date, datetime) a tipos serializables."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, (int, float, str)):
        return v
    return str(v)


def fetch_rows():
    """Lee todas las rows de pacing_dashboard_view."""
    log.info("Querying %s", BQ_VIEW)

    # CRITICAL: para leer external tables conectadas a Google Sheets,
    # el cliente debe autenticar con scope de Drive además de BigQuery.
    # Si GOOGLE_APPLICATION_CREDENTIALS apunta a una key JSON, usamos
    # service_account.Credentials con scopes explícitos. Si no hay key
    # (Application Default Credentials del usuario, o entorno de Cloud Run),
    # caemos al cliente default.
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    scopes = [
        "https://www.googleapis.com/auth/bigquery",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/cloud-platform",
    ]
    if creds_path and Path(creds_path).is_file():
        log.info("Using SA key with explicit scopes (Drive + BigQuery)")
        credentials = service_account.Credentials.from_service_account_file(
            creds_path, scopes=scopes,
        )
        client = bigquery.Client(project=PROJECT_ID, credentials=credentials)
    else:
        log.info("Using Application Default Credentials")
        client = bigquery.Client(project=PROJECT_ID)

    query = f"""
    SELECT
      account_display_name,
      account_name,
      customer_id,
      platform,
      source_group,
      channel_status,
      year,
      month_num,
      month_date,
      month_kind,
      month_position,
      budget,
      planner_spend,
      bq_spend,
      bq_data_available,
      pacing_ratio,
      forecast_eom,
      remaining_budget,
      budget_consumed_pct,
      capture_accuracy_ratio,
      capture_discrepancy,
      status,
      severity,
      leftover_anual,
      total_approved,
      annual_status,
      platform_last_spend_date,
      platform_data_lag_days,
      is_current_month
    FROM {BQ_VIEW}
    """

    rows = []
    for row in client.query(query).result():
        clean = {k: to_jsonable(v) for k, v in dict(row).items()}
        rows.append(clean)

    log.info("Fetched %d rows", len(rows))
    return rows


def build_metadata(rows):
    """Construye metadatos top-level (siguiendo patrón data.json de Nate)."""
    accounts = sorted(set(r["account_display_name"] for r in rows if r.get("account_display_name")))
    platforms = sorted(set(r["platform"] for r in rows if r.get("platform")))

    # Data freshness por plataforma (única)
    freshness = {}
    for r in rows:
        p = r.get("platform")
        if not p or p in freshness:
            continue
        freshness[p] = {
            "last_date": r.get("platform_last_spend_date"),
            "lag_days": r.get("platform_data_lag_days"),
        }

    # Rango temporal de la ventana
    months = sorted(set(r["month_date"] for r in rows if r.get("month_date")))

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "generated_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "accounts": accounts,
        "platforms": platforms,
        "freshness": freshness,
        "window_months": months,
    }


def main():
    if not OUTPUT_PATH.parent.exists():
        log.error("Output dir does not exist: %s", OUTPUT_PATH.parent)
        sys.exit(1)

    rows = fetch_rows()
    if not rows:
        log.error("No rows returned from BigQuery. Aborting.")
        sys.exit(1)

    meta = build_metadata(rows)

    payload = {
        **meta,
        "rows": rows,
    }

    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    log.info(
        "Wrote %s (rows=%d, accounts=%d, platforms=%d, size=%.1f KB)",
        OUTPUT_PATH,
        len(rows),
        len(meta["accounts"]),
        len(meta["platforms"]),
        OUTPUT_PATH.stat().st_size / 1024,
    )


if __name__ == "__main__":
    main()
