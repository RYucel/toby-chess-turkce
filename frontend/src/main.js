import './style.css';
import { Chess } from 'chess.js';
import { ChessBoardUI } from './board.js';
import {
  analyzePosition,
  checkHealth,
  fetchSampleGames,
  getServerUrl,
  isNativeApp,
  playTobyMove,
  setServerUrl,
  streamGameReview,
} from './api.js';

// Register PWA Service Worker (browser only; Capacitor bundles assets natively)
if ('serviceWorker' in navigator && !isNativeApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ---------- App State ----------
const state = {
  tab: 'play', // 'play' | 'review' | 'analyze'
  engineOk: false,
  engineVersion: '2.0',
  deferredInstallPrompt: null,
  sampleGames: [],

  // Play view
  play: {
    chess: new Chess(),
    uciHistory: [],
    humanColor: 'w',
    tobyElo: 1800,
    humanElo: 1800,
    timeControl: 'Classical',
    ratingSource: 'FIDE',
    samplingMode: 'human',
    thinking: false,
    lastAnalysis: null,
    showCoach: true,
    board: null,
  },

  // Review view
  review: {
    running: false,
    abortCtrl: null,
    result: null,
    activePly: 0, // 0 = startpos, 1..N = after ply i
    board: null,
  },

  // Analyze view
  analyze: {
    chess: new Chess(),
    uciHistory: [],
    whiteElo: 2000,
    blackElo: 2000,
    timeControl: 'Classical',
    ratingSource: 'FIDE',
    loading: false,
    result: null,
    board: null,
  },
};

// ---------- Helpers ----------
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function wdlToPercents(wdl) {
  if (!wdl || wdl.length !== 3) return [33, 34, 33];
  const sum = wdl[0] + wdl[1] + wdl[2] || 1000;
  const w = Math.round((wdl[0] / sum) * 100);
  const d = Math.round((wdl[1] / sum) * 100);
  const b = Math.max(0, 100 - w - d);
  return [w, d, b];
}

function renderWdlBar(prefix, whiteWdl) {
  const [w, d, b] = wdlToPercents(whiteWdl);
  const wEl = document.getElementById(`${prefix}-wdl-w`);
  const dEl = document.getElementById(`${prefix}-wdl-d`);
  const bEl = document.getElementById(`${prefix}-wdl-b`);
  const lbl = document.getElementById(`${prefix}-wdl-label`);
  if (wEl) wEl.style.width = `${w}%`;
  if (dEl) dEl.style.width = `${d}%`;
  if (bEl) bEl.style.width = `${b}%`;
  if (lbl) lbl.textContent = whiteWdl ? `B %${w} · Ber %${d} · S %${b}` : 'WDL bekleniyor';
}

function buildProbabilityChart(moves, activePly) {
  if (!moves || !moves.length) return '';
  const width = 420;
  const height = 88;
  const padX = 8;
  const padY = 10;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const n = moves.length;

  const pts = moves.map((m, i) => {
    const x = padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const p = Math.max(0, Math.min(100, m.played_prob_pct || 0));
    const y = padY + innerH * (1 - p / 100);
    return { x, y, m, i };
  });

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padY + innerH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padY + innerH).toFixed(1)} Z`;

  const dots = pts
    .map((p) => {
      const isActive = p.m.ply === activePly;
      const color = p.m.classification?.key === 'blunder'
        ? '#c85a4a'
        : p.m.predicted
          ? '#4e9f72'
          : '#c99b52';
      const r = isActive ? 5 : 2.6;
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}" stroke="${isActive ? '#f4efe6' : 'none'}" stroke-width="1.5" data-ply="${p.m.ply}" style="cursor:pointer"/>`;
    })
    .join('');

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="${padX}" y1="${padY + innerH * 0.5}" x2="${width - padX}" y2="${padY + innerH * 0.5}" stroke="rgba(244,239,230,0.08)" stroke-dasharray="3 3"/>
      <path d="${areaPath}" fill="rgba(201,155,82,0.12)"/>
      <path d="${linePath}" fill="none" stroke="#c99b52" stroke-width="1.8" stroke-linejoin="round"/>
      ${dots}
    </svg>
  `;
}

// ---------- Render Shell ----------
function mountApp() {
  const root = document.getElementById('app');
  root.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <img src="/icons/icon-192.png" alt="Toby Satranç" class="brand-icon" />
        <div>
          <h1 class="brand-title">Toby Satranç</h1>
          <div class="brand-sub">The Oracle By Yosha · v2.0</div>
        </div>
      </div>

      <nav class="desktop-nav" aria-label="Ana menü">
        <button class="nav-pill active" data-tab="play">Oyna</button>
        <button class="nav-pill" data-tab="review">Oyun İnceleme</button>
        <button class="nav-pill" data-tab="analyze">Analiz</button>
      </nav>

      <div class="topbar-actions">
        <span class="status-chip" id="engine-status">
          <span class="status-dot" id="engine-dot"></span>
          <span id="engine-status-text">Bağlanıyor</span>
        </span>
        <button class="icon-btn" id="btn-install-open" title="Telefona Kur">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="icon-btn" id="btn-settings-open" title="Sunucu Ayarları">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </header>

    <div class="install-banner hidden" id="install-banner">
      <span>Toby Satranç'ı telefonunuza uygulama olarak kurun.</span>
      <button class="btn btn-primary btn-sm" id="btn-install-pwa">Kur</button>
    </div>

    <main class="main-wrap">
      <!-- ==================== VIEW 1: PLAY ==================== -->
      <section class="view active" id="view-play">
        <div class="workspace-grid">
          <div class="board-col">
            <div class="player-strip" id="play-top-strip">
              <div class="player-meta">
                <span class="player-avatar black" id="play-top-avatar">T</span>
                <span class="player-name" id="play-top-name">Toby 2</span>
                <span class="player-elo" id="play-top-elo">1800</span>
              </div>
              <span class="turn-tag" id="play-top-turn"></span>
            </div>

            <div id="play-board"></div>

            <div class="player-strip" id="play-bottom-strip">
              <div class="player-meta">
                <span class="player-avatar white" id="play-bottom-avatar">S</span>
                <span class="player-name" id="play-bottom-name">Sen</span>
                <span class="player-elo" id="play-bottom-elo">1800</span>
              </div>
              <span class="turn-tag" id="play-bottom-turn">Hamle sırası sende</span>
            </div>

            <div class="wdl-wrap">
              <div class="wdl-header">
                <span>Toby Kazanma / Beraberlik / Kayıp</span>
                <span id="play-wdl-label">WDL bekleniyor</span>
              </div>
              <div class="wdl-bar">
                <div class="wdl-w" id="play-wdl-w" style="width:36%"></div>
                <div class="wdl-d" id="play-wdl-d" style="width:36%"></div>
                <div class="wdl-b" id="play-wdl-b" style="width:28%"></div>
              </div>
            </div>
          </div>

          <div class="panel-col">
            <div class="card">
              <div class="card-title">
                <span>Oyun Kontrolleri</span>
                <span class="badge badge-gold" id="play-status-badge">Devam Ediyor</span>
              </div>
              <div class="btn-row" style="margin-bottom:10px">
                <button class="btn btn-primary btn-sm" id="btn-new-game">Yeni Oyun</button>
                <button class="btn btn-sm" id="btn-play-hint">Toby İpucu</button>
                <button class="btn btn-sm" id="btn-play-undo">Geri Al</button>
                <button class="btn btn-sm" id="btn-play-flip">Çevir</button>
              </div>
              <button class="btn btn-full" id="btn-send-to-review" disabled>
                Bu Oyunu Toby ile İncele (ELO &amp; Tahmin)
              </button>
            </div>

            <div class="card">
              <div class="card-title">Toby 2 Oyun Ayarları</div>
              <div class="form-grid">
                <div class="field full">
                  <label>Toby ELO Seviyesi <strong id="lbl-toby-elo">1800</strong></label>
                  <input type="range" id="rng-toby-elo" min="800" max="2900" step="50" value="1800" />
                </div>
                <div class="field">
                  <label>Senin Tarafın</label>
                  <select class="select" id="sel-human-color">
                    <option value="w">Beyaz</option>
                    <option value="b">Siyah</option>
                  </select>
                </div>
                <div class="field">
                  <label>Zaman Kontrolü</label>
                  <select class="select" id="sel-play-tc">
                    <option value="Classical">Klasik</option>
                    <option value="Rapid">Hızlı (Rapid)</option>
                    <option value="Blitz">Yıldırım (Blitz)</option>
                  </select>
                </div>
                <div class="field">
                  <label>Rating Sistemi</label>
                  <select class="select" id="sel-play-source">
                    <option value="FIDE">FIDE (Masa Başı)</option>
                    <option value="Lichess Classical">Lichess Klasik</option>
                    <option value="Lichess Rapid">Lichess Hızlı</option>
                    <option value="Lichess Blitz">Lichess Yıldırım</option>
                    <option value="Chess.com Rapid">Chess.com Hızlı</option>
                    <option value="Chess.com Blitz">Chess.com Yıldırım</option>
                  </select>
                </div>
                <div class="field">
                  <label>Oynama Tarzı</label>
                  <select class="select" id="sel-play-style">
                    <option value="human">İnsan Gibi Örnekleme</option>
                    <option value="top">En Olası Hamle</option>
                  </select>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-title">
                <span>Hamle Geçmişi</span>
                <span class="brand-sub" id="play-ply-count">0 hamle</span>
              </div>
              <div class="move-history" id="play-move-history">
                <span style="color:var(--ink-dim)">Tahtadan bir hamle yaparak oyuna başlayın.</span>
              </div>
            </div>

            <div class="card hidden" id="play-hint-card">
              <div class="card-title">Toby'nin Bu Konumdaki İnsan Olasılıkları</div>
              <div class="toby-moves" id="play-hint-moves"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ==================== VIEW 2: GAME REVIEW ==================== -->
      <section class="view" id="view-review">
        <div class="workspace-grid">
          <div class="board-col">
            <div class="player-strip">
              <div class="player-meta">
                <span class="player-avatar black">S</span>
                <span class="player-name" id="rev-black-name">Siyah</span>
                <span class="player-elo" id="rev-black-elo">—</span>
              </div>
              <span class="turn-tag" id="rev-black-pred"></span>
            </div>

            <div id="review-board"></div>

            <div class="player-strip">
              <div class="player-meta">
                <span class="player-avatar white">B</span>
                <span class="player-name" id="rev-white-name">Beyaz</span>
                <span class="player-elo" id="rev-white-elo">—</span>
              </div>
              <span class="turn-tag" id="rev-white-pred"></span>
            </div>

            <div class="btn-row" style="justify-content:center">
              <button class="btn btn-sm" id="btn-rev-first">⏮</button>
              <button class="btn btn-sm" id="btn-rev-prev">◀ Önceki</button>
              <button class="btn btn-sm" id="btn-rev-next">Sonraki ▶</button>
              <button class="btn btn-sm" id="btn-rev-last">⏭</button>
              <button class="btn btn-sm" id="btn-rev-flip">Çevir</button>
            </div>
          </div>

          <div class="panel-col">
            <!-- Hero Summary Card (shown once review completes) -->
            <div class="review-hero hidden" id="rev-hero-card">
              <div class="card-title" style="margin-bottom:12px">
                <span>Toby Performans &amp; Tahmin Raporu</span>
                <button class="btn btn-sm" id="btn-copy-summary">Özeti Kopyala</button>
              </div>
              <div class="elo-compare">
                <div class="elo-box">
                  <div class="elo-box-name" id="hero-w-name">Beyaz</div>
                  <div class="elo-box-val" id="hero-w-elo">—</div>
                  <div class="elo-box-sub" id="hero-w-sub">Tahmin: —</div>
                </div>
                <div class="elo-box">
                  <div class="elo-box-name" id="hero-b-name">Siyah</div>
                  <div class="elo-box-val" id="hero-b-elo">—</div>
                  <div class="elo-box-sub" id="hero-b-sub">Tahmin: —</div>
                </div>
              </div>

              <div class="quote-box" id="hero-quote"></div>

              <div class="kpi-row">
                <div class="kpi-item">
                  <div class="kpi-num" id="hero-kpi-pred">—</div>
                  <div class="kpi-lbl">Doğru Tahmin</div>
                </div>
                <div class="kpi-item">
                  <div class="kpi-num" id="hero-kpi-pct">—</div>
                  <div class="kpi-lbl">Tahmin Oranı</div>
                </div>
                <div class="kpi-item">
                  <div class="kpi-num" id="hero-kpi-prob">—</div>
                  <div class="kpi-lbl">Ort. Hamle Olasılığı</div>
                </div>
              </div>

              <div id="rev-chart-wrap"></div>
            </div>

            <!-- Active Move Detail -->
            <div class="card hidden" id="rev-move-detail">
              <div class="card-title">
                <span id="rev-move-title">Hamle Detayı</span>
                <span class="badge badge-gold" id="rev-move-badge">—</span>
              </div>
              <p class="card-sub" id="rev-move-desc"></p>
              <div class="toby-moves" id="rev-move-preds"></div>
            </div>

            <!-- Move list -->
            <div class="card hidden" id="rev-moves-card">
              <div class="card-title">
                <span>Hamleler</span>
                <span class="brand-sub">Yeşil: Toby tahmini · Kırmızı: Büyük hata</span>
              </div>
              <div class="move-history" id="rev-move-list"></div>
            </div>

            <!-- Progress Card -->
            <div class="card hidden" id="rev-progress-card">
              <div class="card-title">
                <span>Toby 2 Oyunu İnceliyor...</span>
                <span class="brand-sub" id="rev-progress-text">0 / 0</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" id="rev-progress-fill" style="width:0%"></div>
              </div>
              <button class="btn btn-sm btn-ghost" id="btn-rev-cancel" style="margin-top:8px">İptal Et</button>
            </div>

            <!-- PGN Input Card -->
            <div class="card" id="rev-input-card">
              <div class="card-title">Oyun İnceleme (PGN)</div>
              <p class="card-sub">
                PGN yapıştırın veya aşağıdan örnek bir oyun seçin. Toby her hamlenin olasılığını hesaplar, kaç hamleyi doğru tahmin ettiğini ve oyuncuların ELO performansını çıkarır.
              </p>
              <div class="form-grid" style="margin-bottom:10px">
                <div class="field full">
                  <label>PGN Metni</label>
                  <textarea class="textarea" id="txt-rev-pgn" placeholder='[White "Gukesh"]&#10;[Black "Sindarov"]&#10;[WhiteElo "2777"]&#10;[BlackElo "2682"]&#10;&#10;1. e4 e5 2. Nf3 Nc6 ...'></textarea>
                </div>
                <div class="field">
                  <label>Beyaz ELO (Opsiyonel)</label>
                  <input type="number" class="input" id="inp-rev-welo" placeholder="PGN'den veya boş" min="600" max="3200" />
                </div>
                <div class="field">
                  <label>Siyah ELO (Opsiyonel)</label>
                  <input type="number" class="input" id="inp-rev-belo" placeholder="PGN'den veya boş" min="600" max="3200" />
                </div>
                <div class="field full">
                  <label>Zaman Kontrolü</label>
                  <select class="select" id="sel-rev-tc">
                    <option value="Classical">Klasik</option>
                    <option value="Rapid">Hızlı (Rapid)</option>
                    <option value="Blitz">Yıldırım (Blitz)</option>
                  </select>
                </div>
              </div>
              <div class="btn-row">
                <button class="btn btn-primary btn-full" id="btn-start-review">Toby ile İncelemeyi Başlat</button>
              </div>

              <div style="margin-top:14px">
                <div class="card-title" style="font-size:13px">Örnek Oyunlarla Hemen Dene</div>
                <div class="sample-list" id="sample-games-list"></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ==================== VIEW 3: LIVE ORACLE ANALYSIS ==================== -->
      <section class="view" id="view-analyze">
        <div class="workspace-grid">
          <div class="board-col">
            <div id="analyze-board"></div>

            <div class="wdl-wrap">
              <div class="wdl-header">
                <span>Pozisyon WDL (Toby 2)</span>
                <span id="an-wdl-label">Analiz bekleniyor</span>
              </div>
              <div class="wdl-bar">
                <div class="wdl-w" id="an-wdl-w" style="width:36%"></div>
                <div class="wdl-d" id="an-wdl-d" style="width:36%"></div>
                <div class="wdl-b" id="an-wdl-b" style="width:28%"></div>
              </div>
            </div>

            <div class="btn-row" style="justify-content:center">
              <button class="btn btn-primary btn-sm" id="btn-an-run">Toby ile Analiz Et</button>
              <button class="btn btn-sm" id="btn-an-undo">Geri Al</button>
              <button class="btn btn-sm" id="btn-an-reset">Başlangıca Dön</button>
              <button class="btn btn-sm" id="btn-an-flip">Çevir</button>
            </div>
          </div>

          <div class="panel-col">
            <div class="card">
              <div class="card-title">
                <span>Toby 2 Hamle Olasılıkları</span>
                <span class="brand-sub" id="an-timing">Hazır</span>
              </div>
              <p class="card-sub">
                Tahtada hamle yapın veya aşağıdaki ELO ayarlarını değiştirip 1200 ile 2800 oyuncuların aynı konumda ne kadar farklı hamleler seçtiğini görün.
              </p>
              <div class="toby-moves" id="an-moves-list">
                <span style="color:var(--ink-dim)">Konumu analiz etmek için "Toby ile Analiz Et" butonuna basın.</span>
              </div>
            </div>

            <div class="card">
              <div class="card-title">Oracle Parametreleri</div>
              <div class="form-grid">
                <div class="field full">
                  <label>Beyaz ELO <strong id="lbl-an-welo">2000</strong></label>
                  <input type="range" id="rng-an-welo" min="800" max="2900" step="50" value="2000" />
                </div>
                <div class="field full">
                  <label>Siyah ELO <strong id="lbl-an-belo">2000</strong></label>
                  <input type="range" id="rng-an-belo" min="800" max="2900" step="50" value="2000" />
                </div>
                <div class="field">
                  <label>Zaman Kontrolü</label>
                  <select class="select" id="sel-an-tc">
                    <option value="Classical">Klasik</option>
                    <option value="Rapid">Hızlı</option>
                    <option value="Blitz">Yıldırım</option>
                  </select>
                </div>
                <div class="field">
                  <label>Rating Sistemi</label>
                  <select class="select" id="sel-an-src">
                    <option value="FIDE">FIDE</option>
                    <option value="Lichess Rapid">Lichess Hızlı</option>
                    <option value="Lichess Blitz">Lichess Yıldırım</option>
                    <option value="Chess.com Rapid">Chess.com Hızlı</option>
                    <option value="Chess.com Blitz">Chess.com Yıldırım</option>
                  </select>
                </div>
                <div class="field full">
                  <label>FEN Yükle</label>
                  <div class="btn-row">
                    <input type="text" class="input" id="inp-an-fen" placeholder="FEN yapıştırın..." style="flex:1" />
                    <button class="btn btn-sm" id="btn-an-load-fen">Yükle</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- Mobile Bottom Navigation -->
    <nav class="bottom-nav" aria-label="Mobil menü">
      <button class="bnav-btn active" data-tab="play">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Oyna</span>
      </button>
      <button class="bnav-btn" data-tab="review">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 9l-5 5-4-4-3 3"/></svg>
        <span>İnceleme</span>
      </button>
      <button class="bnav-btn" data-tab="analyze">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>Analiz</span>
      </button>
    </nav>

    <!-- Settings Modal -->
    <div class="modal-backdrop hidden" id="modal-settings">
      <div class="modal-card">
        <div class="card-title">
          <span>Toby Sunucu Ayarları</span>
          <button class="btn btn-sm btn-ghost" id="btn-settings-close">Kapat</button>
        </div>
        <p class="card-sub">
          Toby 2 (PyTorch + Stockfish 19) sunucu tarafında çalışır. Aynı ağdaki bilgisayarınızın IP adresini veya tünel adresinizi (örn. <code>https://toby.ornek.com</code>) buraya girebilirsiniz. Aynı sunucudan açıyorsanız boş bırakın.
        </p>
        <div class="field" style="margin-bottom:12px">
          <label>Toby Sunucu URL</label>
          <input type="url" class="input" id="inp-server-url" placeholder="Boş = bu sunucu" />
        </div>
        <div class="btn-row">
          <button class="btn btn-primary btn-full" id="btn-settings-save">Kaydet ve Bağlan</button>
        </div>
      </div>
    </div>

    <!-- Install Guide Modal -->
    <div class="modal-backdrop hidden" id="modal-install">
      <div class="modal-card">
        <div class="card-title">
          <span>Telefona Kurulum (PWA)</span>
          <button class="btn btn-sm btn-ghost" id="btn-install-close">Kapat</button>
        </div>
        <p class="card-sub" style="color:var(--ink)">
          <strong>Android (Chrome / Edge):</strong> Tarayıcı menüsünden <em>"Uygulamayı yükle"</em> veya <em>"Ana ekrana ekle"</em> seçeneğine dokunun.
        </p>
        <p class="card-sub" style="color:var(--ink)">
          <strong>iPhone / iPad (Safari):</strong> Alt menüdeki <em>Paylaş</em> simgesine dokunun, ardından <em>"Ana Ekrana Ekle"</em> seçeneğini seçin.
        </p>
        <button class="btn btn-primary btn-full hidden" id="btn-install-trigger">Şimdi Yükle</button>
      </div>
    </div>

    <div class="toast hidden" id="toast"></div>
  `;
}

