"""Google Ads API -> BigQuery daily status ingestion (Cortex OS, Alert Phase 2).

Reads status fields the Data Transfer does NOT expose, for the campaign-health
alert system. Three resources, three tables, one job:
  1. gads_ad_policy    — ad approval + disapproval REASON (policy_topic_entries)
  2. gads_call_assets  — CALL asset approval status (phone disapproved)
  3. gads_billing      — billing_setup + account_budget status (payment problems)

Flow: enumerate child accounts under the MCC -> per account run 3 GAQL queries
-> parse -> staging load -> MERGE (idempotent on natural key + snapshot_date).

Credentials: Google Ads OAuth from Secret Manager (same 4 secrets used by the
alert-panel test scripts). BigQuery via ADC / the Cloud Run service account.

ponytail: snapshot-per-day model (snapshot_date column). Alerts read the latest
snapshot. Upgrade path: if history matters, keep all snapshots (already keyed
for it) instead of the trailing MERGE window.
"""

import os
import sys
import logging
from datetime import datetime, timezone

from google.cloud import bigquery, secretmanager
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gads_ingest")

GCP_PROJECT = os.environ.get("GCP_PROJECT", "rightidea-cortex")
BQ_DATASET = os.environ.get("BQ_DATASET", "raw_google_ads")
MCC = os.environ.get("LOGIN_CUSTOMER_ID", "6118198619")
# límite opcional de cuentas para pruebas (0 = todas)
MAX_ACCOUNTS = int(os.environ.get("MAX_ACCOUNTS", "0"))

SNAPSHOT = datetime.now(timezone.utc).date().isoformat()

# ---------- credenciales ----------
def get_secret(name):
    c = secretmanager.SecretManagerServiceClient()
    p = f"projects/{GCP_PROJECT}/secrets/{name}/versions/latest"
    return c.access_secret_version(name=p).payload.data.decode("utf-8").strip()

def build_ads_client():
    return GoogleAdsClient.load_from_dict({
        "developer_token": get_secret("google-ads-developer-token"),
        "client_id": get_secret("google-ads-client-id"),
        "client_secret": get_secret("google-ads-client-secret"),
        "refresh_token": get_secret("google-ads-refresh-token"),
        "login_customer_id": MCC,
        "use_proto_plus": True,
    })

