const STORAGE_KEY = 'toby_server_url';

export function isNativeApp() {
  return Boolean(typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
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

function apiUrl(path) {
  const base = getServerUrl();
  return `${base}${path}`;
}

export async function checkHealth() {
  const res = await fetch(apiUrl('/api/health'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSampleGames() {
  const res = await fetch(apiUrl('/api/sample-games'));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.games || [];
}

export async function analyzePosition(payload) {
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