// ---------- Navigation ----------
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  document.getElementById(`view-${tab}`)?.classList.add('active');
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

// ---------- Health & Sample Games ----------
async function refreshHealth() {
  const dot = document.getElementById('engine-dot');
  const txt = document.getElementById('engine-status-text');
  try {
    const h = await checkHealth();
    state.engineOk = Boolean(h.ok);
    state.engineVersion = h.version || '2.0';
    dot.className = `status-dot ${h.ok ? 'ok' : 'err'}`;
    txt.textContent = h.ok ? `Toby ${state.engineVersion}` : 'Motor Hatası';
  } catch {
    state.engineOk = false;
    dot.className = 'status-dot err';
    txt.textContent = 'Bağlantı Yok';
  }
}

async function loadSamples() {
  try {
    state.sampleGames = await fetchSampleGames();
    const list = document.getElementById('sample-games-list');
    list.innerHTML = '';
    for (const g of state.sampleGames) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sample-btn';
      btn.innerHTML = `<div class="sample-title">${g.title}</div><div class="sample-sub">${g.subtitle}</div>`;
      btn.addEventListener('click', () => {
        document.getElementById('txt-rev-pgn').value = g.pgn;
        document.getElementById('sel-rev-tc').value = g.time_control || 'Classical';
        document.getElementById('inp-rev-welo').value = '';
        document.getElementById('inp-rev-belo').value = '';
        startGameReview();
      });
      list.appendChild(btn);
    }
  } catch {
    // silent if offline
  }
}

