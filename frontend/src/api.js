import {
  OFFLINE_SAMPLE_GAMES,
  offlineAnalyze,
  offlineHealth,
  offlineLevelStep,
  offlinePlay,
  offlineReviewGame,
} from './toby_offline.js';

const STORAGE_KEY = 'toby_server_url';

export function isNativeApp() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.Capacitor &&
      window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform()
  );
}

export function getServerUrl() {
  return (localStorage.getItem(STORAGE_KEY) || '').replace(/\/+$/, '');
}

export function setServerUrl(url) {
  let cleaned = (url || '').trim().replace(/\/+$/, '');
  if (cleaned && !/^https?:\/\//i.test(cleaned)) {
    cleaned = `http://${cleaned}`;
  }
  if (cleaned) {
    localStorage.setItem(STORAGE_KEY, cleaned);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function useOfflineEngine() {
  return isNativeApp() && !getServerUrl();
}

function apiUrl(path) {
  const base = getServerUrl();
  return `${base}${path}`;
}

export async function checkHealth() {
  if (useOfflineEngine()) return offlineHealth();
  const res = await fetch(apiUrl('/api/health'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSampleGames() {
  if (useOfflineEngine()) return OFFLINE_SAMPLE_GAMES;
  const res = await fetch(apiUrl('/api/sample-games'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.games || [];
}

export async function analyzePosition(payload) {
  if (useOfflineEngine()) return offlineAnalyze(payload);
  const res = await fetch(apiUrl('/api/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Analiz hatası (HTTP ${res.status})`);
  }
  return res.json();
}

export async function playTobyMove(payload) {
  if (useOfflineEngine()) return offlinePlay(payload);
  const res = await fetch(apiUrl('/api/play'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Motor hatası (HTTP ${res.status})`);
  }
  return res.json();
}

export async function fetchLevelStep(payload) {
  if (useOfflineEngine()) return offlineLevelStep(payload);
  const res = await fetch(apiUrl('/api/level-step'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `ELO güncelleme hatası (HTTP ${res.status})`);
  }
  return res.json();
}

export async function streamGameReview(payload, onEvent, signal) {
  if (useOfflineEngine()) {
    return offlineReviewGame(payload, onEvent, signal);
  }
  const res = await fetch(apiUrl('/api/review'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `İnceleme hatası (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6);
        try {
          const ev = JSON.parse(jsonStr);
          onEvent(ev);
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}