# ---------- esquemas BQ ----------
SCHEMAS = {
    "gads_ad_policy": [
        bigquery.SchemaField("snapshot_date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("customer_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("campaign_id", "STRING"),
        bigquery.SchemaField("campaign_name", "STRING"),
        bigquery.SchemaField("ad_group_id", "STRING"),
        bigquery.SchemaField("ad_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("approval_status", "STRING"),
        bigquery.SchemaField("review_status", "STRING"),
        bigquery.SchemaField("policy_topics", "STRING"),   # topics separados por coma
    ],
    "gads_call_assets": [
        bigquery.SchemaField("snapshot_date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("customer_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("asset_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("phone_number", "STRING"),
        bigquery.SchemaField("approval_status", "STRING"),
    ],
    "gads_billing": [
        bigquery.SchemaField("snapshot_date", "DATE", mode="REQUIRED"),
        bigquery.SchemaField("customer_id", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("billing_setup_status", "STRING"),
        bigquery.SchemaField("account_budget_status", "STRING"),
    ],
}
# clave natural para el MERGE (además de snapshot_date)
KEYS = {
    "gads_ad_policy": ["customer_id", "ad_id"],
    "gads_call_assets": ["customer_id", "asset_id"],
    "gads_billing": ["customer_id"],
}

# ---------- GAQL ----------
Q_ACCOUNTS = """
    SELECT customer_client.id, customer_client.descriptive_name
    FROM customer_client
    WHERE customer_client.manager = FALSE AND customer_client.status = 'ENABLED'
"""
Q_AD_POLICY = """
    SELECT
      campaign.id, campaign.name,
      ad_group.id,
      ad_group_ad.ad.id,
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.review_status,
      ad_group_ad.policy_summary.policy_topic_entries
    FROM ad_group_ad
    WHERE ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED')
      AND campaign.status = 'ENABLED'
"""
Q_CALL_ASSETS = """
    SELECT asset.id, asset.call_asset.phone_number, asset.policy_summary.approval_status
    FROM asset
    WHERE asset.type = 'CALL'
"""
Q_BILLING = "SELECT billing_setup.id, billing_setup.status FROM billing_setup"
Q_ACCT_BUDGET = "SELECT account_budget.id, account_budget.status FROM account_budget"


def enum_status(x):
    """proto enum -> nombre string, robusto a None"""
    try:
        return x.name
    except Exception:
        return str(x) if x is not None else None


def collect(ads_client):
    """recorre cuentas, junta filas por tabla"""
    ga = ads_client.get_service("GoogleAdsService")
    accounts = [(str(r.customer_client.id), r.customer_client.descriptive_name or "")
                for r in ga.search(customer_id=MCC, query=Q_ACCOUNTS)]
    if MAX_ACCOUNTS:
        accounts = accounts[:MAX_ACCOUNTS]
    log.info("cuentas a procesar: %d", len(accounts))

    rows = {"gads_ad_policy": [], "gads_call_assets": [], "gads_billing": []}

    for cid, cname in accounts:
        # 1. ad policy + motivo
        try:
            for r in ga.search(customer_id=cid, query=Q_AD_POLICY):
                topics = r.ad_group_ad.policy_summary.policy_topic_entries
                topic_str = ",".join(enum_status(t.topic) or "" for t in topics) if topics else None
                rows["gads_ad_policy"].append({
                    "snapshot_date": SNAPSHOT, "customer_id": cid,
                    "campaign_id": str(r.campaign.id), "campaign_name": r.campaign.name,
                    "ad_group_id": str(r.ad_group.id), "ad_id": str(r.ad_group_ad.ad.id),
                    "approval_status": enum_status(r.ad_group_ad.policy_summary.approval_status),
                    "review_status": enum_status(r.ad_group_ad.policy_summary.review_status),
                    "policy_topics": topic_str,
                })
        except GoogleAdsException as ex:
            log.warning("[%s] ad_policy: %s", cid, ex.failure.errors[0].message if ex.failure.errors else ex)

        # 2. call assets
        try:
            for r in ga.search(customer_id=cid, query=Q_CALL_ASSETS):
                rows["gads_call_assets"].append({
                    "snapshot_date": SNAPSHOT, "customer_id": cid,
                    "asset_id": str(r.asset.id),
                    "phone_number": r.asset.call_asset.phone_number or None,
                    "approval_status": enum_status(r.asset.policy_summary.approval_status),
                })
        except GoogleAdsException as ex:
            log.warning("[%s] call_assets: %s", cid, ex.failure.errors[0].message if ex.failure.errors else ex)

        # 3. billing (dos queries, se combinan por cuenta)
        bstatus, abstatus = None, None
        try:
            for r in ga.search(customer_id=cid, query=Q_BILLING):
                bstatus = enum_status(r.billing_setup.status); break
        except GoogleAdsException as ex:
            log.warning("[%s] billing_setup: %s", cid, ex.failure.errors[0].message if ex.failure.errors else ex)
        try:
            for r in ga.search(customer_id=cid, query=Q_ACCT_BUDGET):
                abstatus = enum_status(r.account_budget.status); break
        except GoogleAdsException as ex:
            log.warning("[%s] account_budget: %s", cid, ex.failure.errors[0].message if ex.failure.errors else ex)
        rows["gads_billing"].append({
            "snapshot_date": SNAPSHOT, "customer_id": cid,
            "billing_setup_status": bstatus, "account_budget_status": abstatus,
        })

    for t, rs in rows.items():
        log.info("  %s: %d filas", t, len(rs))
    return rows


def load_and_merge(bq, table, schema, keys, rows):
    """staging load + MERGE idempotente en (keys + snapshot_date)"""
    target = f"{GCP_PROJECT}.{BQ_DATASET}.{table}"
    staging = f"{target}_staging"

    # asegura tabla destino
    try:
        bq.get_table(target)
    except Exception:
        bq.create_table(bigquery.Table(target, schema=schema))
        log.info("  creada tabla %s", target)

    if not rows:
        log.info("  %s: sin filas, skip", table)
        return

    # staging: recrea y carga
    job = bq.load_table_from_json(
        rows, staging,
        job_config=bigquery.LoadJobConfig(
            schema=schema,
            write_disposition="WRITE_TRUNCATE",
        ),
    )
    job.result()

    # MERGE por clave natural + snapshot_date
    on = " AND ".join([f"T.{k}=S.{k}" for k in keys] + ["T.snapshot_date=S.snapshot_date"])
    cols = [f.name for f in schema]
    set_clause = ", ".join(f"T.{c}=S.{c}" for c in cols if c not in keys and c != "snapshot_date")
    insert_cols = ", ".join(cols)
    insert_vals = ", ".join(f"S.{c}" for c in cols)
    merge = f"""
        MERGE `{target}` T USING `{staging}` S ON {on}
        WHEN MATCHED THEN UPDATE SET {set_clause}
        WHEN NOT MATCHED THEN INSERT ({insert_cols}) VALUES ({insert_vals})
    """
    bq.query(merge).result()
    log.info("  MERGE %s OK (%d filas)", table, len(rows))


def main():
    log.info("=== Google Ads ingest (Phase 2 alerts) snapshot=%s ===", SNAPSHOT)
    ads = build_ads_client()
    bq = bigquery.Client(project=GCP_PROJECT)
    rows = collect(ads)
    for table, schema in SCHEMAS.items():
        load_and_merge(bq, table, schema, KEYS[table], rows[table])
    log.info("=== done ===")


if __name__ == "__main__":
    main()
