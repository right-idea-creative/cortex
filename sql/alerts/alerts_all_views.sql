-- =====================================================================
-- Cortex Alert System — Fase 1 (Data Transfer + reference + pacing)
-- =====================================================================
-- Genera 4 vistas de alertas + 1 vista unificada (alerts_active).
-- Logica cerrada con Nate/Martin/Sebas (diagrama Figma) + conversacion
-- de AV del 2026-08-11.
--
-- Vistas:
--   1. alert_campaign_suspended  (ya existe — se recrea aqui para tener todo junto)
--   2. alert_ads_disapproved
--   3. alert_overspend
--   4. alert_no_spend            (nivel cuenta, con persistencia por AV)
--   5. alerts_active             (UNION de las 4 — contrato con frontend RIG-25)
--
-- Esquema comun de salida (todas las vistas de alerta lo respetan para
-- poder unirse con UNION ALL):
--   alert_type, severity, source, customer_id, client_name,
--   account_manager, tier, sub_mcc, av_status, entity_id, entity_name,
--   detail, detected_at
--
-- Nota: campaign_suspended y ads_disapproved dan detalle a nivel CAMPANA
-- (entity_id = campaign_id). no_spend y overspend son nivel CUENTA
-- (entity_id = customer_id) — el spend historico por campana necesita
-- infraestructura acumulativa que hoy no existe (Data Transfer solo
-- guarda 1 dia). Ver PENDING P-TECH (campaign_spend_history).
-- =====================================================================