// ---------- PLAY VIEW LOGIC ----------
function updatePlayUI() {
  const p = state.play;
  const hist = p.chess.history({ verbose: true });
  const last = hist.length ? { from: hist[hist.length - 1].from, to: hist[hist.length - 1].to } : null;
  p.board.setPosition(p.chess.fen(), last);

  // Player strips based on board orientation
  const isHumanWhite = p.humanColor === 'w';
  const topIsWhite = p.board.orientation === 'b';
  const topIsHuman = (topIsWhite && isHumanWhite) || (!topIsWhite && !isHumanWhite);

  document.getElementById('play-top-name').textContent = topIsHuman ? 'Sen' : 'Toby 2';
  document.getElementById('play-bottom-name').textContent = topIsHuman ? 'Toby 2' : 'Sen';
  document.getElementById('play-top-elo').textContent = String(topIsHuman ? p.humanElo : p.tobyElo);
  document.getElementById('play-bottom-elo').textContent = String(topIsHuman ? p.tobyElo : p.humanElo);
  document.getElementById('play-top-avatar').className = `player-avatar ${topIsWhite ? 'white' : 'black'}`;
  document.getElementById('play-top-avatar').textContent = topIsHuman ? 'S' : 'T';
  document.getElementById('play-bottom-avatar').className = `player-avatar ${topIsWhite ? 'black' : 'white'}`;
  document.getElementById('play-bottom-avatar').textContent = topIsHuman ? 'T' : 'S';

  const turn = p.chess.turn();
  const topTurnEl = document.getElementById('play-top-turn');
  const botTurnEl = document.getElementById('play-bottom-turn');
  topTurnEl.className = 'turn-tag';
  botTurnEl.className = 'turn-tag';

  if (p.thinking) {
    if (topIsHuman) {
      botTurnEl.textContent = 'Toby düşünüyor...';
      botTurnEl.classList.add('thinking');
      topTurnEl.textContent = '';
    } else {
      topTurnEl.textContent = 'Toby düşünüyor...';
      topTurnEl.classList.add('thinking');
      botTurnEl.textContent = '';
    }
  } else if (p.chess.isGameOver()) {
    topTurnEl.textContent = '';
    botTurnEl.textContent = 'Oyun bitti';
  } else {
    const isTopTurn = (turn === 'w' && topIsWhite) || (turn === 'b' && !topIsWhite);
    topTurnEl.textContent = isTopTurn ? 'Sıra onda' : '';
    botTurnEl.textContent = isTopTurn ? '' : 'Hamle sırası sende';
  }

  // Game status badge
  const badge = document.getElementById('play-status-badge');
  if (p.chess.isCheckmate()) {
    const winner = turn === 'w' ? 'Siyah' : 'Beyaz';
    badge.textContent = `Şah Mat · ${winner} Kazandı`;
    badge.className = 'badge badge-ok';
  } else if (p.chess.isDraw()) {
    badge.textContent = 'Beraberlik';
    badge.className = 'badge badge-warn';
  } else if (p.chess.inCheck()) {
    badge.textContent = 'Şah!';
    badge.className = 'badge badge-err';
  } else {
    badge.textContent = p.thinking ? 'Toby Düşünüyor...' : 'Devam Ediyor';
    badge.className = 'badge badge-gold';
  }

  // Move history
  const mhEl = document.getElementById('play-move-history');
  document.getElementById('play-ply-count').textContent = `${hist.length} hamle`;
  document.getElementById('btn-send-to-review').disabled = hist.length < 2;

  if (!hist.length) {
    mhEl.innerHTML = '<span style="color:var(--ink-dim)">Tahtadan bir hamle yaparak oyuna başlayın.</span>';
  } else {
    mhEl.innerHTML = hist
      .map((m, i) => {
        const prefix = i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : '';
        return `<span class="move-chip ${i === hist.length - 1 ? 'active' : ''}">${prefix}${m.san}</span>`;
      })
      .join('');
    mhEl.scrollTop = mhEl.scrollHeight;
  }
}

