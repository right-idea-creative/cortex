// Runnable check for CLIENT_PAID_EXCEPTIONS logic — node test/pacing_exceptions.test.js
// No framework. Asserts the ONE thing that must hold: marked client-paid channels leave the
// verdict; everything else (mis-mapped, unmapped) stays IN the verdict so it still alerts.

// --- mirror of the frontend logic (keep in sync with ad-spend-pacing.html) ---
const CLIENT_PAID_EXCEPTIONS = [
  { client: 'ODC Norfolk, VA', channel: 'lsa' },
];
function actualForStatus(client, rows){
  const skip = new Set(CLIENT_PAID_EXCEPTIONS.filter(e=>e.client===client).map(e=>e.channel));
  if(skip.size===0) return rows.reduce((a,r)=>a+r.actual,0);
  return rows.filter(r=>!skip.has(r.channel)).reduce((a,r)=>a+r.actual,0);
}

// --- fixtures: the 4 real committed=0 cases from prod (Aug 2026) ---
const norfolkVA = [
  { channel:'google_ads', committed:2750, actual:589.93 },
  { channel:'lsa',        committed:0,    actual:496.51 },  // client-paid, excepted
];
const fortSmith = [
  { channel:'nextdoor',   committed:0,    actual:724.05 },  // mis-mapped, must count
];
const unmapped = [
  { channel:'google_ads', committed:0,    actual:288.83 },  // unmapped, must count
];

let fails = 0;
function check(name, cond){ if(!cond){ console.error('FAIL:', name); fails++; } else console.log('ok:', name); }

// 1. Norfolk VA: LSA removed from verdict -> status actual = 589.93 (google only), NOT 1086.44
check('Norfolk VA verdict excludes client-paid LSA',
  Math.abs(actualForStatus('ODC Norfolk, VA', norfolkVA) - 589.93) < 0.01);

// 2. Norfolk VA verdict is NOT the full total (would be false overspend)
check('Norfolk VA verdict != full total',
  actualForStatus('ODC Norfolk, VA', norfolkVA) < 1086.44);

// 3. Fort Smith nextdoor: NOT excepted -> full actual counts -> stays visible to alert
check('Fort Smith mis-mapped spend still in verdict',
  Math.abs(actualForStatus('ODC Fort Smith', fortSmith) - 724.05) < 0.01);

// 4. Unmapped google: NOT excepted -> counts -> pacing still flags it
check('Unmapped spend still in verdict',
  Math.abs(actualForStatus('UNMAPPED · Architectural Glazing', unmapped) - 288.83) < 0.01);

// 5. A client with no exceptions returns its untouched total
check('No-exception client keeps full actual',
  Math.abs(actualForStatus('ODC Fort Smith', fortSmith) - 724.05) < 0.01);

console.log(fails===0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails===0 ? 0 : 1);
