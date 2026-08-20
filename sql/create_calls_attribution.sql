-- ============================================================================
-- ctm_data.calls_attribution
-- ----------------------------------------------------------------------------
-- Vista de atribucion de llamadas, GRANO = 1 fila por llamada (call_id).
-- Es la version de PRODUCCION de la logica que Nate prototipo en
-- sandbox.CTM_Nate_Test. Se materializa aca (dataset estable ctm_data, donde ya
-- viven ctm_calls_daily/heatmap) para que el tablero call-attribution NO dependa
-- de una tabla de prueba en sandbox que puede cambiar o borrarse.
--
-- Fuente: ctm_data.ctm_calls (crudo CTM) JOIN reference.client_mapping (canonico).
-- Logica de atribucion identica a la revisada: gclid/gbraid/wbraid > Call Asset >
-- source explicito > medium+web_source. Separa google_paid / gbp / google_organic.
--
-- Si esta logica cambia, cambiarla ACA (no en sandbox). El tablero lee de esta vista.
-- ============================================================================

CREATE OR REPLACE VIEW `rightidea-cortex.ctm_data.calls_attribution` AS
WITH base AS (
  SELECT
    c.id AS call_id,
    c.account_id AS ctm_account_id,
    c.called_at_ts,
    c.hour AS ctm_hour_raw,
    c.caller_number_bare,
    c.tracking_number_id,
    c.direction, c.duration, c.talk_time, c.ring_time,
    c.call_status, c.dial_status,
    c.agent_id, c.agent_name,
    c.is_new_caller, c.excluded,
    c.ga_cid, c.source, c.medium, c.web_source, c.paid_medium,
    c.landing_page, c.last_url, c.referrer_host,
    c.device_type, c.city, c.state, c.postal_code,
    c.transcription_text, c.tag_list, c._pipeline_loaded_at,
    m.monday_item_id AS client_key,
    m.client_name,
    SAFE_CAST(NULLIF(m.google_ads_customer_id,'') AS INT64) AS google_ads_customer_id,
    m.vertical, m.city_size,
    EXTRACT(HOUR FROM SAFE.PARSE_TIME('%I%p', c.hour)) AS hour_local_raw
  FROM `rightidea-cortex.ctm_data.ctm_calls` c
  JOIN `rightidea-cortex.reference.client_mapping` m
    ON c.account_id = m.ctm_account
  WHERE c.call_status NOT IN ('sent','delivered','received','undelivered','delivery_failed','unsent','sending_failed','queued')
),
tz AS (
  SELECT *,
    COALESCE(MOD(EXTRACT(HOUR FROM called_at_ts) - hour_local_raw + 24, 24), 0) AS tz_offset_hours
  FROM base
),
loc AS (
  SELECT *,
    TIMESTAMP_SUB(called_at_ts, INTERVAL tz_offset_hours HOUR) AS called_at_local_ts
  FROM tz
),
seq AS (
  SELECT *,
    TO_HEX(SHA256(COALESCE(caller_number_bare,'unknown'))) AS caller_hash,
    ROW_NUMBER() OVER (PARTITION BY client_key, caller_number_bare ORDER BY called_at_ts) AS caller_sequence_num,
    LAG(called_at_ts) OVER (PARTITION BY client_key, caller_number_bare ORDER BY called_at_ts) AS prior_call_ts
  FROM loc
)
SELECT
  -- keys
  call_id,
  client_key,
  client_name,
  google_ads_customer_id,
  ctm_account_id,
  vertical,
  city_size,
  ga_cid,
  caller_hash,
  tracking_number_id,

  -- time
  called_at_ts AS called_at_utc,
  called_at_local_ts AS called_at_local,
  DATE(called_at_local_ts) AS call_date_local,
  EXTRACT(HOUR FROM called_at_local_ts) AS hour_local,
  EXTRACT(DAYOFWEEK FROM called_at_local_ts) AS dow_local,
  tz_offset_hours,

  -- mechanics
  direction,
  duration AS duration_sec,
  talk_time AS talk_time_sec,
  ring_time AS ring_time_sec,
  call_status AS call_status_raw,
  call_status = 'answered' AS is_answered,
  (call_status = 'answered' AND COALESCE(talk_time,0) < 20) AS is_likely_voicemail,
  agent_id,
  agent_name,

  -- caller history
  is_new_caller AS is_new_caller_ctm,
  caller_sequence_num = 1 AS is_first_call,
  caller_sequence_num,
  DATE_DIFF(DATE(called_at_ts), DATE(prior_call_ts), DAY) AS days_since_prior_call,
  (prior_call_ts IS NOT NULL
    AND TIMESTAMP_DIFF(called_at_ts, prior_call_ts, DAY) <= 30) AS is_duplicate_lead_30d,

  -- attribution
  CASE
    WHEN REGEXP_CONTAINS(LOWER(COALESCE(landing_page,'')), r'[?&](gclid|gbraid|wbraid)=') THEN 'google_paid'
    WHEN REGEXP_CONTAINS(LOWER(COALESCE(last_url,'')),     r'[?&](gclid|gbraid|wbraid)=') THEN 'google_paid'
    WHEN REGEXP_CONTAINS(LOWER(COALESCE(landing_page,'')), r'[?&]msclkid=')               THEN 'bing_paid'
    WHEN source = 'Google Call Asset' THEN 'google_paid'
    WHEN source LIKE 'Google Business Profile%' THEN 'gbp'
    WHEN source IN ('Google Ads','Google Adwords') THEN 'google_paid'
    WHEN source = 'Google Organic' THEN 'google_organic'
    WHEN source = 'Bing Paid' THEN 'bing_paid'
    WHEN source = 'Nextdoor' THEN 'nextdoor_paid'
    WHEN source IN ('Meta Ads','Facebook Paid') THEN 'meta_paid'
    WHEN source = 'Yelp' THEN 'referral'
    WHEN LOWER(medium) IN ('cpc','ppc','paid_search') AND LOWER(web_source) = 'google' THEN 'google_paid'
    WHEN LOWER(medium) IN ('cpc','ppc','paid_search') AND LOWER(web_source) = 'bing'   THEN 'bing_paid'
    WHEN LOWER(medium) = 'organic' AND LOWER(web_source) = 'google' THEN 'google_organic'
    WHEN LOWER(medium) = 'organic' AND LOWER(web_source) = 'bing'   THEN 'bing_organic'
    WHEN LOWER(medium) = 'paid' AND LOWER(web_source) = 'meta' THEN 'meta_paid'
    WHEN LOWER(medium) = 'paid_nextdoor' THEN 'nextdoor_paid'
    WHEN LOWER(medium) IN ('streaming tv','programmatic_audio') THEN 'offline'
    WHEN LOWER(medium) = 'referral' THEN 'referral'
    WHEN LOWER(medium) = '(none)' OR LOWER(web_source) = '(direct)' THEN 'direct'
    ELSE 'unknown'
  END AS channel,
  CASE
    WHEN REGEXP_CONTAINS(LOWER(COALESCE(landing_page,'')), r'[?&](gclid|gbraid|wbraid|msclkid)=')
      OR REGEXP_CONTAINS(LOWER(COALESCE(last_url,'')), r'[?&](gclid|gbraid|wbraid)=') THEN 'url_click_id'
    WHEN source IN ('Google Call Asset','Google Ads','Google Adwords','Google Organic','Bing Paid','Nextdoor','Meta Ads','Facebook Paid','Yelp')
      OR source LIKE 'Google Business Profile%' THEN 'dedicated_number'
    WHEN COALESCE(medium,'') != '' THEN 'medium_field'
    ELSE 'none'
  END AS attribution_method,
  REGEXP_EXTRACT(LOWER(COALESCE(landing_page, last_url)), r'[?&]gclid=([^&]+)') AS gclid,
  REGEXP_EXTRACT(COALESCE(landing_page, last_url), r'^https?://[^/]+(/[^?#]*)') AS landing_page_path,
  device_type,

  -- geo
  city,
  state,
  postal_code,

  -- flags
  excluded AS is_excluded,
  (transcription_text IS NOT NULL AND transcription_text != '') AS has_transcript,
  tag_list,
  REGEXP_CONTAINS(COALESCE(tag_list,''), r'\bclosed\b') AS ctm_tag_closed,
  REGEXP_CONTAINS(COALESCE(tag_list,''), r'new customer') AS ctm_tag_new_customer,
  REGEXP_CONTAINS(COALESCE(tag_list,''), r'\bspam\b') AS ctm_tag_spam,
  _pipeline_loaded_at
FROM seq;