async function requestTobyReply() {
  const p = state.play;
  if (p.chess.isGameOver() || p.thinking) return;
  p.thinking = true;
  p.board.setArrows([]);
  updatePlayUI();

  try {
    const whiteElo = p.humanColor === 'w' ? p.humanElo : p.tobyElo;
    const blackElo = p.humanColor === 'b' ? p.humanElo : p.tobyElo;
    const res = await playTobyMove({
      moves: p.uciHistory,
      white_rating: whiteElo,
      black_rating: blackElo,
      time_control: p.timeControl,
      rating_source: p.ratingSource,
      sampling_mode: p.samplingMode,
    });
    p.lastAnalysis = res;
    if (res.white_wdl) renderWdlBar('play', res.white_wdl);

    if (res.chosen && res.chosen.uci) {
      const u = res.chosen.uci;
      const moveObj = p.chess.move({
        from: u.slice(0, 2),
        to: u.slice(2, 4),
        promotion: u.length === 5 ? u[4] : undefined,
      });
      if (moveObj) {
        p.uciHistory.push(u);
      }
    }
  } catch (err) {
    toast(err.message || 'Toby hamle üretemedi');
  } finally {
    p.thinking = false;
    updatePlayUI();
  }
}

function startNewGame() {
  const p = state.play;
  p.chess = new Chess();
  p.uciHistory = [];
  p.thinking = false;
  p.lastAnalysis = null;
  p.humanColor = document.getElementById('sel-human-color').value;
  p.tobyElo = Number(document.getElementById('rng-toby-elo').value);
  p.humanElo = p.tobyElo;
  p.timeControl = document.getElementById('sel-play-tc').value;
  p.ratingSource = document.getElementById('sel-play-source').value;
  p.samplingMode = document.getElementById('sel-play-style').value;

  p.board.setOrientation(p.humanColor);
  p.board.setArrows([]);
  document.getElementById('play-hint-card').classList.add('hidden');
  renderWdlBar('play', null);
  updatePlayUI();

  if (p.humanColor === 'b') {
    requestTobyReply();
  }
}

