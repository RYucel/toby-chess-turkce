import { Chess } from 'chess.js';
import { PIECE_SVGS, getPieceKey } from './pieces.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

export class ChessBoardUI {
  constructor(container, options = {}) {
    this.container = container;
    this.orientation = options.orientation || 'w';
    this.interactive = options.interactive !== false;
    this.onMove = options.onMove || null;
    this.canMoveColor = options.canMoveColor || (() => true);

    this.chess = new Chess();
    this.selectedSquare = null;
    this.legalTargets = new Map();
    this.lastMove = null;
    this.arrows = []; // [{ from, to, prob, label, color }]
    this.pendingPromotion = null;

    this._buildDOM();
  }

  _buildDOM() {
    this.container.innerHTML = '';
    this.container.classList.add('board-shell');

    this.gridEl = document.createElement('div');
    this.gridEl.className = 'board-grid';
    this.container.appendChild(this.gridEl);

    this.arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrowSvg.setAttribute('viewBox', '0 0 800 800');
    this.arrowSvg.classList.add('board-arrows');
    this.container.appendChild(this.arrowSvg);

    this.promoEl = document.createElement('div');
    this.promoEl.className = 'promo-overlay hidden';
    this.container.appendChild(this.promoEl);

    this.render();
  }

  setPosition(fen, lastMove = null) {
    this.chess = new Chess(fen);
    this.lastMove = lastMove;
    this.selectedSquare = null;
    this.legalTargets.clear();
    this.pendingPromotion = null;
    this.promoEl.classList.add('hidden');
    this.render();
  }

  setOrientation(color) {
    this.orientation = color === 'b' ? 'b' : 'w';
    this.render();
  }

  flip() {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  }

  setArrows(arrows) {
    this.arrows = arrows || [];
    this._renderArrows();
  }

  setInteractive(flag) {
    this.interactive = Boolean(flag);
    if (!this.interactive) {
      this.selectedSquare = null;
      this.legalTargets.clear();
      this.render();
    }
  }

  _squareToCoords(sq) {
    const fileIdx = FILES.indexOf(sq[0]);
    const rankIdx = RANKS.indexOf(sq[1]);
    if (this.orientation === 'w') {
      return { x: fileIdx * 100 + 50, y: rankIdx * 100 + 50 };
    }
    return { x: (7 - fileIdx) * 100 + 50, y: (7 - rankIdx) * 100 + 50 };
  }

