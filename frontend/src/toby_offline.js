import { Chess } from 'chess.js';
import { registerPlugin } from '@capacitor/core';

const TobyOfflineNative = registerPlugin('TobyOffline');

const FILES = 'abcdefgh';
const PIECE_IDX = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const CADENCES = ['bullet', 'blitz', 'rapid', 'classical'];
const VENUES = ['online', 'otb'];

export const OFFLINE_SAMPLE_GAMES = [
  {
    id: 'opera-game',
    title: "Morphy'nin Opera Oyunu (1858)",
    subtitle: '17 hamle · Hızlı offline test için ideal klasik hücum',
    time_control: 'Classical',
    pgn: `[Event "Paris Opera"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[WhiteElo "2550"]
[BlackElo "1800"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`,
  },
  {
    id: 'carlsen-anand',
    title: 'Carlsen - Anand (2014 Dünya Şampiyonası)',
    subtitle: '34 hamle · Büyükusta düzeyinde konumsal mücadele',
    time_control: 'Classical',
    pgn: `[Event "World Chess Championship 2014"]
[White "Magnus Carlsen"]
[Black "Viswanathan Anand"]
[WhiteElo "2863"]
[BlackElo "2792"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3 Bc5 5. O-O d6 6. Re1 O-O 7. Bxc6 bxc6
8. h3 Re8 9. Nbd2 Nd7 10. Nc4 Bb6 11. a4 a5 12. Nxb6 cxb6 13. d4 Qc7
14. Ra3 Nf8 15. dxe5 dxe5 16. Nh4 Rd8 17. Qh5 f6 18. Nf5 Be6 19. Rg3 Ng6
20. h4 Bxf5 21. exf5 Nf4 22. Bxf4 exf4 23. Rc3 c5 24. Re6 Rab8 25. Rc4 Qd7
26. Kh2 Rf8 27. Rce4 Rb7 28. Qe2 b5 29. b3 bxa4 30. bxa4 Rb4 31. Re7 Qd6
32. Qf3 Rxe4 33. Qxe4 f3+ 34. g3 h5 1-0`,
  },
  {
    id: 'club-tactical',
    title: 'Kulüp Maçı — İtalyan Açılışı (1600 vs 1600)',
    subtitle: '22 hamle · Amatör / kulüp seviyesi taktik hatalar',
    time_control: 'Rapid',
    pgn: `[Event "Kulüp Turnuvası"]
[White "Ahmet"]
[Black "Mehmet"]
[WhiteElo "1600"]
[BlackElo "1600"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Bd2 Bxd2+
8. Nbxd2 d5 9. exd5 Nxd5 10. Qb3 Nce7 11. O-O O-O 12. Rfe1 c6 13. Ne4 Bf5
14. Ng3 Bg6 15. Ne5 Qc7 16. Rac1 Rad8 17. Nxg6 hxg6 18. Ne4 Rfe8 19. Ng5 Qd7
20. Qh3 Qxh3 21. Nxh3 Nf5 22. Rxe8+ Rxe8 1-0`,
  },
];

// Build exact 4352-move vocabulary matching toby2.py
const VOCAB = (() => {
  const map = new Map();
  let idx = 0;
  for (let a = 0; a < 64; a++) {
    const af = FILES[a & 7];
    const ar = (a >> 3) + 1;
    for (let b = 0; b < 64; b++) {
      const bf = FILES[b & 7];
      const br = (b >> 3) + 1;
      map.set(`${af}${ar}${bf}${br}`, idx++);
    }
  }
  for (let fi = 0; fi < 8; fi++) {
    for (let ti = 0; ti < 8; ti++) {
      for (const p of ['q', 'r', 'b', 'n']) {
        map.set(`${FILES[fi]}7${FILES[ti]}8${p}`, idx++);
      }
    }
  }
  return map;
})();

function mirrorUci(u) {
  return u[0] + String(9 - Number(u[1])) + u[2] + String(9 - Number(u[3])) + u.slice(4);
}

export function vidx(uci, isWhite) {
  const key = isWhite ? uci : mirrorUci(uci);
  const v = VOCAB.get(key);
  return v === undefined ? -1 : v;
}

const VIDX_E1G1 = vidx('e1g1', true);
const VIDX_E1C1 = vidx('e1c1', true);
const VIDX_E1H1 = vidx('e1h1', true);
const VIDX_E1A1 = vidx('e1a1', true);