async function requestPlayHint() {
  const p = state.play;
  if (p.thinking || p.chess.isGameOver()) return;
  p.thinking = true;
  updatePlayUI();
  try {
    const res = await analyzePosition({
      moves: p.uciHistory,
      white_rating: p.tobyElo,
      black_rating: p.tobyElo,
      time_control: p.timeControl,
      rating_source: p.ratingSource,
    });
    if (res.white_wdl) renderWdlBar('play', res.white_wdl);
    const top3 = (res.moves || []).slice(0, 3);
    p.board.setArrows(
      top3.map((m, idx) => ({
        from: m.uci.slice(0, 2),
        to: m.uci.slice(2, 4),
        prob: m.prob,
        label: `%${Math.round(m.prob_pct)}`,
        color: idx === 0 ? '#c99b52' : '#4e9f72',
      }))
    );
    const card = document.getElementById('play-hint-card');
    const list = document.getElementById('play-hint-moves');
    list.innerHTML = renderTobyMoveRows(res.moves.slice(0, 5));
    card.classList.remove('hidden');
  } catch (err) {
    toast(err.message);
  } finally {
    p.thinking = false;
    updatePlayUI();
  }
}

function renderTobyMoveRows(moves, playedUci = null) {
  if (!moves || !moves.length) {
    return '<span style="color:var(--ink-dim)">Hamle verisi yok.</span>';
  }
  return moves
    .map((m) => {
      const pct = Math.max(0, Math.min(100, m.prob_pct ?? 0));
      const isPlayed = playedUci && m.uci === playedUci;
      const wdlText = m.wdl
        ? `G ${Math.round(m.wdl[0] / 10)}% · B ${Math.round(m.wdl[1] / 10)}%`
        : '';
      return `
        <div class="toby-move-row ${isPlayed ? 'is-played' : ''}" data-uci="${m.uci}">
          <span class="move-san">${m.san}</span>
          <div>
            <div class="prob-meta">
              <span>Toby: %${m.prob_pct}</span>
              ${m.net_prob_pct != null ? `<span>Ağ: %${m.net_prob_pct}</span>` : ''}
            </div>
            <div class="prob-track"><div class="prob-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="move-wdl-pill">${wdlText}</div>
        </div>
      `;
    })
    .join('');
}

