# -*- coding: utf-8 -*-
"""Thread-safe UCI wrapper around Toby 2 (The Oracle By Yosha)."""
from __future__ import annotations

import io
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple

import chess
import chess.pgn
import numpy as np

# Default calibration fallback (exact Toby 2.0 values from nets/toby2_level_calibration_base.json)
DEFAULT_CALIBRATION: Dict[str, Any] = {
    "classical": {
        "ea_tau": 1.5,
        "ea_mean": 2084.96,
        "ea_sd": 341.99,
        "ea_coef": [708.2080714, 0.5360232585, 0.6336544482, -0.1885130696, -0.4880373407],
        "ea_coef_review": [768.8276841, 0.4941874413, 0.8551816869, -0.4611398083, -0.6026011856],
        "ea_stretch": 1.15,
        "ea_stretch_review": 1.2,
        "ea_cap_high": 2500.0,
        "ea_cap_low": 1600.0,
        "knots": [1800.0, 2200.0, 2500.0],
        "bounds": [1400.0, 2800.0],
        "er_tau": 8.0,
        "er_s": 1500.0,
        "er_drift": [456.1687916, -0.1157251573, -0.2352535449, -0.2076595151, -0.2442514565],
        "c_er": 300.0,
        "c_ea": 300.0,
        "sd_scale": 1.4584,
    },
    "rapidblitz": {
        "ea_tau": 1.0,
        "ea_mean": 2201.09,
        "ea_sd": 291.63,
        "ea_coef": [479.1343953, 0.730063743, 0.2597351971, -0.3009581909, -0.06886571788],
        "ea_coef_review": [641.7567982, 0.6269408701, 0.4599742437, -0.3181863975, -0.3594497763],
        "ea_stretch": 1.15,
        "ea_stretch_review": 1.2,
        "ea_cap_high": 2500.0,
        "ea_cap_low": 1600.0,
        "knots": [1800.0, 2200.0, 2500.0],
        "bounds": [1400.0, 2800.0],
        "er_tau": 4.0,
        "er_s": 1500.0,
        "er_drift": [138.955799, -0.002090554547, -0.0219050748, -0.3449704078, -0.3641890369],
        "c_er": 400.0,
        "c_ea": 250.0,
        "sd_scale": 1.5989,
    },
}

VALID_SOURCES = {
    "FIDE",
    "Lichess Classical",
    "Lichess Rapid",
    "Lichess Blitz",
    "Chess.com Rapid",
    "Chess.com Blitz",
}
VALID_TIME_CONTROLS = {"Classical", "Rapid", "Blitz"}


def find_toby_binary() -> Optional[str]:
    """Locate the Toby 2 executable (Linux/macOS 'toby' or Windows 'toby.exe')."""
    exe_names = ["toby.exe", "toby"] if os.name == "nt" else ["toby", "toby.exe"]
    base_dirs = [
        Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else None,
        Path.cwd(),
        Path(__file__).resolve().parent.parent,
        Path.home() / "toby-engine",
        Path("/home/antigravity/toby-engine"),
    ]

    candidates: List[Optional[str]] = [os.environ.get("TOBY_BIN")]
    for d in base_dirs:
        if d is None:
            continue
        for name in exe_names:
            candidates.append(str(d / "Toby" / name))
            candidates.append(str(d / "toby-engine" / "Toby" / name))
            candidates.append(str(d / name))
    for name in exe_names:
        candidates.append(shutil.which(name))

    for path in candidates:
        if path and os.path.isfile(path) and (os.name == "nt" or os.access(path, os.X_OK)):
            return path
    return None


def _score_to_cp(v: float) -> float:
    if abs(v) >= 10000:
        return 10000.0 if v > 0 else -10000.0
    return max(-2000.0, min(2000.0, float(v)))


def expected_score_pct(rating: float, cp: float) -> float:
    """Toby's expected score formula ES(R, cp) in [0, 100] for the side to move."""
    c = rating * -0.00000274 + 0.00048
    x = c * _score_to_cp(cp)
    if x > 700:
        return 0.0
    if x < -700:
        return 100.0
    return 100.0 * (0.5 + 0.5 * (2.0 / (1.0 + math.exp(x)) - 1.0))