let cachedMeta = null;

async function loadMeta() {
  if (cachedMeta) return cachedMeta;
  const res = await fetch('/toby2_meta.json');
  if (!res.ok) throw new Error('toby2_meta.json yüklenemedi');
  cachedMeta = await res.json();
  return cachedMeta;
}

function float32ToBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function ratingRbf(elo, rbfC) {
  const out = new Float32Array(rbfC.length);
  for (let i = 0; i < rbfC.length; i++) {
    const d = (elo - rbfC[i]) / 250.0;
    out[i] = Math.exp(-d * d);
  }
  return out;
}

export function buildSideInputs(timeControl, ratingSource) {
  const tc = (timeControl || 'Classical').toLowerCase();
  const cadIdx = CADENCES.indexOf(tc) >= 0 ? CADENCES.indexOf(tc) : 3;
  const isOnline =
    ratingSource &&
    ratingSource !== 'FIDE' &&
    tc !== 'classical';
  const venueIdx = isOnline ? 0 : 1; // 0 = online, 1 = otb
  const out = new Float32Array(12);
  out[6 + cadIdx] = 10.0;
  out[10 + venueIdx] = 10.0;
  return out;
}

function buildExtra(moverElo, oppElo, side, rbfC) {
  const r1 = ratingRbf(moverElo, rbfC);
  const r2 = ratingRbf(oppElo, rbfC);
  const extra = new Float32Array(36);
  extra.set(r1, 0);
  extra.set(r2, 12);
  extra.set(side, 24);
  return { r1, r2, extra };
}

function positionKey(board) {
  const parts = board.fen().split(' ');
  return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

/**
 * Exact Leela Chess Zero 112-plane encoder (FMT=1 CLASSICAL) matching leela_torch.py.
 */
export function encodePositionPlanes(fen, moves) {
  const boards = [];
  const root = fen ? new Chess(fen) : new Chess();
  boards.push(new Chess(root.fen()));

  if (moves && moves.length && !fen) {
    for (const uci of moves) {
      const m = root.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length === 5 ? uci[4] : undefined,
      });
      if (!m) break;
      boards.push(new Chess(root.fen()));
    }
  }

  const cur = boards[boards.length - 1];
  const curBlack = cur.turn() === 'b';
  const planes = new Float32Array(112 * 64);

  // Repetition counts
  const keyCounts = new Map();
  const reps = boards.map((b) => {
    const k = positionKey(b);
    const c = (keyCounts.get(k) || 0) + 1;
    keyCounts.set(k, c);
    return c - 1;
  });

  // Up to 8 history boards, newest first
  const nHist = Math.min(8, boards.length);
  for (let i = 0; i < nHist; i++) {
    const bIdx = boards.length - 1 - i;
    const b = boards[bIdx];
    const grid = b.board(); // grid[0] = rank 8, grid[7] = rank 1
    const base = i * 13;

    for (let r8 = 0; r8 < 8; r8++) {
      const rank = 7 - r8; // 0 = rank 1, 7 = rank 8
      const outRank = curBlack ? 7 - rank : rank;
      for (let file = 0; file < 8; file++) {
        const p = grid[r8][file];
        if (!p) continue;
        const pType = PIECE_IDX[p.type];
        const isOurs = curBlack ? p.color === 'b' : p.color === 'w';
        const planeIdx = base + (isOurs ? pType : 6 + pType);
        planes[planeIdx * 64 + outRank * 8 + file] = 1.0;
      }
    }

    if (reps[bIdx] >= 1) {
      planes.fill(1.0, (base + 12) * 64, (base + 13) * 64);
    }
  }

  // Planes 104..107: castling rights (we 000, we 00, they 000, they 00)
  const fenParts = cur.fen().split(' ');
  const castling = fenParts[2] || '-';
  const wq = castling.includes('Q');
  const wk = castling.includes('K');
  const bq = castling.includes('q');
  const bk = castling.includes('k');
  const cFlags = curBlack ? [bq, bk, wq, wk] : [wq, wk, bq, bk];
  for (let k = 0; k < 4; k++) {
    if (cFlags[k]) {
      planes.fill(1.0, (104 + k) * 64, (105 + k) * 64);
    }
  }

  // Plane 108: side to move is Black
  if (curBlack) {
    planes.fill(1.0, 108 * 64, 109 * 64);
  }

  // Plane 109: rule-50 halfmove clock
  const r50 = Number(fenParts[4] || 0);
  planes.fill(r50, 109 * 64, 110 * 64);

  // Plane 110: zeros (already 0)
  // Plane 111: ones
  planes.fill(1.0, 111 * 64, 112 * 64);

  const verboseMoves = cur.moves({ verbose: true });
  const legal = verboseMoves.map((m) => `${m.from}${m.to}${m.promotion || ''}`);
  const sans = verboseMoves.map((m) => m.san);

  return { board: cur, planes, legal, sans, black: curBlack };
}

