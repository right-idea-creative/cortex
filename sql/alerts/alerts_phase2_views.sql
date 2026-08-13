-- =====================================================================
-- Cortex Alert System — FASE 2 (Google Ads API vía pipeline gads_*)
-- =====================================================================
-- 3 vistas nuevas que leen las tablas que el pipeline gads_to_bq.py
-- escribe en raw_google_ads (snapshot diario). Se suman a alerts_active.
--
-- Mismo esquema común: alert_type, severity, source, customer_id,
-- client_name, account_manager, tier, sub_mcc, av_status, entity_id,
-- entity_name, detail, detected_at.
--
-- Disparadores de Juanes que cubren (los que el Data Transfer NO podía):
--   5. URL / Destination mismatch -> alert_url_disapproved (con MOTIVO exacto)
--   6. Phone disapproved          -> alert_phone_disapproved
--   tarjeta/billing               -> alert_billing_problem
-- (4. Advertiser verification NO viable — no existe en GAQL v25)
--
-- Todas leen el snapshot más reciente (MAX(snapshot_date)) de su tabla.
-- =====================================================================


-- =====================================================================
-- alert_url_disapproved  (disparador 5 — URL rota, CON motivo)
-- =====================================================================
-- Ads DISAPPROVED cuyo motivo (policy_topics) incluye un problema de URL:
-- DESTINATION_NOT_WORKING o DESTINATION_NOT_ACCESSIBLE. Este es el valor
-- que el Data Transfer NO daba — el MOTIVO exacto del rechazo.
-- ponytail: filtra por substring del topic. Los topics vienen concatenados
-- por coma (un ad puede tener varios). Si Google agrega otro topic de URL,
-- sumar al REGEXP. LOCAL_SERVICES puro queda fuera (LSA, otro flujo).
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_url_disapproved` AS
WITH latest AS (
  SELECT * FROM `rightidea-cortex.raw_google_ads.gads_ad_policy`
  WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `rightidea-cortex.raw_google_ads.gads_ad_policy`)
),
url_problems AS (
  SELECT
    customer_id,
    campaign_id,
    ANY_VALUE(campaign_name) AS campaign_name,
    COUNT(*)                 AS ad_count,
    -- motivo legible: los topics de URL presentes
    STRING_AGG(DISTINCT
      CASE
        WHEN REGEXP_CONTAINS(policy_topics, 'DESTINATION_NOT_WORKING')    THEN 'URL not working'
        WHEN REGEXP_CONTAINS(policy_topics, 'DESTINATION_NOT_ACCESSIBLE') THEN 'URL not accessible'
      END, ', ') AS url_reason
  FROM latest
  WHERE approval_status = 'DISAPPROVED'
    AND REGEXP_CONTAINS(policy_topics, 'DESTINATION_NOT_WORKING|DESTINATION_NOT_ACCESSIBLE')
  GROUP BY customer_id, campaign_id
)
SELECT
  'url_disapproved'                          AS alert_type,
  'P0'                                       AS severity,
  'google_ads_api'                           AS source,
  up.customer_id                             AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  up.campaign_id                             AS entity_id,
  up.campaign_name                           AS entity_name,
  CONCAT(
    up.ad_count, ' ad(s) disapproved for landing-page problem (', up.url_reason,
    ') in campaign "', up.campaign_name, '". The destination URL is broken. Fix the URL.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM url_problems AS up
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON up.customer_id = cm.google_ads_customer_id;


-- =====================================================================
-- alert_phone_disapproved  (disparador 6 — teléfono rechazado)
-- =====================================================================
-- Call assets (números de teléfono en los anuncios) con approval
-- DISAPPROVED. El cliente tiene un número que Google rechazó — llamadas
-- perdidas. Dato que el Data Transfer NO tenía (solo la API da el approval).
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_phone_disapproved` AS
WITH latest AS (
  SELECT * FROM `rightidea-cortex.raw_google_ads.gads_call_assets`
  WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `rightidea-cortex.raw_google_ads.gads_call_assets`)
    AND approval_status = 'DISAPPROVED'
)
SELECT
  'phone_disapproved'                        AS alert_type,
  'P0'                                       AS severity,
  'google_ads_api'                           AS source,
  l.customer_id                              AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  l.asset_id                                 AS entity_id,
  COALESCE(cm.client_name, l.customer_id)    AS entity_name,
  CONCAT(
    'Phone number ', COALESCE(l.phone_number, '(call asset ' || l.asset_id || ')'),
    ' is DISAPPROVED by Google. Calls from ads may not connect. Review the call asset.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM latest AS l
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON l.customer_id = cm.google_ads_customer_id;


-- =====================================================================
-- alert_billing_problem  (tarjeta / pago — prioridad de Sebas)
-- =====================================================================
-- Cuentas cuyo billing_setup o account_budget NO está APPROVED.
-- billing_setup CANCELLED/PENDING o account_budget no aprobado = problema
-- de pago (lo más cerca de "tarjeta rechazada" que la API expone).
-- ponytail: UNKNOWN se trata como OK (es ruido de la API, no problema real
-- confirmado — hoy 4 cuentas UNKNOWN, todas con budget APPROVED). Si se
-- vuelve señal real, quitarlo del filtro de exclusión.
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_billing_problem` AS
WITH latest AS (
  SELECT * FROM `rightidea-cortex.raw_google_ads.gads_billing`
  WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `rightidea-cortex.raw_google_ads.gads_billing`)
)
SELECT
  'billing_problem'                          AS alert_type,
  'P0'                                       AS severity,
  'google_ads_api'                           AS source,
  l.customer_id                              AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  l.customer_id                              AS entity_id,
  COALESCE(cm.client_name, l.customer_id)    AS entity_name,
  CONCAT(
    'Billing problem: billing setup is ', COALESCE(l.billing_setup_status, 'unknown'),
    ', account budget is ', COALESCE(l.account_budget_status, 'unknown'),
    '. Payment may have failed (e.g. card declined). Check billing immediately.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM latest AS l
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON l.customer_id = cm.google_ads_customer_id
WHERE (l.billing_setup_status IS NOT NULL AND l.billing_setup_status NOT IN ('APPROVED', 'UNKNOWN'))
   OR (l.account_budget_status IS NOT NULL AND l.account_budget_status NOT IN ('APPROVED', 'UNKNOWN'));


-- =====================================================================
-- Recrear alerts_active con las 7 vistas (4 Fase 1 + 3 Fase 2)
-- =====================================================================
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alerts_active` AS
SELECT * FROM `rightidea-cortex.transformed.alert_campaign_suspended`
UNION ALL SELECT * FROM `rightidea-cortex.transformed.alert_ads_disapproved`
UNION ALL SELECT * FROM `rightidea-cortex.transformed.alert_overspend`
UNION ALL SELECT * FROM `rightidea-cortex.transformed.alert_no_spend`
UNION ALL SELECT * FROM `rightidea-cortex.transformed.alert_url_disapproved`
UNION ALL SELECT * FROM `rightidea-cortex.transformed.alert_phone_disapproved`
UNION ALL SELECT * FROM `rightidea-cortex.transformed.alert_billing_problem`;