// ---------- REVIEW VIEW LOGIC ----------
function showReviewPly(ply) {
  const rv = state.review;
  const data = rv.result;
  if (!data || !data.moves.length) return;

  const clamped = Math.max(0, Math.min(data.moves.length, ply));
  rv.activePly = clamped;

  if (clamped === 0) {
    rv.board.setPosition(data.moves[0].fen_before, null);
    rv.board.setArrows([]);
    document.getElementById('rev-move-detail').classList.add('hidden');
  } else {
    const m = data.moves[clamped - 1];
    const last = { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4) };
    rv.board.setPosition(m.fen_after, last);

    // Show arrows comparing Toby's top prediction vs played move (from before position? No, highlight top move on next or show played vs top!)
    const arrows = [];
    if (!m.predicted && m.top_move_uci) {
      arrows.push({
        from: m.top_move_uci.slice(0, 2),
        to: m.top_move_uci.slice(2, 4),
        prob: (m.top_move_prob_pct || 40) / 100,
        label: `Toby %${Math.round(m.top_move_prob_pct)}`,
        color: '#4e9f72',
      });
    }
    rv.board.setArrows(arrows);

    const detail = document.getElementById('rev-move-detail');
    detail.classList.remove('hidden');
    const sideLabel = m.side === 'w' ? 'Beyaz' : 'Siyah';
    document.getElementById('rev-move-title').textContent = `${m.move_number}.${m.side === 'b' ? '..' : ''} ${m.san} (${sideLabel})`;

    const badge = document.getElementById('rev-move-badge');
    badge.textContent = m.classification?.label || '—';
    const clsKey = m.classification?.key || '';
    badge.className = `badge ${
      clsKey === 'blunder' || clsKey === 'mistake'
        ? 'badge-err'
        : clsKey === 'predicted_best' || clsKey === 'predicted' || clsKey === 'best'
          ? 'badge-ok'
          : 'badge-gold'
    }`;

    const desc = m.predicted
      ? `Toby bu hamleyi 1. sırada doğru tahmin etti (%${m.played_prob_pct} olasılık).`
      : `Toby oynanan ${m.san} hamlesine %${m.played_prob_pct} olasılık verdi; 1. tahmini ${m.top_move_san} (%${m.top_move_prob_pct}) idi.`;
    document.getElementById('rev-move-desc').textContent = desc;
    document.getElementById('rev-move-preds').innerHTML = renderTobyMoveRows(m.top_predictions || [], m.uci);
  }

  // Update active move chip
  document.querySelectorAll('#rev-move-list .move-chip').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.ply) === clamped);
  });

  // Refresh chart active dot
  const chartWrap = document.getElementById('rev-chart-wrap');
  if (chartWrap && data.moves.length) {
    chartWrap.innerHTML = buildProbabilityChart(data.moves, clamped);
    chartWrap.querySelectorAll('circle[data-ply]').forEach((c) => {
      c.addEventListener('click', () => showReviewPly(Number(c.dataset.ply)));
    });
  }
}

async function startGameReview(overridePayload = null) {
  const rv = state.review;
  if (rv.running) return;

  const pgn = overridePayload?.pgn ?? document.getElementById('txt-rev-pgn').value.trim();
  const moves = overridePayload?.moves ?? null;
  if (!pgn && (!moves || !moves.length)) {
    toast('Lütfen bir PGN yapıştırın veya örnek oyun seçin.');
    return;
  }

  const wEloVal = overridePayload?.white_rating ?? (document.getElementById('inp-rev-welo').value ? Number(document.getElementById('inp-rev-welo').value) : null);
  const bEloVal = overridePayload?.black_rating ?? (document.getElementById('inp-rev-belo').value ? Number(document.getElementById('inp-rev-belo').value) : null);
  const tc = overridePayload?.time_control ?? document.getElementById('sel-rev-tc').value;

  rv.running = true;
  rv.abortCtrl = new AbortController();
  rv.result = null;

  document.getElementById('rev-progress-card').classList.remove('hidden');
  document.getElementById('rev-hero-card').classList.add('hidden');
  document.getElementById('rev-moves-card').classList.add('hidden');
  document.getElementById('rev-move-detail').classList.add('hidden');
  document.getElementById('rev-progress-fill').style.width = '4%';
  document.getElementById('rev-progress-text').textContent = 'Başlatılıyor...';

  try {
    await streamGameReview(
      {
        pgn: pgn || null,
        moves,
        white_rating: wEloVal,
        black_rating: bEloVal,
        time_control: tc,
        white_name: overridePayload?.white_name,
        black_name: overridePayload?.black_name,
        result: overridePayload?.result,
      },
      (ev) => {
        if (ev.type === 'start') {
          document.getElementById('rev-white-name').textContent = ev.white.name;
          document.getElementById('rev-black-name').textContent = ev.black.name;
          document.getElementById('rev-progress-text').textContent = `0 / ${ev.total} hamle`;
        } else if (ev.type === 'progress') {
          const pct = Math.round((ev.done / Math.max(1, ev.total)) * 100);
          document.getElementById('rev-progress-fill').style.width = `${pct}%`;
          document.getElementById('rev-progress-text').textContent = `${ev.done} / ${ev.total} hamle (%${pct})`;
        } else if (ev.type === 'done') {
          rv.result = ev;
          renderReviewDone(ev);
        } else if (ev.type === 'error') {
          toast(ev.message || 'İnceleme hatası');
        }
      },
      rv.abortCtrl.signal
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      toast(err.message || 'Oyun incelemesi başarısız oldu.');
    }
  } finally {
    rv.running = false;
    rv.abortCtrl = null;
    document.getElementById('rev-progress-card').classList.add('hidden');
  }
}