function buildMoveIndices(enc, meta) {
  const L = enc.legal.length;
  const idx = new Array(L);
  const sqf = new Array(L);
  const sqt = new Array(L);
  const kingOnE1 = enc.planes[5 * 64 + 0 * 8 + 4] > 0.5;

  for (let i = 0; i < L; i++) {
    const mi = vidx(enc.legal[i], !enc.black);
    let gi = meta.vt[mi];
    if (kingOnE1) {
      if (mi === VIDX_E1G1) gi = meta.vt[VIDX_E1H1];
      else if (mi === VIDX_E1C1) gi = meta.vt[VIDX_E1A1];
    }
    idx[i] = gi;
    sqf[i] = meta.sqf[mi];
    sqt[i] = meta.sqt[mi];
  }
  return { idx, sqf, sqt };
}

function buildFrMasked(L, r1, r2) {
  const fr = new Float32Array(L * 31);
  for (let i = 0; i < L; i++) {
    const off = i * 31;
    // 0..6 are 0.0 (masked Stockfish features)
    fr.set(r1, off + 7);
    fr.set(r2, off + 19);
  }
  return fr;
}

function softmax(arr) {
  let maxV = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > maxV) maxV = arr[i];
  const exps = new Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    exps[i] = Math.exp(arr[i] - maxV);
    sum += exps[i];
  }
  return exps.map((v) => v / sum);
}