def _spline_basis(x: float, knots: List[float], bounds: List[float]) -> np.ndarray:
    r = max(bounds[0], min(bounds[1], float(x)))
    return np.array([1.0, r] + [max(0.0, r - k) for k in knots], dtype=float)


def _softmax(log_w: np.ndarray) -> np.ndarray:
    m = float(np.max(log_w))
    w = np.exp(log_w - m)
    s = float(np.sum(w))
    return w / s if s > 0 else np.ones_like(w) / len(w)


def estimate_player_rating(
    grid: np.ndarray,
    sum_curve: np.ndarray,
    cal: Dict[str, Any],
    known_rating: Optional[int] = None,
    opp_rating: Optional[int] = None,
    player_result: Optional[float] = None,
) -> Dict[str, Any]:
    """Compute Toby 2 calibrated rating estimate (E_R when rating known, E_A otherwise)."""
    knots = cal["knots"]
    bounds = cal["bounds"]

    # Optional game result log-likelihood contribution
    def result_term(c_val: float, r_opp: float) -> np.ndarray:
        if player_result is None or c_val <= 0:
            return np.zeros_like(grid)
        # Logistic Elo win probability against r_opp
        p_win = 1.0 / (1.0 + 10.0 ** ((r_opp - grid) / 400.0))
        p_win = np.clip(p_win, 1e-6, 1.0 - 1e-6)
        # Soft result likelihood: S * log(p) + (1-S) * log(1-p), scaled
        # In Toby's calibration, result_c acts as a gentle prior shift
        return (player_result * np.log(p_win) + (1.0 - player_result) * np.log(1.0 - p_win)) * (c_val / 400.0)

    if known_rating is not None and known_rating > 0:
        tau = float(cal["er_tau"])
        s = float(cal["er_s"])
        r0 = float(known_rating)
        r_opp = float(opp_rating) if (opp_rating and opp_rating > 0) else r0
        prior = -0.5 * ((grid - r0) / s) ** 2
        log_post = (sum_curve / tau) + prior + result_term(float(cal.get("c_er", 0.0)), r_opp)
        post = _softmax(log_post)
        x = float(np.sum(grid * post))
        sd = float(np.sqrt(np.sum(((grid - x) ** 2) * post))) * float(cal.get("sd_scale", 1.0))
        drift = float(np.dot(np.array(cal["er_drift"], dtype=float), _spline_basis(r0, knots, bounds)))
        est = x - drift
        est_rounded = int(round(max(800.0, min(3200.0, est))))
        return {
            "mode": "E_R",
            "rating": est_rounded,
            "display": str(est_rounded),
            "raw_mean": round(x, 1),
            "sd": round(sd, 1),
            "known_rating": int(known_rating),
        }

    # Anonymous / blind estimate (E_A)
    tau = float(cal["ea_tau"])
    prior_mean = float(cal["ea_mean"])
    prior_sd = float(cal["ea_sd"])
    prior = -0.5 * ((grid - prior_mean) / prior_sd) ** 2
    log_post = (sum_curve / tau) + prior
    post = _softmax(log_post)
    x = float(np.sum(grid * post))
    sd = float(np.sqrt(np.sum(((grid - x) ** 2) * post))) * float(cal.get("sd_scale", 1.0))

    coef = np.array(cal.get("ea_coef_review", cal["ea_coef"]), dtype=float)
    ea = float(np.dot(coef, _spline_basis(x, knots, bounds)))
    k = float(cal.get("ea_stretch_review", cal.get("ea_stretch", 1.15)))
    shown = max(bounds[0], min(bounds[1], prior_mean + k * (ea - prior_mean)))
    cap_high = float(cal.get("ea_cap_high", 2500.0))
    cap_low = float(cal.get("ea_cap_low", 1600.0))
    if shown >= cap_high:
        display = f"{int(cap_high)}+"
    elif shown < cap_low:
        display = f"{int(cap_low)} altı"
    else:
        display = str(int(round(shown)))

    return {
        "mode": "E_A",
        "rating": int(round(shown)),
        "display": display,
        "raw_mean": round(x, 1),
        "sd": round(sd, 1),
        "known_rating": None,
    }