function renderReviewDone(data) {
  document.getElementById('rev-white-name').textContent = data.white.name;
  document.getElementById('rev-black-name').textContent = data.black.name;
  document.getElementById('rev-white-elo').textContent = data.white.estimate.display;
  document.getElementById('rev-black-elo').textContent = data.black.estimate.display;
  document.getElementById('rev-white-pred').textContent = `Tahmin: ${data.white.predicted}/${data.white.total} (%${data.white.predicted_pct})`;
  document.getElementById('rev-black-pred').textContent = `Tahmin: ${data.black.predicted}/${data.black.total} (%${data.black.predicted_pct})`;

  document.getElementById('hero-w-name').textContent = data.white.name;
  document.getElementById('hero-w-elo').textContent = data.white.estimate.display;
  document.getElementById('hero-w-sub').textContent = `${data.white.predicted}/${data.white.total} (%${data.white.predicted_pct}) · Ort. %${data.white.avg_prob_pct}`;

  document.getElementById('hero-b-name').textContent = data.black.name;
  document.getElementById('hero-b-elo').textContent = data.black.estimate.display;
  document.getElementById('hero-b-sub').textContent = `${data.black.predicted}/${data.black.total} (%${data.black.predicted_pct}) · Ort. %${data.black.avg_prob_pct}`;

  document.getElementById('hero-quote').textContent = data.summary_tr;
  document.getElementById('hero-kpi-pred').textContent = `${data.overall.predicted}/${data.overall.total}`;
  document.getElementById('hero-kpi-pct').textContent = `%${data.overall.predicted_pct}`;
  document.getElementById('hero-kpi-prob').textContent = `%${data.overall.avg_prob_pct}`;

  const listEl = document.getElementById('rev-move-list');
  listEl.innerHTML = data.moves
    .map((m) => {
      const prefix = m.side === 'w' ? `${m.move_number}. ` : '';
      const extraClass = m.classification?.key === 'blunder'
        ? 'pred-blunder'
        : m.predicted
          ? 'pred-ok'
          : '';
      return `<button type="button" class="move-chip ${extraClass}" data-ply="${m.ply}">${prefix}${m.san}</button>`;
    })
    .join('');

  listEl.querySelectorAll('.move-chip').forEach((btn) => {
    btn.addEventListener('click', () => showReviewPly(Number(btn.dataset.ply)));
  });

  document.getElementById('rev-hero-card').classList.remove('hidden');
  document.getElementById('rev-moves-card').classList.remove('hidden');
  showReviewPly(data.moves.length);
  document.getElementById('rev-hero-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- ANALYZE VIEW LOGIC ----------
async function runOracleAnalysis() {
  const an = state.analyze;
  if (an.loading) return;
  an.loading = true;
  document.getElementById('an-timing').textContent = 'Hesaplanıyor...';

  try {
    const res = await analyzePosition({
      fen: an.uciHistory.length ? null : an.chess.fen(),
      moves: an.uciHistory.length ? an.uciHistory : null,
      white_rating: an.whiteElo,
      black_rating: an.blackElo,
      time_control: an.timeControl,
      rating_source: an.ratingSource,
    });
    an.result = res;
    document.getElementById('an-timing').textContent = `${(res.elapsed_ms / 1000).toFixed(1)} sn`;
    renderWdlBar('an', res.white_wdl);

    const moves = res.moves || [];
    const listEl = document.getElementById('an-moves-list');
    listEl.innerHTML = renderTobyMoveRows(moves.slice(0, 7));

    listEl.querySelectorAll('.toby-move-row').forEach((row) => {
      row.addEventListener('click', () => {
        const u = row.dataset.uci;
        if (!u) return;
        const mv = an.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        if (mv) {
          an.uciHistory.push(u);
          an.board.setPosition(an.chess.fen(), { from: mv.from, to: mv.to });
          runOracleAnalysis();
        }
      });
    });

    an.board.setArrows(
      moves.slice(0, 3).map((m, idx) => ({
        from: m.uci.slice(0, 2),
        to: m.uci.slice(2, 4),
        prob: m.prob,
        label: `%${Math.round(m.prob_pct)}`,
        color: idx === 0 ? '#c99b52' : '#4e9f72',
      }))
    );
  } catch (err) {
    document.getElementById('an-timing').textContent = 'Hata';
    toast(err.message);
  } finally {
    an.loading = false;
  }
}

// ---------- Wire Events & Init ----------
function initApp() {
  mountApp();

  // Tabs
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Play Board
  state.play.board = new ChessBoardUI(document.getElementById('play-board'), {
    orientation: 'w',
    canMoveColor: (c) => !state.play.thinking && c === state.play.humanColor && !state.play.chess.isGameOver(),
    onMove: ({ from, to, promotion, uci }) => {
      const mv = state.play.chess.move({ from, to, promotion });
      if (!mv) return;
      state.play.uciHistory.push(uci);
      state.play.board.setArrows([]);
      document.getElementById('play-hint-card').classList.add('hidden');
      updatePlayUI();
      if (!state.play.chess.isGameOver()) {
        requestTobyReply();
      }
    },
  });

  // Review Board
  state.review.board = new ChessBoardUI(document.getElementById('review-board'), {
    orientation: 'w',
    interactive: false,
  });

  // Analyze Board
  state.analyze.board = new ChessBoardUI(document.getElementById('analyze-board'), {
    orientation: 'w',
    onMove: ({ from, to, promotion, uci }) => {
      const mv = state.analyze.chess.move({ from, to, promotion });
      if (!mv) return;
      state.analyze.uciHistory.push(uci);
      state.analyze.board.setPosition(state.analyze.chess.fen(), { from: mv.from, to: mv.to });
      runOracleAnalysis();
    },
  });

  // Play controls
  document.getElementById('rng-toby-elo').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    document.getElementById('lbl-toby-elo').textContent = String(val);
    state.play.tobyElo = val;
    state.play.humanElo = val;
    updatePlayUI();
  });
  document.getElementById('sel-play-tc').addEventListener('change', (e) => {
    state.play.timeControl = e.target.value;
  });
  document.getElementById('sel-play-source').addEventListener('change', (e) => {
    state.play.ratingSource = e.target.value;
  });
  document.getElementById('sel-play-style').addEventListener('change', (e) => {
    state.play.samplingMode = e.target.value;
  });
  document.getElementById('btn-new-game').addEventListener('click', startNewGame);
  document.getElementById('btn-play-hint').addEventListener('click', requestPlayHint);
  document.getElementById('btn-play-flip').addEventListener('click', () => {
    state.play.board.flip();
    updatePlayUI();
  });
  document.getElementById('btn-play-undo').addEventListener('click', () => {
    const p = state.play;
    if (p.thinking || !p.uciHistory.length) return;
    // Undo back to human's turn
    p.chess.undo();
    p.uciHistory.pop();
    if (p.chess.turn() !== p.humanColor && p.uciHistory.length) {
      p.chess.undo();
      p.uciHistory.pop();
    }
    p.board.setArrows([]);
    updatePlayUI();
  });
  document.getElementById('btn-send-to-review').addEventListener('click', () => {
    const p = state.play;
    if (p.uciHistory.length < 2) return;
    const isHumanW = p.humanColor === 'w';
    let resStr = '*';
    if (p.chess.isCheckmate()) {
      resStr = p.chess.turn() === 'w' ? '0-1' : '1-0';
    } else if (p.chess.isDraw()) {
      resStr = '1/2-1/2';
    }
    switchTab('review');
    startGameReview({
      moves: [...p.uciHistory],
      white_rating: p.tobyElo,
      black_rating: p.tobyElo,
      time_control: p.timeControl,
      white_name: isHumanW ? 'Sen' : `Toby (${p.tobyElo})`,
      black_name: isHumanW ? `Toby (${p.tobyElo})` : 'Sen',
      result: resStr,
    });
  });

  // Review controls
  document.getElementById('btn-start-review').addEventListener('click', () => startGameReview());
  document.getElementById('btn-rev-cancel').addEventListener('click', () => {
    if (state.review.abortCtrl) state.review.abortCtrl.abort();
  });
  document.getElementById('btn-rev-first').addEventListener('click', () => showReviewPly(0));
  document.getElementById('btn-rev-prev').addEventListener('click', () => showReviewPly(state.review.activePly - 1));
  document.getElementById('btn-rev-next').addEventListener('click', () => showReviewPly(state.review.activePly + 1));
  document.getElementById('btn-rev-last').addEventListener('click', () => {
    const n = state.review.result?.moves?.length || 0;
    showReviewPly(n);
  });
  document.getElementById('btn-rev-flip').addEventListener('click', () => state.review.board.flip());
  document.getElementById('btn-copy-summary').addEventListener('click', async () => {
    const txt = state.review.result?.summary_tr;
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      toast('Toby özeti panoya kopyalandı!');
    } catch {
      toast('Kopyalanamadı');
    }
  });

  // Analyze controls
  document.getElementById('rng-an-welo').addEventListener('input', (e) => {
    state.analyze.whiteElo = Number(e.target.value);
    document.getElementById('lbl-an-welo').textContent = e.target.value;
  });
  document.getElementById('rng-an-belo').addEventListener('input', (e) => {
    state.analyze.blackElo = Number(e.target.value);
    document.getElementById('lbl-an-belo').textContent = e.target.value;
  });
  document.getElementById('sel-an-tc').addEventListener('change', (e) => {
    state.analyze.timeControl = e.target.value;
  });
  document.getElementById('sel-an-src').addEventListener('change', (e) => {
    state.analyze.ratingSource = e.target.value;
  });
  document.getElementById('btn-an-run').addEventListener('click', runOracleAnalysis);
  document.getElementById('btn-an-undo').addEventListener('click', () => {
    const an = state.analyze;
    if (an.chess.undo()) {
      an.uciHistory.pop();
      an.board.setPosition(an.chess.fen(), null);
      an.board.setArrows([]);
    }
  });
  document.getElementById('btn-an-reset').addEventListener('click', () => {
    const an = state.analyze;
    an.chess = new Chess();
    an.uciHistory = [];
    an.board.setPosition(an.chess.fen(), null);
    an.board.setArrows([]);
    document.getElementById('an-moves-list').innerHTML = '<span style="color:var(--ink-dim)">Konumu analiz etmek için "Toby ile Analiz Et" butonuna basın.</span>';
  });
  document.getElementById('btn-an-flip').addEventListener('click', () => state.analyze.board.flip());
  document.getElementById('btn-an-load-fen').addEventListener('click', () => {
    const fen = document.getElementById('inp-an-fen').value.trim();
    if (!fen) return;
    try {
      state.analyze.chess = new Chess(fen);
      state.analyze.uciHistory = [];
      state.analyze.board.setPosition(state.analyze.chess.fen(), null);
      state.analyze.board.setArrows([]);
      runOracleAnalysis();
    } catch {
      toast('Geçersiz FEN formatı.');
    }
  });

  // Settings Modal
  const settingsModal = document.getElementById('modal-settings');
  document.getElementById('btn-settings-open').addEventListener('click', () => {
    document.getElementById('inp-server-url').value = getServerUrl();
    settingsModal.classList.remove('hidden');
  });
  document.getElementById('btn-settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
  document.getElementById('btn-settings-save').addEventListener('click', () => {
    setServerUrl(document.getElementById('inp-server-url').value);
    settingsModal.classList.add('hidden');
    toast('Sunucu adresi kaydedildi');
    refreshHealth();
    loadSamples();
  });

  // Install Modal & PWA prompt
  const installModal = document.getElementById('modal-install');
  document.getElementById('btn-install-open').addEventListener('click', () => {
    installModal.classList.remove('hidden');
  });
  document.getElementById('btn-install-close').addEventListener('click', () => installModal.classList.add('hidden'));

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    document.getElementById('install-banner').classList.remove('hidden');
    document.getElementById('btn-install-trigger').classList.remove('hidden');
  });

  const triggerInstall = async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    document.getElementById('install-banner').classList.add('hidden');
    document.getElementById('btn-install-trigger').classList.add('hidden');
    installModal.classList.add('hidden');
  };
  document.getElementById('btn-install-pwa').addEventListener('click', triggerInstall);
  document.getElementById('btn-install-trigger').addEventListener('click', triggerInstall);

  if (isNativeApp()) {
    document.getElementById('btn-install-open')?.classList.add('hidden');
    if (!getServerUrl()) {
      document.getElementById('inp-server-url').placeholder = 'Örn: http://192.168.1.42:8080';
      settingsModal.classList.remove('hidden');
    }
  }

  updatePlayUI();
  refreshHealth();
  loadSamples();
}

initApp();
