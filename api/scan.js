// Hlídač letenek – víkendové kombinace Ryanair pro partu z Prahy a z Moravy
// GET /api/scan?dest=AMS&months=6&minDays=14

const DESTS = {
  AMS: { name: "Amsterdam", airports: { EIN: [1000, "Eindhoven – bus + vlak ~1,5 h"], CRL: [2200, "Brusel-Charleroi – bus + vlak ~3 h"], NRN: [1600, "Weeze – bus ~2,5 h"], MST: [1200, "Maastricht – vlak ~2,5 h"], AMS: [300, "Schiphol – vlak 15 min"] },
         note: "Letiště Eindhoven je 1. 2. – 18. 7. 2027 zavřené (oprava dráhy)." },
  BCN: { name: "Barcelona", airports: { BCN: [300, "El Prat – vlak/metro 30 min"], GRO: [800, "Girona – bus ~1,2 h"], REU: [900, "Reus – bus ~1,5 h"] } },
  ROM: { name: "Řím", airports: { FCO: [400, "Fiumicino – vlak 30 min"], CIA: [300, "Ciampino – bus 40 min"] } },
  MIL: { name: "Milán", airports: { BGY: [300, "Bergamo – bus ~1 h"], MXP: [500, "Malpensa – vlak 50 min"], LIN: [200, "Linate – metro 20 min"] } },
  LON: { name: "Londýn", airports: { STN: [500, "Stansted – vlak/bus ~1 h"], LTN: [500, "Luton – vlak ~45 min"], LGW: [600, "Gatwick – vlak 30 min"] } },
  PAR: { name: "Paříž", airports: { BVA: [800, "Beauvais – bus ~1,3 h"], ORY: [300, "Orly – metro 40 min"], CDG: [350, "CDG – vlak 40 min"] } },
  LIS: { name: "Lisabon", airports: { LIS: [150, "metro 20 min"] } },
  DUB: { name: "Dublin", airports: { DUB: [250, "bus 30 min"] } },
  MAD: { name: "Madrid", airports: { MAD: [150, "metro 30 min"] } },
  NAP: { name: "Neapol", airports: { NAP: [150, "bus 20 min"] } },
  MLA: { name: "Malta", airports: { MLA: [100, "bus 20 min"] } },
};
const GROUPS = { Praha: ["PRG"], Morava: ["KRK", "KTW", "VIE", "BTS", "BRQ", "OSR"] };
const PATTERNS = [[4, 6, "Pá–Ne"], [3, 6, "Čt–Ne"], [4, 0, "Pá–Po"], [5, 0, "So–Po"], [3, 0, "Čt–Po"], [5, 1, "So–Út"]];
const UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
      if (r.ok) return await r.json();
    } catch (e) {}
  }
  return null;
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

module.exports = async (req, res) => {
  const q = req.query || {};
  const destKey = (q.dest || "AMS").toUpperCase();
  const dest = DESTS[destKey];
  if (!dest) return res.status(400).json({ error: "neznámá destinace", dests: Object.keys(DESTS) });
  const months = Math.min(Math.max(parseInt(q.months) || 6, 1), 8);
  const minDays = Math.max(parseInt(q.minDays) || 14, 0);

  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const monthList = []; { let y = today.getUTCFullYear(), m = today.getUTCMonth() + 1;
    for (let k = 0; k <= months; k++) { monthList.push(`${y}-${String(m).padStart(2, "0")}-01`); if (++m > 12) { m = 1; y++; } } }

  // 1) které linky Ryanair z našich letišť do cílových letišť existují
  const origins = [...GROUPS.Praha, ...GROUPS.Morava];
  const routeLists = await pool(origins, 7, (o) => getJSON(`https://www.ryanair.com/api/views/locate/searchWidget/routes/en/airport/${o}`));
  const pairs = [];
  origins.forEach((o, i) => (routeLists[i] || []).forEach((r) => {
    const a = r.arrivalAirport && r.arrivalAirport.code;
    if (a && dest.airports[a]) pairs.push([o, a]);
  }));

  // 2) nejnižší cena po dnech, oba směry
  const jobs = [];
  for (const [o, d] of pairs) for (const mo of monthList) { jobs.push([o, d, mo]); jobs.push([d, o, mo]); }
  const fares = {};
  await pool(jobs, 12, async ([o, d, mo]) => {
    const j = await getJSON(`https://www.ryanair.com/api/farfnd/v4/oneWayFares/${o}/${d}/cheapestPerDay?outboundMonthOfDate=${mo}&currency=CZK`);
    const key = `${o}-${d}`; fares[key] = fares[key] || {};
    for (const f of (j && j.outbound && j.outbound.fares) || [])
      if (f.price && !f.soldOut && !f.unavailable) fares[key][f.day] = { p: Math.round(f.price.value), t: f.departureDate.slice(11, 16), a: f.arrivalDate.slice(11, 16) };
  });

  // 3) víkendové kombinace
  function best(group, start, ret) {
    let b = null;
    for (const [o, d] of pairs) {
      if (!GROUPS[group].includes(o)) continue;
      const there = (fares[`${o}-${d}`] || {})[start], back = (fares[`${d}-${o}`] || {})[ret];
      if (!there || !back) continue;
      const flight = there.p + back.p, transfer = dest.airports[d][0];
      if (!b || flight + transfer < b.door)
        b = { from: o, to: d, out: there, back, flight, transfer, door: flight + transfer, transferNote: dest.airports[d][1] };
    }
    return b;
  }
  const rows = [];
  const end = addDays(today, 31 * months);
  for (let d = addDays(today, minDays); d < end; d = addDays(d, 1)) {
    for (const [wo, wr, label] of PATTERNS) {
      if (d.getUTCDay() !== (wo + 1) % 7) continue; // JS: 0=Ne
      const ret = addDays(d, ((wr - wo) % 7 + 7) % 7);
      const praha = best("Praha", iso(d), iso(ret)), morava = best("Morava", iso(d), iso(ret));
      if (praha || morava) rows.push({ start: iso(d), ret: iso(ret), pattern: label, nights: (ret - d) / 864e5, praha, morava });
    }
  }

  res.setHeader("Cache-Control", "public, s-maxage=10800, stale-while-revalidate=86400");
  res.status(200).json({
    generated: new Date().toISOString(), dest: destKey, destName: dest.name, note: dest.note || null,
    dests: Object.fromEntries(Object.entries(DESTS).map(([k, v]) => [k, v.name])),
    routes: pairs.map((p) => p.join("→")), rows,
  });
};