def classify_move(is_predicted: bool, prob: float, es_loss: Optional[float]) -> Dict[str, str]:
    """Classify a played move combining Toby human prediction & Stockfish ES loss."""
    if es_loss is not None:
        if es_loss >= 20.0:
            return {"key": "blunder", "label": "Büyük Hata"}
        if es_loss >= 10.0:
            return {"key": "mistake", "label": "Hata"}
        if es_loss >= 5.0:
            return {"key": "inaccuracy", "label": "Şüpheli"}
        if es_loss <= 1.0 and prob < 0.12 and not is_predicted:
            return {"key": "surprise", "label": "Sürpriz / Parlak"}
        if is_predicted and es_loss <= 1.5:
            return {"key": "predicted_best", "label": "Tahmin + En İyi"}
        if es_loss <= 1.0:
            return {"key": "best", "label": "En İyi"}
    if is_predicted:
        return {"key": "predicted", "label": "Toby Tahmini"}
    if prob >= 0.20:
        return {"key": "good", "label": "İyi"}
    return {"key": "unusual", "label": "Sıra Dışı"}


class TobyEngine:
    """Persistent, thread-safe Toby 2 UCI process manager."""

    def __init__(self, binary_path: Optional[str] = None) -> None:
        self.binary_path = binary_path or find_toby_binary()
        self.proc: Optional[subprocess.Popen[str]] = None
        self.lock = threading.Lock()
        self.version = "2.0"
        self.calibration: Dict[str, Dict[str, Any]] = {
            k: dict(v) for k, v in DEFAULT_CALIBRATION.items()
        }
        self._last_opts: Dict[str, Any] = {}
        self.ready = False
        self.error: Optional[str] = None

    def start(self) -> None:
        with self.lock:
            self._start_locked()

    def _start_locked(self) -> None:
        if self.proc and self.proc.poll() is None:
            return
        if not self.binary_path:
            self.error = "Toby 2 motoru bulunamadı. Lütfen scripts/install_toby.sh ile kurun."
            self.ready = False
            raise RuntimeError(self.error)

        popen_kwargs: Dict[str, Any] = {}
        if os.name == "nt":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

        self.proc = subprocess.Popen(
            [self.binary_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=str(Path(self.binary_path).parent),
            **popen_kwargs,
        )
        self._send("uci")
        for line in self._read_until("uciok"):
            if line.startswith("info string toby version "):
                self.version = line.split("info string toby version ", 1)[1].strip()
            elif line.startswith("info string toby level calibration "):
                self._parse_calibration_line(line)
            elif line.startswith("info string toby level display "):
                self._parse_display_line(line)

        self._send("setoption name Display value Full")
        self._send("setoption name Provisional Lines value false")
        self._send("setoption name Deepening value false")
        self._send("setoption name MultiPV value 500")
        self._send("setoption name UCI_ShowWDL value true")
        self._send("isready")
        self._read_until("readyok")
        self._last_opts = {}
        self.ready = True
        self.error = None

    def _ensure_running_locked(self) -> None:
        if self.proc is None or self.proc.poll() is not None:
            self._start_locked()

    def _send(self, cmd: str) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _readline(self) -> str:
        assert self.proc is not None and self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("Toby 2 motoru beklenmedik şekilde kapandı.")
        return line.strip()

    def _read_until(self, prefix: str) -> List[str]:
        lines: List[str] = []
        while True:
            line = self._readline()
            lines.append(line)
            if line == prefix or line.startswith(prefix + " "):
                return lines

    def _parse_calibration_line(self, line: str) -> None:
        tokens = line.split()
        try:
            grp = tokens[tokens.index("group") + 1]
        except (ValueError, IndexError):
            return
        cal = self.calibration.setdefault(grp, dict(DEFAULT_CALIBRATION.get(grp, DEFAULT_CALIBRATION["classical"])))

        def get_float(key: str) -> Optional[float]:
            if key in tokens:
                return float(tokens[tokens.index(key) + 1])
            return None

        def get_floats(key: str, count: int) -> Optional[List[float]]:
            if key in tokens:
                idx = tokens.index(key) + 1
                return [float(x) for x in tokens[idx : idx + count]]
            return None

        for k in ("ea_tau", "ea_mean", "ea_sd", "er_tau", "er_s", "c_er", "c_ea", "sd_scale"):
            v = get_float(k)
            if v is not None:
                cal[k] = v
        for k, n in (("ea_coef", 5), ("er_drift", 5), ("knots", 3), ("bounds", 2)):
            vs = get_floats(k, n)
            if vs is not None:
                cal[k] = vs

    def _parse_display_line(self, line: str) -> None:
        tokens = line.split()
        try:
            grp = tokens[tokens.index("group") + 1]
        except (ValueError, IndexError):
            return
        cal = self.calibration.setdefault(grp, dict(DEFAULT_CALIBRATION.get(grp, DEFAULT_CALIBRATION["classical"])))
        for k in ("ea_stretch", "ea_stretch_review", "ea_cap_high", "ea_cap_low"):
            if k in tokens:
                cal[k] = float(tokens[tokens.index(k) + 1])
        if "ea_coef_review" in tokens:
            idx = tokens.index("ea_coef_review") + 1
            cal["ea_coef_review"] = [float(x) for x in tokens[idx : idx + 5]]

    def _set_options_locked(
        self,
        white_rating: int,
        black_rating: int,
        time_control: str,
        rating_source: str,
    ) -> None:
        tc = time_control if time_control in VALID_TIME_CONTROLS else "Classical"
        src = rating_source if rating_source in VALID_SOURCES else "FIDE"
        w = max(0, min(3600, int(white_rating)))
        b = max(0, min(3600, int(black_rating)))
        desired = {
            "White Rating": w,
            "Black Rating": b,
            "Time Control": tc,
            "Rating Source": src,
        }
        changed = False
        for k, v in desired.items():
            if self._last_opts.get(k) != v:
                self._send(f"setoption name {k} value {v}")
                self._last_opts[k] = v
                changed = True
        if changed:
            self._send("isready")
            self._read_until("readyok")

    def analyze_position(
        self,
        fen: Optional[str] = None,
        moves: Optional[List[str]] = None,
        white_rating: int = 2000,
        black_rating: int = 2000,
        time_control: str = "Classical",
        rating_source: str = "FIDE",
    ) -> Dict[str, Any]:
        """Run Toby 2 full analysis on a position and return human move probabilities & WDL."""
        t0 = time.time()
        board = chess.Board(fen) if fen else chess.Board()
        valid_moves: List[str] = []
        if moves and not fen:
            for uci in moves:
                mv = chess.Move.from_uci(uci)
                if mv in board.legal_moves:
                    board.push(mv)
                    valid_moves.append(uci)
                else:
                    break

        if board.is_game_over():
            return {
                "fen": board.fen(),
                "turn": "w" if board.turn == chess.WHITE else "b",
                "game_over": True,
                "bestmove": None,
                "moves": [],
                "position_wdl": None,
                "white_wdl": None,
                "elapsed_ms": int((time.time() - t0) * 1000),
            }

        with self.lock:
            self._ensure_running_locked()
            self._set_options_locked(white_rating, black_rating, time_control, rating_source)
            if valid_moves and not fen:
                self._send("position startpos moves " + " ".join(valid_moves))
            elif fen:
                self._send(f"position fen {board.fen()}")
            else:
                self._send("position startpos")

            self._send("go depth 1")
            lines = self._read_until("bestmove")

        move_re = re.compile(
            r"^info string toby move (\S+) san (\S+) prob ([0-9.eE+-]+) maia ([0-9.eE+-]+) wdl (\d+) (\d+) (\d+) es ([0-9.eE+-]+)"
        )
        pos_re = re.compile(r"^info string toby position wdl (\d+) (\d+) (\d+) es ([0-9.eE+-]+)")
        cp_re = re.compile(r"score cp (-?\d+).*?\bpv (\S+)")

        parsed_moves: List[Dict[str, Any]] = []
        cp_by_move: Dict[str, int] = {}
        pos_wdl = None
        pos_es = None
        bestmove = None

        for line in lines:
            if line.startswith("info string toby begin "):
                parsed_moves = []
            elif line.startswith("info string toby move "):
                m = move_re.match(line)
                if m:
                    uci, san, prob, net_p, w, d, l, es = m.groups()
                    parsed_moves.append(
                        {
                            "uci": uci,
                            "san": san,
                            "prob": round(float(prob), 5),
                            "prob_pct": round(float(prob) * 100.0, 1),
                            "net_prob": round(float(net_p), 5),
                            "net_prob_pct": round(float(net_p) * 100.0, 1),
                            "wdl": [int(w), int(d), int(l)],
                            "es": round(float(es), 4),
                            "es_pct": round(float(es) * 100.0, 1),
                        }
                    )
            elif line.startswith("info string toby position wdl "):
                m = pos_re.match(line)
                if m:
                    w, d, l, es = m.groups()
                    pos_wdl = [int(w), int(d), int(l)]
                    pos_es = round(float(es), 4)
            elif line.startswith("info depth "):
                m = cp_re.search(line)
                if m:
                    cp_by_move[m.group(2)] = int(m.group(1))
            elif line.startswith("bestmove "):
                parts = line.split()
                if len(parts) >= 2 and parts[1] != "(none)":
                    bestmove = parts[1]

        # Attach centipawn & White-perspective WDL
        is_white = board.turn == chess.WHITE
        for mv in parsed_moves:
            if mv["uci"] in cp_by_move:
                mv["cp"] = cp_by_move[mv["uci"]]
            w, d, l = mv["wdl"]
            mv["white_wdl"] = [w, d, l] if is_white else [l, d, w]

        if pos_wdl is None and parsed_moves:
            pos_wdl = parsed_moves[0]["wdl"]
            pos_es = parsed_moves[0]["es"]

        white_wdl = None
        if pos_wdl is not None:
            w, d, l = pos_wdl
            white_wdl = [w, d, l] if is_white else [l, d, w]

        return {
            "fen": board.fen(),
            "turn": "w" if is_white else "b",
            "game_over": False,
            "bestmove": bestmove or (parsed_moves[0]["uci"] if parsed_moves else None),
            "moves": parsed_moves,
            "position_wdl": pos_wdl,
            "position_es": pos_es,
            "white_wdl": white_wdl,
            "elapsed_ms": int((time.time() - t0) * 1000),
        }

    def play_move(
        self,
        fen: Optional[str] = None,
        moves: Optional[List[str]] = None,
        white_rating: int = 2000,
        black_rating: int = 2000,
        time_control: str = "Classical",
        rating_source: str = "FIDE",
        sampling_mode: str = "human",
    ) -> Dict[str, Any]:
        """Choose a human-like move using Toby 2's probability distribution."""
        analysis = self.analyze_position(
            fen=fen,
            moves=moves,
            white_rating=white_rating,
            black_rating=black_rating,
            time_control=time_control,
            rating_source=rating_source,
        )
        if analysis["game_over"] or not analysis["moves"]:
            return {**analysis, "chosen": None}

        candidates = analysis["moves"]
        if sampling_mode == "top" or len(candidates) == 1:
            chosen = candidates[0]
        else:
            weights = [max(0.0001, float(m["prob"])) for m in candidates]
            chosen = random.choices(candidates, weights=weights, k=1)[0]

        return {
            **analysis,
            "chosen": chosen,
        }

    def review_game_stream(
        self,
        pgn_text: Optional[str] = None,
        uci_moves: Optional[List[str]] = None,
        white_rating: Optional[int] = None,
        black_rating: Optional[int] = None,
        time_control: str = "Classical",
        white_name: Optional[str] = None,
        black_name: Optional[str] = None,
        result_str: Optional[str] = None,
    ) -> Generator[Dict[str, Any], None, None]:
        """Stream Toby 2 Game Review: ELO performance, predicted moves, average probability."""
        headers: Dict[str, str] = {}
        moves_list: List[chess.Move] = []
        san_list: List[str] = []
        fen_before_list: List[str] = []
        fen_after_list: List[str] = []

        board = chess.Board()
        if pgn_text and pgn_text.strip():
            game = chess.pgn.read_game(io.StringIO(pgn_text))
            if game is None:
                raise ValueError("PGN okunamadı. Lütfen geçerli bir PGN yapıştırın.")
            headers = dict(game.headers)
            board = game.board()
            for mv in game.mainline_moves():
                fen_before_list.append(board.fen())
                san_list.append(board.san(mv))
                moves_list.append(mv)
                board.push(mv)
                fen_after_list.append(board.fen())
        elif uci_moves:
            for uci in uci_moves:
                mv = chess.Move.from_uci(uci)
                if mv not in board.legal_moves:
                    raise ValueError(f"Geçersiz hamle: {uci}")
                fen_before_list.append(board.fen())
                san_list.append(board.san(mv))
                moves_list.append(mv)
                board.push(mv)
                fen_after_list.append(board.fen())
        else:
            raise ValueError("İncelemek için PGN veya hamle listesi gerekli.")

        if not moves_list:
            raise ValueError("Oyunda hiç hamle bulunamadı.")

        # Resolve player names, ratings, result
        w_name = (white_name or headers.get("White") or "Beyaz").strip() or "Beyaz"
        b_name = (black_name or headers.get("Black") or "Siyah").strip() or "Siyah"
        if w_name == "?":
            w_name = "Beyaz"
        if b_name == "?":
            b_name = "Siyah"

        def parse_elo(val: Any) -> Optional[int]:
            if val is None or val == "":
                return None
            try:
                n = int(str(val).strip())
                return n if 400 <= n <= 3500 else None
            except ValueError:
                return None

        w_elo = parse_elo(white_rating) or parse_elo(headers.get("WhiteElo"))
        b_elo = parse_elo(black_rating) or parse_elo(headers.get("BlackElo"))
        res = (result_str or headers.get("Result") or "*").strip()
        w_res = 1.0 if res == "1-0" else (0.0 if res == "0-1" else (0.5 if res in ("1/2-1/2", "½-½") else None))
        b_res = (1.0 - w_res) if w_res is not None else None

        tc = time_control if time_control in VALID_TIME_CONTROLS else "Classical"
        cadence = tc.lower()
        cal_group = "classical" if cadence == "classical" else "rapidblitz"

        total_plies = len(moves_list)
        yield {
            "type": "start",
            "total": total_plies,
            "white": {"name": w_name, "known_elo": w_elo},
            "black": {"name": b_name, "known_elo": b_elo},
            "result": res,
            "time_control": tc,
            "event": headers.get("Event", ""),
        }

        uci_strs = [m.uci() for m in moves_list]
        grid_arr: Optional[np.ndarray] = None
        white_curve: Optional[np.ndarray] = None
        black_curve: Optional[np.ndarray] = None
        move_reports: List[Dict[str, Any]] = []

        w_pred = 0
        w_total = 0
        b_pred = 0
        b_total = 0
        w_probs: List[float] = []
        b_probs: List[float] = []

        with self.lock:
            self._ensure_running_locked()
            self._send("toby batch begin")
            for i, uci in enumerate(uci_strs):
                is_white_ply = (i % 2 == 0)
                if i == 0:
                    self._send("position startpos")
                else:
                    self._send("position startpos moves " + " ".join(uci_strs[:i]))
                dist_elo = (w_elo if is_white_ply else b_elo) or 2000
                self._send(f"toby level move {uci} cadence {cadence} dist {dist_elo}")
            self._send("toby batch end")

            # Read streaming blocks for each half-move
            cur_curve: Optional[Tuple[np.ndarray, np.ndarray]] = None
            cur_dist: Dict[str, float] = {}
            cur_best_cp: Optional[int] = None
            cur_played_cp: Optional[int] = None
            ply_idx = 0

            while True:
                line = self._readline()
                if line.startswith("info string toby batch end"):
                    break
                elif line.startswith("info string toby level end"):
                    # Finalize ply_idx
                    if ply_idx < total_plies:
                        parts = line.split()
                        if "best" in parts and "played" in parts:
                            try:
                                cur_best_cp = int(parts[parts.index("best") + 1])
                                cur_played_cp = int(parts[parts.index("played") + 1])
                            except (ValueError, IndexError):
                                cur_best_cp = cur_played_cp = None

                        is_white_ply = (ply_idx % 2 == 0)
                        uci = uci_strs[ply_idx]
                        san = san_list[ply_idx]
                        move_num = (ply_idx // 2) + 1

                        if cur_curve is not None:
                            g, vals = cur_curve
                            if grid_arr is None:
                                grid_arr = g
                                white_curve = np.zeros_like(g)
                                black_curve = np.zeros_like(g)
                            if is_white_ply:
                                assert white_curve is not None
                                white_curve += vals
                            else:
                                assert black_curve is not None
                                black_curve += vals

                        sorted_dist = sorted(cur_dist.items(), key=lambda kv: -kv[1])
                        top_uci = sorted_dist[0][0] if sorted_dist else uci
                        top_prob = sorted_dist[0][1] if sorted_dist else 0.0
                        played_prob = cur_dist.get(uci, 0.0)
                        is_predicted = (uci == top_uci)

                        # Convert top 4 predicted UCI moves to SAN
                        tmp_board = chess.Board(fen_before_list[ply_idx])
                        top_predictions = []
                        for pred_u, pred_p in sorted_dist[:4]:
                            try:
                                pred_san = tmp_board.san(chess.Move.from_uci(pred_u))
                            except Exception:
                                pred_san = pred_u
                            top_predictions.append(
                                {
                                    "uci": pred_u,
                                    "san": pred_san,
                                    "prob": round(pred_p, 5),
                                    "prob_pct": round(pred_p * 100.0, 1),
                                }
                            )

                        # Expected score loss
                        es_loss = None
                        eval_white_cp = None
                        if cur_best_cp is not None and cur_played_cp is not None:
                            ref_r = float((w_elo if is_white_ply else b_elo) or 2000)
                            es_b = expected_score_pct(ref_r, max(cur_best_cp, cur_played_cp))
                            es_p = expected_score_pct(ref_r, cur_played_cp)
                            es_loss = round(max(0.0, es_b - es_p), 2)
                            eval_white_cp = cur_played_cp if is_white_ply else -cur_played_cp

                        badge = classify_move(is_predicted, played_prob, es_loss)

                        if is_white_ply:
                            w_total += 1
                            if is_predicted:
                                w_pred += 1
                            w_probs.append(played_prob)
                        else:
                            b_total += 1
                            if is_predicted:
                                b_pred += 1
                            b_probs.append(played_prob)

                        report = {
                            "ply": ply_idx + 1,
                            "move_number": move_num,
                            "side": "w" if is_white_ply else "b",
                            "uci": uci,
                            "san": san,
                            "fen_before": fen_before_list[ply_idx],
                            "fen_after": fen_after_list[ply_idx],
                            "predicted": is_predicted,
                            "top_move_uci": top_uci,
                            "top_move_san": top_predictions[0]["san"] if top_predictions else top_uci,
                            "top_move_prob_pct": round(top_prob * 100.0, 1),
                            "played_prob": round(played_prob, 5),
                            "played_prob_pct": round(played_prob * 100.0, 1),
                            "top_predictions": top_predictions,
                            "best_cp": cur_best_cp,
                            "played_cp": cur_played_cp,
                            "eval_white_cp": eval_white_cp,
                            "es_loss": es_loss,
                            "classification": badge,
                        }
                        move_reports.append(report)
                        ply_idx += 1

                        yield {
                            "type": "progress",
                            "done": ply_idx,
                            "total": total_plies,
                            "move": report,
                        }

                    cur_curve = None
                    cur_dist = {}
                    cur_best_cp = None
                    cur_played_cp = None

                elif line.startswith("info string toby level ") and not (
                    line.startswith("info string toby level error")
                    or line.startswith("info string toby level calibration")
                    or line.startswith("info string toby level display")
                ):
                    parts = line.split()
                    # info string toby level <uci> <r1> <l1> <r2> <l2> ...
                    pairs = parts[5:]
                    rs: List[float] = []
                    ls: List[float] = []
                    for j in range(0, len(pairs) - 1, 2):
                        rs.append(float(pairs[j]))
                        ls.append(float(pairs[j + 1]))
                    if rs:
                        cur_curve = (np.array(rs, dtype=float), np.array(ls, dtype=float))

                elif line.startswith("info string toby dist "):
                    parts = line.split()
                    # info string toby dist <elo> <m1> <p1> <m2> <p2> ...
                    pairs = parts[5:]
                    cur_dist = {}
                    for j in range(0, len(pairs) - 1, 2):
                        cur_dist[pairs[j]] = float(pairs[j + 1])

        cal = self.calibration.get(cal_group, DEFAULT_CALIBRATION["classical"])
        if grid_arr is not None and white_curve is not None and black_curve is not None:
            w_est = estimate_player_rating(grid_arr, white_curve, cal, w_elo, b_elo, w_res)
            b_est = estimate_player_rating(grid_arr, black_curve, cal, b_elo, w_elo, b_res)
        else:
            w_est = {"mode": "E_A", "rating": 2000, "display": "—", "raw_mean": 2000, "sd": 0, "known_rating": w_elo}
            b_est = {"mode": "E_A", "rating": 2000, "display": "—", "raw_mean": 2000, "sd": 0, "known_rating": b_elo}

        total_moves_count = w_total + b_total
        total_pred = w_pred + b_pred
        total_pred_pct = round((total_pred / total_moves_count) * 100.0) if total_moves_count else 0
        w_pred_pct = round((w_pred / w_total) * 100.0) if w_total else 0
        b_pred_pct = round((b_pred / b_total) * 100.0) if b_total else 0

        all_probs = w_probs + b_probs
        avg_prob_pct = round((sum(all_probs) / len(all_probs)) * 100.0) if all_probs else 0
        w_avg_prob_pct = round((sum(w_probs) / len(w_probs)) * 100.0) if w_probs else 0
        b_avg_prob_pct = round((sum(b_probs) / len(b_probs)) * 100.0) if b_probs else 0

        def _tr_acc(n: int) -> str:
            last = n % 10
            if last == 0:
                tens = (n % 100) // 10
                suffix_map = {1: "unu", 2: "sini", 3: "unu", 4: "ını", 5: "sini", 6: "ını", 7: "ini", 8: "ini", 9: "ını", 0: "ını"}
                return f"{n}'{suffix_map.get(tens, 'ını')}"
            suffix_map = {1: "ini", 2: "sini", 3: "ünü", 4: "ünü", 5: "ini", 6: "sını", 7: "sini", 8: "ini", 9: "unu"}
            return f"{n}'{suffix_map[last]}"

        summary_tr = (
            f"Toby, {w_name} oyununu {w_est['display']} ve {b_name} oyununu {b_est['display']} olarak değerlendirdi. "
            f"Oynanan {total_moves_count} hamlenin {_tr_acc(total_pred)} (%{total_pred_pct}) doğru tahmin etti: "
            f"{w_name} için {w_pred}/{w_total} (%{w_pred_pct}), {b_name} için {b_pred}/{b_total} (%{b_pred_pct}). "
            f"Oynanan hamlelere ortalama %{avg_prob_pct} olasılık verdi."
        )

        yield {
            "type": "done",
            "summary_tr": summary_tr,
            "result": res,
            "time_control": tc,
            "event": headers.get("Event", ""),
            "white": {
                "name": w_name,
                "known_elo": w_elo,
                "estimate": w_est,
                "predicted": w_pred,
                "total": w_total,
                "predicted_pct": w_pred_pct,
                "avg_prob_pct": w_avg_prob_pct,
            },
            "black": {
                "name": b_name,
                "known_elo": b_elo,
                "estimate": b_est,
                "predicted": b_pred,
                "total": b_total,
                "predicted_pct": b_pred_pct,
                "avg_prob_pct": b_avg_prob_pct,
            },
            "overall": {
                "predicted": total_pred,
                "total": total_moves_count,
                "predicted_pct": total_pred_pct,
                "avg_prob_pct": avg_prob_pct,
            },
            "moves": move_reports,
        }

    def close(self) -> None:
        with self.lock:
            if self.proc and self.proc.poll() is None:
                try:
                    self._send("quit")
                    self.proc.wait(timeout=3)
                except Exception:
                    self.proc.kill()
            self.proc = None
            self.ready = False
