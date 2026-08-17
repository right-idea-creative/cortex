// Runnable check for pacing exceptions + year-context start — node test/pacing_exceptions.test.js
// No framework. Covers: (1) client-paid channels excluded from account verdict,
// (2) year-context (catch-up) ignores pre-management months AND client-paid channels.

// --- mirror of frontend logic (keep in sync with ad-spend-pacing.html) ---
const CLIENT_PAID_EXCEPTIONS = [
  { client: 'ODC Norfolk, VA', channel: 'lsa' },
];
const CLIENT_START = {
  'ODC Norfolk, VA': 5,   // managed since May
};

function actualForStatus(client, rows){
  const skip = new Set(CLIENT_PAID_EXCEPTIONS.filter(e=>e.client===client).map(e=>e.channel));
  if(skip.size===0) return rows.reduce((a,r)=>a+r.actual,0);
  return rows.filter(r=>!skip.has(r.channel)).reduce((a,r)=>a+r.actual,0);
}

function yearPacing(client, rows, asof){
  const start = CLIENT_START[client] || 1;
  const skip = new Set(CLIENT_PAID_EXCEPTIONS.filter(e=>e.client===client).map(e=>e.channel));
  let full=0,cytd=0,sytd=0;
  for(const r of rows){
    if(skip.has(r.channel) || r.month < start) continue;
    full+=r.committed;
    if(r.month<=asof){ cytd+=r.committed; sytd+=r.actual; }
  }
  const ytdVar=sytd-cytd;
  return { committedYTD:cytd, spentYTD:sytd, ytdVar };
}

// --- Norfolk VA real data (Aug 2026) ---
const norfolkRows = [
  { channel:'google_ads', month:1, committed:0,    actual:3132.87 },  // pre-May: ignore
  { channel:'google_ads', month:2, committed:0,    actual:3184.56 },  // pre-May: ignore
  { channel:'google_ads', month:3, committed:0,    actual:2234.15 },  // pre-May: ignore
  { channel:'google_ads', month:5, committed:2750, actual:629.82 },
  { channel:'google_ads', month:6, committed:2750, actual:2607.58 },
  { channel:'google_ads', month:7, committed:2750, actual:2299.73 },
  { channel:'google_ads', month:8, committed:2750, actual:589.93 },
  { channel:'lsa',        month:1, committed:0,    actual:1400.31 },  // client-paid: ignore
  { channel:'lsa',        month:5, committed:0,    actual:716.35 },   // client-paid: ignore
  { channel:'lsa',        month:8, committed:0,    actual:511.08 },   // client-paid: ignore
];

let fails = 0;
function check(name, cond){ if(!cond){ console.error('FAIL:', name); fails++; } else console.log('ok:', name); }

const y = yearPacing('ODC Norfolk, VA', norfolkRows, 8);

check('committedYTD is managed Google only (11000)', y.committedYTD === 11000);
check('spentYTD excludes pre-May and LSA', Math.abs(y.spentYTD - 6127.06) < 0.01);
check('ytdVar reflects managed months only (negative = behind)', y.ytdVar < 0);
check('ytdVar is NOT falsely positive (the bug)', y.ytdVar < 0);
check('Aug status actual excludes client-paid LSA',
  Math.abs(actualForStatus('ODC Norfolk, VA', norfolkRows.filter(r=>r.month===8)) - 589.93) < 0.01);

console.log(fails===0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails===0 ? 0 : 1);
