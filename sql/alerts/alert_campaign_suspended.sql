-- =====================================================================
-- transformed.alert_campaign_suspended
-- =====================================================================
-- Alert system — Vista 1 (Flujo 5 del diagrama Nate/Martin/Sebas).
--
-- Detecta: campanas que el Account Manager quiere corriendo
--   (campaign_status = 'ENABLED') pero que Google tiene bloqueadas
--   (campaign_serving_status = 'SUSPENDED').
--   El AM cree que la campana sirve; Google la freno por detras.
--
-- NO alerta (por diseno del diagrama):
--   - PAUSED + SUSPENDED  -> el AM la apago a proposito
--   - REMOVED + SUSPENDED -> el AM la elimino
--   Solo la contradiccion ENABLED + SUSPENDED dispara.
--
-- EXCLUYE campanas Local Services Ads (LSA):
--   campaign_advertising_channel_type = 'LOCAL_SERVICES'.
--   Las LSA son auto-generadas por Google ("SystemGenerated"),
--   tienen su propio sistema de verificacion/badges/disputas, y su
--   estado SUSPENDED significa algo distinto que en una campana
--   gestionable. Se manejan en el panel de LSA, no en Google Ads
--   normal. (Nota: se filtra 'LOCAL_SERVICES', NO 'LOCAL' — 'LOCAL'
--   es Local campaigns, un tipo distinto y si gestionable.)
--
-- Severidad: P0 (el diagrama la marca asi — plata/exposicion perdida
--   sin que nadie lo sepa).
--
-- Este flujo NO usa Advanced Verification (av_status se incluye solo
--   como contexto, para mantener el esquema uniforme con las demas
--   vistas de alerta y su UNION ALL en transformed.alerts_active).
--
-- Esquema de salida (contrato con la vista unificada y el frontend RIG-25):
--   alert_type, severity, source, customer_id, client_name,
--   account_manager, tier, sub_mcc, av_status, campaign_id,
--   campaign_name, detail, detected_at
--
-- Fuente: raw_google_ads.ads_Campaign_6118198619 (Data Transfer, MCC 611)
--         reference.client_mapping (Monday sync, para contexto de cliente)
-- =====================================================================

CREATE OR REPLACE VIEW `rightidea-cortex.transformed.alert_campaign_suspended` AS
WITH latest_campaigns AS (
  -- Particion mas reciente del Data Transfer, solo la contradiccion que
  -- alerta, excluyendo campanas Local Services (LSA).
  SELECT
    campaign.customer_id             AS customer_id,
    campaign.campaign_id             AS campaign_id,
    campaign.campaign_name           AS campaign_name,
    campaign.campaign_status         AS campaign_status,
    campaign.campaign_serving_status AS campaign_serving_status,
    campaign.campaign_advertising_channel_type AS channel_type
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
  lc.customer_id                             AS customer_id,
  cm.client_name                             AS client_name,
  cm.account_manager                         AS account_manager,
  cm.tier                                    AS tier,
  cm.sub_mcc                                 AS sub_mcc,
  cm.av_status                               AS av_status,
  lc.campaign_id                             AS campaign_id,
  lc.campaign_name                           AS campaign_name,
  CONCAT(
    'Campaign "', lc.campaign_name,
    '" is ENABLED but Google has it SUSPENDED (not serving). ',
    'The AM expects it running; Google blocked it. Review the account for the suspension reason.'
  )                                          AS detail,
  CURRENT_TIMESTAMP()                        AS detected_at
FROM latest_campaigns AS lc
LEFT JOIN `rightidea-cortex.reference.client_mapping` AS cm
  ON CAST(lc.customer_id AS STRING) = cm.google_ads_customer_id;
