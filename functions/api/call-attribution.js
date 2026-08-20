// functions/api/call-attribution.js
// Cortex Cost-Per-Lead API — CPL real por cliente y mes, usando CTM como fuente
// de verdad (el costo por conversion de Google Ads no es confiable).
//
// CPL = gasto Google Ads / leads en CTM (canal google_paid).
// Tres definiciones de "lead" (el frontend deja elegir; destacado = first_time):
//   - first_time:     primera llamada de cada persona (~tag de conversion de CTM)
//   - unique_callers: personas distintas (Period Unique)
//   - total_calls:    todas las llamadas
//
// Cruce gasto<->llamadas por google_ads_customer_id via client_mapping
// (spend_daily_unified.client NO calza directo con call names; client_mapping
//  los une). Resuelve el mismatch de ~24 nombres del ponytail de calls.js.
//
// Histórico: ultimos N meses para ver tendencia (estable/subiendo/bajando).
// Excluye meses anteriores a client_start_date (gasto pre-gestion distorsiona CPL).
//
// Auth/bqQuery clonados de calls.js. Secret GCP_SA_KEY. cortex-pages-writer@
// tiene READER en ctm_data + budget + raw_google_ads + reference.
//
// GET /api/call-attribution?months=6
//   -> { generated_at, months:[...], rows:[{month,client_name,customer_id,
//        spend,total_calls,unique_callers,first_time,start_date}] }
// El frontend calcula CPL = spend/lead y arma histórico + tendencia por cliente.

const PROJECT = 'rightidea-cortex';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- Auth (clonado de calls.js) ----------
let tokenCache = { token: null, exp: 0 };
function b64urlFromString(str){return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function b64urlFromBuffer(buf){const b=new Uint8Array(buf);let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function pemToArrayBuffer(pem){const b64=pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'');const bin=atob(b64);const by=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)by[i]=bin.charCodeAt(i);return by.buffer;}

async function getAccessToken(env){
  const now=Math.floor(Date.now()/1000);
  if(tokenCache.token && tokenCache.exp-60>now) return tokenCache.token;
  const sa=JSON.parse(env.GCP_SA_KEY);
  const header=b64urlFromString(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claims=b64urlFromString(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/bigquery',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const unsigned=`${header}.${claims}`;
  const key=await crypto.subtle.importKey('pkcs8',pemToArrayBuffer(sa.private_key),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
  const jwt=`${unsigned}.${b64urlFromBuffer(sig)}`;
  const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})});
  const data=await res.json();
  if(!res.ok||!data.access_token) throw new Error(`OAuth token exchange failed: ${JSON.stringify(data)}`);
  tokenCache={token:data.access_token,exp:now+(data.expires_in||3600)};
  return tokenCache.token;
}
async function bqQuery(env,query,maxResults=100000){
  const token=await getAccessToken(env);
  const res=await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({query,useLegacySql:false,maxResults,timeoutMs:60000})});
  const data=await res.json();
  if(!res.ok) throw new Error(`BigQuery query failed: ${JSON.stringify(data)}`);
  if(!data.jobComplete) throw new Error('Query did not complete in time');
  const fields=(data.schema&&data.schema.fields||[]).map(f=>f.name);
  return (data.rows||[]).map(r=>{const o={};r.f.forEach((c,i)=>{o[fields[i]]=Array.isArray(c.v)?c.v.map(x=>x.v):c.v;});return o;});
}
const n = v => (v==null?0:Number(v));

export async function onRequestGet(context){
  try{
    const env=context.env;
    const url=new URL(context.request.url);
    let months=parseInt(url.searchParams.get('months')||'6',10);
    if(!Number.isFinite(months)||months<1) months=6;
    if(months>24) months=24; // ponytail: techo 24 meses; subir si se pide mas historico

    // Ventana: primer dia del mes que arranca 'months-1' meses atras, hasta hoy.
    // El grano mensual se calcula en SQL con DATE_TRUNC.
    const startExpr = `DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL ${months-1} MONTH), MONTH)`;

    // Gasto Google Ads por cliente+mes, cruzado a customer_id via client_mapping.
    // Excluye meses anteriores a client_start_date (gasto pre-gestion).
    const spendRows = await bqQuery(env,
      `SELECT
         FORMAT_DATE('%Y-%m', DATE_TRUNC(s.date, MONTH)) AS month,
         CAST(m.google_ads_customer_id AS STRING) AS customer_id,
         m.client_name,
         SUM(s.actual) AS spend
       FROM \`${PROJECT}.budget.spend_daily_unified\` s
       JOIN \`${PROJECT}.reference.client_mapping\` m ON s.client = m.client_name
       WHERE s.channel = 'google_ads'
         AND s.date >= ${startExpr}
         AND m.google_ads_customer_id IS NOT NULL AND m.google_ads_customer_id != ''
         AND (m.client_start_date IS NULL OR s.date >= DATE(m.client_start_date))
       GROUP BY 1,2,3`);

    // Leads en CTM por cliente+mes (canal google_paid). Tres definiciones.
    const callRows = await bqQuery(env,
      `SELECT
         FORMAT_DATE('%Y-%m', DATE_TRUNC(call_date_local, MONTH)) AS month,
         CAST(google_ads_customer_id AS STRING) AS customer_id,
         ANY_VALUE(client_name) AS client_name,
         COUNT(*) AS total_calls,
         COUNT(DISTINCT caller_hash) AS unique_callers,
         COUNTIF(is_first_call) AS first_time
       FROM \`${PROJECT}.ctm_data.calls_attribution\`
       WHERE channel = 'google_paid'
         AND call_date_local >= ${startExpr}
         AND google_ads_customer_id IS NOT NULL
       GROUP BY 1,2`);

    // Merge por (month, customer_id). Un cliente puede tener gasto sin llamadas
    // (CPL infinito -> lo marcamos) o llamadas sin gasto (CPL 0/oculto).
    const key = (mo,cid) => `${mo}|${cid}`;
    const merged = {};
    for(const r of spendRows){
      merged[key(r.month,r.customer_id)] = {
        month:r.month, customer_id:r.customer_id, client_name:r.client_name,
        spend:n(r.spend), total_calls:0, unique_callers:0, first_time:0,
      };
    }
    for(const r of callRows){
      const k=key(r.month,r.customer_id);
      if(!merged[k]) merged[k]={month:r.month,customer_id:r.customer_id,client_name:r.client_name,spend:0,total_calls:0,unique_callers:0,first_time:0};
      merged[k].total_calls=n(r.total_calls);
      merged[k].unique_callers=n(r.unique_callers);
      merged[k].first_time=n(r.first_time);
      if(!merged[k].client_name) merged[k].client_name=r.client_name;
    }
    const rows = Object.values(merged);

    // lista de meses presentes, orden cronologico
    const monthsList = [...new Set(rows.map(r=>r.month))].sort();

    return json({
      generated_at:new Date().toISOString().slice(0,10),
      months:monthsList,
      rows,
    });
  }catch(err){
    return json({error:String(err)},500);
  }
}