  _renderArrows() {
    this.arrowSvg.innerHTML = '';
    if (!this.arrows.length) return;

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    this.arrows.forEach((arr, idx) => {
      const color = arr.color || (idx === 0 ? '#c99b52' : '#5aa67c');
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', `arrowhead-${idx}`);
      marker.setAttribute('markerWidth', '4.2');
      marker.setAttribute('markerHeight', '4.2');
      marker.setAttribute('refX', '2.4');
      marker.setAttribute('refY', '2.1');
      marker.setAttribute('orient', 'auto');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', '0 0.3, 3.6 2.1, 0 3.9');
      poly.setAttribute('fill', color);
      marker.appendChild(poly);
      defs.appendChild(marker);
    });
    this.arrowSvg.appendChild(defs);

    this.arrows.forEach((arr, idx) => {
      const from = this._squareToCoords(arr.from);
      const to = this._squareToCoords(arr.to);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;

      const startX = from.x + ux * 16;
      const startY = from.y + uy * 16;
      const endX = to.x - ux * 22;
      const endY = to.y - uy * 22;

      const prob = Math.max(0.05, Math.min(1, arr.prob ?? 0.5));
      const strokeWidth = 10 + prob * 14;
      const opacity = 0.45 + prob * 0.45;
      const color = arr.color || (idx === 0 ? '#c99b52' : '#5aa67c');

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(startX));
      line.setAttribute('y1', String(startY));
      line.setAttribute('x2', String(endX));
      line.setAttribute('y2', String(endY));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', String(strokeWidth));
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-opacity', String(opacity));
      line.setAttribute('marker-end', `url(#arrowhead-${idx})`);
      this.arrowSvg.appendChild(line);

      if (arr.label) {
        const badgeX = to.x - ux * 8;
        const badgeY = to.y - uy * 8;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(badgeX - 24));
        rect.setAttribute('y', String(badgeY - 13));
        rect.setAttribute('width', '48');
        rect.setAttribute('height', '24');
        rect.setAttribute('rx', '6');
        rect.setAttribute('fill', '#181614');
        rect.setAttribute('fill-opacity', '0.92');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '2');
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(badgeX));
        text.setAttribute('y', String(badgeY + 4));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#f4efe6');
        text.setAttribute('font-size', '15');
        text.setAttribute('font-weight', '700');
        text.setAttribute('font-family', 'JetBrains Mono, monospace');
        text.textContent = arr.label;
        g.appendChild(rect);
        g.appendChild(text);
        this.arrowSvg.appendChild(g);
      }
    });
  }

  _selectSquare(sq) {
    const piece = this.chess.get(sq);
    if (!piece || piece.color !== this.chess.turn() || !this.canMoveColor(piece.color)) {
      this.selectedSquare = null;
      this.legalTargets.clear();
      this.render();
      return;
    }
    this.selectedSquare = sq;
    this.legalTargets.clear();
    const moves = this.chess.moves({ square: sq, verbose: true });
    for (const m of moves) {
      if (!this.legalTargets.has(m.to)) {
        this.legalTargets.set(m.to, []);
      }
      this.legalTargets.get(m.to).push(m);
    }
    this.render();
  }

  _attemptMove(from, to) {
    const candidates = this.legalTargets.get(to);
    if (!candidates || !candidates.length) return false;

    const isPromo = candidates.some((m) => m.promotion);
    if (isPromo) {
      this._showPromotionModal(from, to, this.chess.turn());
      return true;
    }

    const mv = candidates[0];
    this.selectedSquare = null;
    this.legalTargets.clear();
    if (this.onMove) {
      this.onMove({ from: mv.from, to: mv.to, promotion: undefined, uci: `${mv.from}${mv.to}` });
    }
    return true;
  }

  _showPromotionModal(from, to, color) {
    this.pendingPromotion = { from, to };
    this.promoEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'promo-card';
    const title = document.createElement('div');
    title.className = 'promo-title';
    title.textContent = 'Terfi Taşı Seçin';
    card.appendChild(title);

    const row = document.createElement('div');
    row.className = 'promo-row';
    for (const p of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-btn';
      btn.innerHTML = PIECE_SVGS[`${color}${p.toUpperCase()}`];
      btn.addEventListener('click', () => {
        this.promoEl.classList.add('hidden');
        this.pendingPromotion = null;
        this.selectedSquare = null;
        this.legalTargets.clear();
        if (this.onMove) {
          this.onMove({ from, to, promotion: p, uci: `${from}${to}${p}` });
        }
      });
      row.appendChild(btn);
    }
    card.appendChild(row);
    this.promoEl.appendChild(card);
    this.promoEl.classList.remove('hidden');
  }

  _handleSquareTap(sq) {
    if (!this.interactive) return;
    if (this.selectedSquare && this.legalTargets.has(sq)) {
      this._attemptMove(this.selectedSquare, sq);
      return;
    }
    if (this.selectedSquare === sq) {
      this.selectedSquare = null;
      this.legalTargets.clear();
      this.render();
      return;
    }
    this._selectSquare(sq);
  }

  render() {
    this.gridEl.innerHTML = '';
    const ranks = this.orientation === 'w' ? RANKS : [...RANKS].reverse();
    const files = this.orientation === 'w' ? FILES : [...FILES].reverse();

    const inCheck = this.chess.inCheck();
    const turn = this.chess.turn();

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = `${files[f]}${ranks[r]}`;
        const isLight = (FILES.indexOf(files[f]) + RANKS.indexOf(ranks[r])) % 2 === 0;
        const piece = this.chess.get(sq);

        const cell = document.createElement('div');
        cell.className = `sq ${isLight ? 'sq-light' : 'sq-dark'}`;
        cell.dataset.sq = sq;

        if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) {
          cell.classList.add('sq-last');
        }
        if (this.selectedSquare === sq) {
          cell.classList.add('sq-selected');
        }
        if (inCheck && piece && piece.type === 'k' && piece.color === turn) {
          cell.classList.add('sq-check');
        }

        if (f === 0) {
          const rankLbl = document.createElement('span');
          rankLbl.className = 'coord-rank';
          rankLbl.textContent = ranks[r];
          cell.appendChild(rankLbl);
        }
        if (r === 7) {
          const fileLbl = document.createElement('span');
          fileLbl.className = 'coord-file';
          fileLbl.textContent = files[f];
          cell.appendChild(fileLbl);
        }

        if (piece) {
          const pEl = document.createElement('div');
          pEl.className = 'piece';
          pEl.innerHTML = PIECE_SVGS[getPieceKey(piece)];
          cell.appendChild(pEl);
        }

        if (this.legalTargets.has(sq)) {
          const dot = document.createElement('span');
          dot.className = piece ? 'legal-ring' : 'legal-dot';
          cell.appendChild(dot);
        }

        cell.addEventListener('click', () => this._handleSquareTap(sq));
        this.gridEl.appendChild(cell);
      }
    }

    this._renderArrows();
  }
}