// ---------- Calibrated Rating Estimation (exact match to backend/toby_engine.py) ----------
function splineBasis(x, knots, bounds) {
  const r = Math.max(bounds[0], Math.min(bounds[1], x));
  return [1.0, r, ...knots.map((k) => Math.max(0.0, r - k))];
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function estimatePlayerRating(grid, sumCurve, cal, knownRating = null, oppRating = null, playerResult = null) {
  const knots = cal.spline_knots || cal.knots || [1800, 2200, 2500];
  const bounds = cal.bounds || [1400, 2800];
  const cEr = cal.result_c?.E_R ?? cal.c_er ?? 300;
  const sdScale = cal.sd_scale ?? 1.4584;

  const resultTerm = (cVal, rOpp) => {
    if (playerResult == null || cVal <= 0) return grid.map(() => 0);
    return grid.map((e) => {
      const pWin = Math.max(1e-6, Math.min(1 - 1e-6, 1 / (1 + Math.pow(10, (rOpp - e) / 400))));
      return (playerResult * Math.log(pWin) + (1 - playerResult) * Math.log(1 - pWin)) * (cVal / 400);
    });
  };

  if (knownRating != null && knownRating > 0) {
    const er = cal.E_R || cal;
    const tau = er.tau ?? er.er_tau ?? 8.0;
    const s = er.s ?? er.er_s ?? 1500.0;
    const driftCoef = er.drift_coef || er.er_drift;
    const r0 = knownRating;
    const rOpp = oppRating && oppRating > 0 ? oppRating : r0;
    const rTerm = resultTerm(cEr, rOpp);
    const logPost = grid.map((e, i) => sumCurve[i] / tau - 0.5 * Math.pow((e - r0) / s, 2) + rTerm[i]);
    const post = softmax(logPost);
    let x = 0;
    for (let i = 0; i < grid.length; i++) x += grid[i] * post[i];
    let v = 0;
    for (let i = 0; i < grid.length; i++) v += Math.pow(grid[i] - x, 2) * post[i];
    const sd = Math.sqrt(v) * sdScale;
    const drift = dot(driftCoef, splineBasis(r0, knots, bounds));
    const est = Math.round(Math.max(800, Math.min(3200, x - drift)));
    return { mode: 'E_R', rating: est, display: String(est), raw_mean: Math.round(x), sd: Math.round(sd), known_rating: knownRating };
  }

  const ea = cal.E_A || cal;
  const tau = ea.tau ?? ea.ea_tau ?? 1.5;
  const priorMean = ea.prior_mean ?? ea.ea_mean ?? 2084.96;
  const priorSd = ea.prior_sd ?? ea.ea_sd ?? 341.99;
  const logPost = grid.map((e, i) => sumCurve[i] / tau - 0.5 * Math.pow((e - priorMean) / priorSd, 2));
  const post = softmax(logPost);
  let x = 0;
  for (let i = 0; i < grid.length; i++) x += grid[i] * post[i];
  let v = 0;
  for (let i = 0; i < grid.length; i++) v += Math.pow(grid[i] - x, 2) * post[i];
  const sd = Math.sqrt(v) * sdScale;

  const disp = cal.ea_display || {};
  const coef = disp.ea_coef_review || ea.coef;
  const eaVal = dot(coef, splineBasis(x, knots, bounds));
  const k = disp.ea_stretch_review ?? disp.ea_stretch ?? 1.15;
  const shown = Math.max(bounds[0], Math.min(bounds[1], priorMean + k * (eaVal - priorMean)));
  const capHigh = disp.ea_cap_high ?? 2500;
  const capLow = disp.ea_cap_low ?? 1600;
  let display = String(Math.round(shown));
  if (shown >= capHigh) display = `${capHigh}+`;
  else if (shown < capLow) display = `${capLow} altı`;

  return { mode: 'E_A', rating: Math.round(shown), display, raw_mean: Math.round(x), sd: Math.round(sd), known_rating: null };
}

function trAcc(n) {
  const last = n % 10;
  if (last === 0) {
    const tens = Math.floor((n % 100) / 10);
    const map = { 1: 'unu', 2: 'sini', 3: 'unu', 4: 'ını', 5: 'sini', 6: 'ını', 7: 'ini', 8: 'ini', 9: 'ını', 0: 'ını' };
    return `${n}'${map[tens] || 'ını'}`;
  }
  const map = { 1: 'ini', 2: 'sini', 3: 'ünü', 4: 'ünü', 5: 'ini', 6: 'sını', 7: 'sini', 8: 'ini', 9: 'unu' };
  return `${n}'${map[last]}`;
}

// ---------- Public Offline API ----------
export async function offlineHealth() {
  await loadMeta();
  const res = await TobyOfflineNative.initModels();
  return { ok: Boolean(res.ok), engine: 'Toby 2.0 Offline', version: '2.0 Offline', error: null };
}

export async function offlineAnalyze(payload) {
  const meta = await loadMeta();
  const enc = encodePositionPlanes(payload.fen || null, payload.moves || null);
  if (enc.board.isGameOver() || !enc.legal.length) {
    return {
      fen: enc.board.fen(),
      turn: enc.black ? 'b' : 'w',
      game_over: true,
      bestmove: null,
      moves: [],
      position_wdl: null,
      white_wdl: null,
      elapsed_ms: 0,
    };
  }

  const wElo = payload.white_rating || 2000;
  const bElo = payload.black_rating || 2000;
  const moverElo = enc.black ? bElo : wElo;
  const oppElo = enc.black ? wElo : bElo;

  const side = buildSideInputs(payload.time_control, payload.rating_source);
  const { r1, r2, extra } = buildExtra(moverElo, oppElo, side, meta.rbf_c);
  const { idx, sqf, sqt } = buildMoveIndices(enc, meta);
  const fr = buildFrMasked(enc.legal.length, r1, r2);

  const res = await TobyOfflineNative.runPosition({
    planesB64: float32ToBase64(enc.planes),
    extra: Array.from(extra),
    idx,
    sqf,
    sqt,
    frB64: float32ToBase64(fr),
    summ: meta.masked_summ,
  });

  const probs = softmax(res.logits);
  // Toby WDL output is [loss, draw, win] for side to move
  const wdlProbs = softmax(res.wdl);
  const posWdl = [
    Math.round(wdlProbs[2] * 1000),
    Math.round(wdlProbs[1] * 1000),
    Math.round(wdlProbs[0] * 1000),
  ];
  const whiteWdl = enc.black ? [posWdl[2], posWdl[1], posWdl[0]] : posWdl;

  const moves = enc.legal
    .map((uci, i) => ({
      uci,
      san: enc.sans[i],
      prob: Number(probs[i].toFixed(5)),
      prob_pct: Number((probs[i] * 100).toFixed(1)),
      net_prob: Number(probs[i].toFixed(5)),
      net_prob_pct: Number((probs[i] * 100).toFixed(1)),
      wdl: posWdl,
      white_wdl: whiteWdl,
      es: Number(((posWdl[0] + posWdl[1] * 0.5) / 1000).toFixed(4)),
      es_pct: Number(((posWdl[0] + posWdl[1] * 0.5) / 10).toFixed(1)),
    }))
    .sort((a, b) => b.prob - a.prob);

  return {
    fen: enc.board.fen(),
    turn: enc.black ? 'b' : 'w',
    game_over: false,
    bestmove: moves[0]?.uci || null,
    moves,
    position_wdl: posWdl,
    white_wdl: whiteWdl,
    elapsed_ms: res.elapsedMs || 0,
  };
}

export async function offlinePlay(payload) {
  const analysis = await offlineAnalyze(payload);
  if (analysis.game_over || !analysis.moves.length) {
    return { ...analysis, chosen: null };
  }
  const cands = analysis.moves;
  let chosen = cands[0];
  if (payload.sampling_mode !== 'top' && cands.length > 1) {
    const total = cands.reduce((s, m) => s + Math.max(0.0001, m.prob), 0);
    let r = Math.random() * total;
    for (const m of cands) {
      r -= Math.max(0.0001, m.prob);
      if (r <= 0) {
        chosen = m;
        break;
      }
    }
  }
  return { ...analysis, chosen };
}

async function runSingleLevelNative(movesBefore, playedUci, distElo, timeControl, meta) {
  const enc = encodePositionPlanes(null, movesBefore);
  const playedIndex = enc.legal.indexOf(playedUci);
  if (playedIndex < 0) throw new Error(`Geçersiz hamle: ${playedUci}`);

  const side = buildSideInputs(timeControl, 'FIDE');
  const a0 = meta.anchors[0] || 1600;
  const a1 = meta.anchors[1] || 2400;
  const e0 = buildExtra(a0, a0, side, meta.rbf_c);
  const e1 = buildExtra(a1, a1, side, meta.rbf_c);
  const { idx, sqf, sqt } = buildMoveIndices(enc, meta);
  const fr0 = buildFrMasked(enc.legal.length, e0.r1, e0.r2);
  const fr1 = buildFrMasked(enc.legal.length, e1.r1, e1.r2);

  const grid = meta.grid;
  const K = grid.length;
  const rbfAll = new Float32Array((K + 1) * 12);
  for (let k = 0; k < K; k++) {
    rbfAll.set(ratingRbf(grid[k], meta.rbf_c), k * 12);
  }
  rbfAll.set(ratingRbf(distElo, meta.rbf_c), K * 12);

  const res = await TobyOfflineNative.runLevelStep({
    planesB64: float32ToBase64(enc.planes),
    extra0: Array.from(e0.extra),
    extra1: Array.from(e1.extra),
    idx,
    sqf,
    sqt,
    fr0B64: float32ToBase64(fr0),
    fr1B64: float32ToBase64(fr1),
    summ: meta.masked_summ,
    rbfAllB64: float32ToBase64(rbfAll),
    k: K,
    playedIndex,
  });

  return { enc, playedIndex, curve: res.curve, distProbs: res.distProbs };
}

export async function offlineLevelStep(payload) {
  const meta = await loadMeta();
  const startElo = payload.start_elo || 1800;
  const tc = payload.time_control || 'Classical';
  const calGroup = tc.toLowerCase() === 'classical' ? 'classical' : 'rapidblitz';
  const cal = meta.calibration.groups[calGroup] || meta.calibration.groups.classical;

  const { enc, playedIndex, curve, distProbs } = await runSingleLevelNative(
    payload.moves_before || [],
    payload.played_uci,
    startElo,
    tc,
    meta
  );

  const sumCurve =
    payload.prev_curve && payload.prev_curve.length === curve.length
      ? curve.map((v, i) => v + payload.prev_curve[i])
      : [...curve];

  const est = estimatePlayerRating(meta.grid, sumCurve, cal, startElo, payload.opp_elo || startElo, null);
  const nMoves = (payload.moves_count || 0) + 1;
  const blend = Math.min(1.0, nMoves / 4.0);
  const liveElo = Math.round(startElo + blend * (est.rating - startElo));
  const delta = liveElo - startElo;

  let topIdx = 0;
  for (let i = 1; i < distProbs.length; i++) {
    if (distProbs[i] > distProbs[topIdx]) topIdx = i;
  }
  const isPredicted = topIdx === playedIndex;
  const playedProb = distProbs[playedIndex] || 0;
  const badge = isPredicted
    ? { key: 'predicted', label: 'Toby Tahmini' }
    : playedProb >= 0.2
      ? { key: 'good', label: 'İyi' }
      : { key: 'unusual', label: 'Sıra Dışı' };

  return {
    live_elo: liveElo,
    start_elo: startElo,
    delta,
    raw_estimate: est.rating,
    sd: est.sd,
    moves_count: nMoves,
    played_san: enc.sans[playedIndex],
    predicted: isPredicted,
    played_prob_pct: Number((playedProb * 100).toFixed(1)),
    top_move_san: enc.sans[topIdx],
    top_move_prob_pct: Number((distProbs[topIdx] * 100).toFixed(1)),
    es_loss: null,
    classification: badge,
    grid: meta.grid,
    sum_curve: sumCurve,
  };
}

export async function offlineReviewGame(payload, onEvent, signal) {
  const meta = await loadMeta();
  const chess = new Chess();
  let headers = {};
  const uciMoves = [];
  const sanMoves = [];
  const fensBefore = [];
  const fensAfter = [];

  if (payload.pgn && payload.pgn.trim()) {
    chess.loadPgn(payload.pgn);
    headers = chess.header();
    const hist = chess.history({ verbose: true });
    const replay = new Chess();
    for (const m of hist) {
      fensBefore.push(replay.fen());
      sanMoves.push(m.san);
      uciMoves.push(`${m.from}${m.to}${m.promotion || ''}`);
      replay.move(m);
      fensAfter.push(replay.fen());
    }
  } else if (payload.moves && payload.moves.length) {
    for (const u of payload.moves) {
      fensBefore.push(chess.fen());
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!mv) throw new Error(`Geçersiz hamle: ${u}`);
      sanMoves.push(mv.san);
      uciMoves.push(u);
      fensAfter.push(chess.fen());
    }
  }

  if (!uciMoves.length) throw new Error('Oyunda hiç hamle bulunamadı.');

  const parseElo = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 400 && n <= 3500 ? Math.round(n) : null;
  };
  const wName = (payload.white_name || headers.White || 'Beyaz').trim() || 'Beyaz';
  const bName = (payload.black_name || headers.Black || 'Siyah').trim() || 'Siyah';
  const wElo = parseElo(payload.white_rating) || parseElo(headers.WhiteElo);
  const bElo = parseElo(payload.black_rating) || parseElo(headers.BlackElo);
  const resStr = (payload.result || headers.Result || '*').trim();
  const wRes = resStr === '1-0' ? 1.0 : resStr === '0-1' ? 0.0 : resStr === '1/2-1/2' ? 0.5 : null;
  const bRes = wRes != null ? 1.0 - wRes : null;
  const tc = payload.time_control || 'Classical';
  const calGroup = tc.toLowerCase() === 'classical' ? 'classical' : 'rapidblitz';
  const cal = meta.calibration.groups[calGroup] || meta.calibration.groups.classical;

  const total = uciMoves.length;
  onEvent({
    type: 'start',
    total,
    white: { name: wName, known_elo: wElo },
    black: { name: bName, known_elo: bElo },
    result: resStr,
    time_control: tc,
    event: headers.Event || '',
  });

  const grid = meta.grid;
  const whiteCurve = new Array(grid.length).fill(0);
  const blackCurve = new Array(grid.length).fill(0);
  const moveReports = [];
  let wPred = 0, wTot = 0, bPred = 0, bTot = 0;
  const wProbs = [], bProbs = [];

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const isWhite = i % 2 === 0;
    const distElo = (isWhite ? wElo : bElo) || 2000;
    const { enc, playedIndex, curve, distProbs } = await runSingleLevelNative(
      uciMoves.slice(0, i),
      uciMoves[i],
      distElo,
      tc,
      meta
    );

    if (isWhite) {
      for (let k = 0; k < grid.length; k++) whiteCurve[k] += curve[k];
    } else {
      for (let k = 0; k < grid.length; k++) blackCurve[k] += curve[k];
    }

    const ranked = enc.legal
      .map((u, idx) => ({ uci: u, san: enc.sans[idx], prob: distProbs[idx], prob_pct: Number((distProbs[idx] * 100).toFixed(1)) }))
      .sort((a, b) => b.prob - a.prob);

    const top = ranked[0];
    const playedProb = distProbs[playedIndex] || 0;
    const isPredicted = top.uci === uciMoves[i];

    if (isWhite) {
      wTot++;
      if (isPredicted) wPred++;
      wProbs.push(playedProb);
    } else {
      bTot++;
      if (isPredicted) bPred++;
      bProbs.push(playedProb);
    }

    const badge = isPredicted
      ? { key: 'predicted', label: 'Toby Tahmini' }
      : playedProb >= 0.2
        ? { key: 'good', label: 'İyi' }
        : { key: 'unusual', label: 'Sıra Dışı' };

    const report = {
      ply: i + 1,
      move_number: Math.floor(i / 2) + 1,
      side: isWhite ? 'w' : 'b',
      uci: uciMoves[i],
      san: sanMoves[i],
      fen_before: fensBefore[i],
      fen_after: fensAfter[i],
      predicted: isPredicted,
      top_move_uci: top.uci,
      top_move_san: top.san,
      top_move_prob_pct: top.prob_pct,
      played_prob: Number(playedProb.toFixed(5)),
      played_prob_pct: Number((playedProb * 100).toFixed(1)),
      top_predictions: ranked.slice(0, 4),
      classification: badge,
    };
    moveReports.push(report);
    onEvent({ type: 'progress', done: i + 1, total, move: report });
  }

  const wEst = estimatePlayerRating(grid, whiteCurve, cal, wElo, bElo, wRes);
  const bEst = estimatePlayerRating(grid, blackCurve, cal, bElo, wElo, bRes);
  const totalPred = wPred + bPred;
  const totalPredPct = Math.round((totalPred / total) * 100);
  const wPredPct = wTot ? Math.round((wPred / wTot) * 100) : 0;
  const bPredPct = bTot ? Math.round((bPred / bTot) * 100) : 0;
  const allProbs = [...wProbs, ...bProbs];
  const avgProbPct = allProbs.length ? Math.round((allProbs.reduce((a, b) => a + b, 0) / allProbs.length) * 100) : 0;
  const wAvgPct = wProbs.length ? Math.round((wProbs.reduce((a, b) => a + b, 0) / wProbs.length) * 100) : 0;
  const bAvgPct = bProbs.length ? Math.round((bProbs.reduce((a, b) => a + b, 0) / bProbs.length) * 100) : 0;

  const summaryTr =
    `Toby, ${wName} oyununu ${wEst.display} ve ${bName} oyununu ${bEst.display} olarak değerlendirdi. ` +
    `Oynanan ${total} hamlenin ${trAcc(totalPred)} (%${totalPredPct}) doğru tahmin etti: ` +
    `${wName} için ${wPred}/${wTot} (%${wPredPct}), ${bName} için ${bPred}/${bTot} (%${bPredPct}). ` +
    `Oynanan hamlelere ortalama %${avgProbPct} olasılık verdi.`;

  onEvent({
    type: 'done',
    summary_tr: summaryTr,
    result: resStr,
    time_control: tc,
    event: headers.Event || '',
    white: { name: wName, known_elo: wElo, estimate: wEst, predicted: wPred, total: wTot, predicted_pct: wPredPct, avg_prob_pct: wAvgPct },
    black: { name: bName, known_elo: bElo, estimate: bEst, predicted: bPred, total: bTot, predicted_pct: bPredPct, avg_prob_pct: bAvgPct },
    overall: { predicted: totalPred, total, predicted_pct: totalPredPct, avg_prob_pct: avgProbPct },
    moves: moveReports,
  });
}