-- =====================================================================
-- 1. alert_campaign_suspended  (Flujo 5)
-- =====================================================================
-- Campana ENABLED (el AM la quiere corriendo) pero Google la tiene
-- SUSPENDED (bloqueada). Excluye LOCAL_SERVICES (LSA, otro mundo).
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_campaign_suspended` AS
WITH latest_campaigns AS (
  SELECT
    campaign.customer_id             AS customer_id,
    campaign.campaign_id             AS campaign_id,
    campaign.campaign_name           AS campaign_name
  FROM `rightidea-cortex.raw_google_ads.ads_Campaign_6118198619` AS campaign
  WHERE campaign._DATA_DATE = campaign._LATEST_DATE
    AND campaign.campaign_status = 'ENABLED'
    AND campaign.campaign_serving_status = 'SUSPENDED'
    AND campaign.campaign_advertising_channel_type != 'LOCAL_SERVICES'
)
SELECT
  'campaign_suspended'                       AS alert_type,
  'P0'                                       AS severity,
  'data_transfer'                            AS source,
  CAST(lc.customer_id AS STRING)            AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  CAST(lc.campaign_id AS STRING)            AS entity_id,
  lc.campaign_name                           AS entity_name,
  CONCAT(
    'Campaign "', lc.campaign_name,
    '" is ENABLED but Google has it SUSPENDED (not serving). ',
    'The AM expects it running; Google blocked it. Review the account for the suspension reason.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM latest_campaigns AS lc
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON CAST(lc.customer_id AS STRING) = cm.google_ads_customer_id;


-- =====================================================================
-- 2. alert_ads_disapproved
-- =====================================================================
-- Ads DISAPPROVED dentro de campanas ENABLED (activas). Un ad rechazado
-- en campana pausada no importa -> se filtra exigiendo campana ENABLED.
-- Excluye LOCAL_SERVICES. Se agrega POR CAMPANA (cuenta de ads
-- rechazados por campana), no una alerta por ad — para no ahogar.
-- ponytail: APPROVED_LIMITED (2866 casos) queda FUERA por ahora —
-- decision de negocio pendiente (Nate/Martin). Solo DISAPPROVED duro.
-- Upgrade: si deciden alertar LIMITED, agregar al IN (...) del WHERE.
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_ads_disapproved` AS
WITH enabled_campaigns AS (
  SELECT
    campaign.customer_id    AS customer_id,
    campaign.campaign_id    AS campaign_id,
    campaign.campaign_name  AS campaign_name
  FROM `rightidea-cortex.raw_google_ads.ads_Campaign_6118198619` AS campaign
  WHERE campaign._DATA_DATE = campaign._LATEST_DATE
    AND campaign.campaign_status = 'ENABLED'
    AND campaign.campaign_advertising_channel_type != 'LOCAL_SERVICES'
),
disapproved_ads AS (
  SELECT
    ad.customer_id  AS customer_id,
    ad.campaign_id  AS campaign_id,
    COUNT(*)        AS disapproved_count
  FROM `rightidea-cortex.raw_google_ads.ads_Ad_6118198619` AS ad
  WHERE ad._DATA_DATE = ad._LATEST_DATE
    AND ad.ad_group_ad_policy_summary_approval_status = 'DISAPPROVED'
  GROUP BY ad.customer_id, ad.campaign_id
)
SELECT
  'ads_disapproved'                          AS alert_type,
  'P0'                                       AS severity,
  'data_transfer'                            AS source,
  CAST(ec.customer_id AS STRING)            AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  CAST(ec.campaign_id AS STRING)            AS entity_id,
  ec.campaign_name                           AS entity_name,
  CONCAT(
    da.disapproved_count, ' disapproved ad(s) in ENABLED campaign "',
    ec.campaign_name, '". These ads are not serving. Review and fix policy issues.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM disapproved_ads AS da
JOIN enabled_campaigns AS ec
  ON da.customer_id = ec.customer_id AND da.campaign_id = ec.campaign_id
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON CAST(ec.customer_id AS STRING) = cm.google_ads_customer_id;


-- =====================================================================
-- 3. alert_overspend  (Flujo 4, nivel cuenta)
-- =====================================================================
-- Reusa pacing_calculations (ya calcula pacing vs budget). Overspend =
-- status 'Overpacing' (forecast). No recalculo umbral — el pacing ya
-- clasifica >=1.10 como Overpacing. Consistente con el dashboard.
-- ponytail: hereda la dependencia de Google Sheet de pacing_calculations
-- (necesita scope Drive). Upgrade robusto: overspend desde spend_combined
-- + budget nativo, sin Sheet.
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_overspend` AS
SELECT
  'overspend'                                AS alert_type,
  'P1'                                       AS severity,
  'pacing'                                   AS source,
  pc.customer_id                             AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  CAST(pc.customer_id AS STRING)            AS entity_id,
  pc.account_name                            AS entity_name,
  CONCAT(
    'Account "', pc.account_name, '" (', pc.platform, ') is overpacing: ',
    CAST(ROUND(pc.pacing_ratio * 100) AS STRING), '% of budget, forecast ',
    CAST(ROUND(pc.forecast_eom) AS STRING), ' vs budget ', CAST(ROUND(pc.budget) AS STRING), '.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM `rightidea-cortex.transformed.pacing_calculations` AS pc
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON pc.customer_id = cm.google_ads_customer_id
WHERE pc.status = 'Overpacing';


-- =====================================================================
-- 4. alert_no_spend  (Flujos 1/2/3, nivel cuenta, persistencia por AV)
-- =====================================================================
-- Logica de Nate (2026-08-11):
--   - Cuenta tenia gasto en ventana reciente y HOY (ultimos 3 dias) no
--     gasta -> alerta.
--   - Persistencia por AV: cuenta CON AV mantiene la alerta indefinido.
--     Cuenta SIN AV, si el sin-gasto ya lleva > 3 dias, la alerta se
--     APAGA (se vuelve ruido — probablemente es por falta de AV).
--   - Nunca tuvo gasto -> no alerta.
-- Reusa spend_combined (tiene historia diaria; el Data Transfer solo 1 dia).
-- Nivel CUENTA (spend_combined es customer_id+platform).
-- "Tiene AV" = av_status = 'AV Approved' (unico estado verificado real).
--
-- Ventana: mira ultimos 30 dias de spend_combined.
--   last_spend_date = ultimo dia con spend > 0.
--   days_since_spend = dias desde ese ultimo gasto hasta hoy.
--   had_spend = alguna vez gasto en la ventana (si nunca, no alerta).
-- Dispara si: had_spend AND days_since_spend >= 3
--   (>=3 dias sin gasto = "dejo de gastar").
-- Persistencia: si NO tiene AV y days_since_spend > 6 -> se apaga
--   (3 dias de alerta activa; despues, sin AV, es ruido).
--   Con AV, sin tope superior.
-- ponytail: umbrales (3 para disparar, 6 = 3+3 para apagar sin-AV) son
-- heuristica acordada con Nate. Nivel cuenta, no campana (campana
-- necesita campaign_spend_history acumulativo — pendiente P-TECH).
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_no_spend` AS
WITH spend_window AS (
  SELECT
    sc.customer_id,
    sc.platform,
    MAX(IF(sc.spend > 0, sc.spend_date, NULL)) AS last_spend_date,
    SUM(sc.spend)                              AS spend_30d
  FROM `rightidea-cortex.transformed.spend_combined` AS sc
  WHERE sc.spend_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
  GROUP BY sc.customer_id, sc.platform
),
scored AS (
  SELECT
    sw.customer_id,
    sw.platform,
    sw.last_spend_date,
    sw.spend_30d,
    DATE_DIFF(CURRENT_DATE(), sw.last_spend_date, DAY) AS days_since_spend
  FROM spend_window AS sw
  WHERE sw.last_spend_date IS NOT NULL   -- had_spend: gasto alguna vez en la ventana
)
SELECT
  'no_spend'                                 AS alert_type,
  'P1'                                       AS severity,
  'spend_combined'                           AS source,
  s.customer_id                              AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  CAST(s.customer_id AS STRING)             AS entity_id,
  cm.client_name                             AS entity_name,
  CONCAT(
    'Account "', COALESCE(cm.client_name, s.customer_id), '" (', s.platform,
    ') stopped spending: last spend ', CAST(s.last_spend_date AS STRING),
    ' (', CAST(s.days_since_spend AS STRING), ' days ago). Was active before. Check billing/campaigns.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM scored AS s
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON s.customer_id = cm.google_ads_customer_id
WHERE s.days_since_spend >= 3
  AND (
        cm.av_status = 'AV Approved'         -- con AV: persiste sin tope
     OR s.days_since_spend <= 6              -- sin AV: solo mientras <=6 dias
      );


-- =====================================================================
-- 5. alerts_active  (vista unificada — contrato con frontend RIG-25)
-- =====================================================================
-- UNION ALL de las 4 vistas. El frontend lee SOLO esto.
CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alerts_active` AS
SELECT * FROM `rightidea-cortex.transformed.alert_campaign_suspended`
UNION ALL
SELECT * FROM `rightidea-cortex.transformed.alert_ads_disapproved`
UNION ALL
SELECT * FROM `rightidea-cortex.transformed.alert_overspend`
UNION ALL
SELECT * FROM `rightidea-cortex.transformed.alert_no_spend`;
