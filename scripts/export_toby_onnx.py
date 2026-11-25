#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export official Toby 2.0 weights (toby2_b.pt + toby2_level.pt) to INT8 ONNX for 100% offline Android."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--toby-src", required=True, help="Path to cloned Yosha87/Toby repository")
    parser.add_argument("--nets-dir", required=True, help="Path to Toby/nets directory containing toby2_b.pt & toby2_level.pt")
    parser.add_argument("--out-dir", required=True, help="Output directory for INT8 ONNX models")
    args = parser.parse_args()

    toby_src = Path(args.toby_src).resolve()
    nets_dir = Path(args.nets_dir).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(toby_src))
    sys.path.insert(0, str(toby_src / "toby2net"))

    import levelgen  # type: ignore
    import toby2  # type: ignore

    tmp_dir = out_dir / "_fp32_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    print("[1/3] Exporting toby2_b body & heads to ONNX (+ INT8 body)...", flush=True)
    toby2.onnx_export(str(nets_dir / "toby2_b.pt"), str(tmp_dir), int8=True)
    (tmp_dir / "toby2_b.body.int8.onnx").replace(out_dir / "toby2_b.body.int8.onnx")

    print("[2/3] Quantizing toby2_b.heads.onnx to INT8...", flush=True)
    quantize_dynamic(
        str(tmp_dir / "toby2_b.heads.onnx"),
        str(out_dir / "toby2_b.heads.int8.onnx"),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
    )

    print("[3/3] Exporting & quantizing toby2_level.pt to INT8 ONNX...", flush=True)
    ckpt = torch.load(str(nets_dir / "toby2_level.pt"), map_location="cpu", weights_only=False)
    meta = ckpt["meta"]
    n_anchor = len(meta.get("anchors") or [2000])
    lg = levelgen.make_gen(
        du=meta.get("du", 64),
        hidden=meta.get("hidden", 256),
        arch=meta.get("arch", "bilinear"),
        n_anchor=n_anchor,
    )
    lg.load_state_dict(ckpt["state"])
    lg.eval()

    class LevelMoveWrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, base, xf, xt, xm, rbf):
            return self.m.move_logits(base, xf, xt, xm, rbf)

    dummy = (
        torch.zeros(1, 20, n_anchor),
        torch.zeros(1, 20, 1024 * n_anchor),
        torch.zeros(1, 20, 1024 * n_anchor),
        torch.zeros(1, 1024 * n_anchor),
        torch.zeros(1, 37, 12),
    )
    fp32_level = tmp_dir / "toby2_level.onnx"
    kw = {"dynamo": False} if "dynamo" in torch.onnx.export.__code__.co_varnames else {}
    torch.onnx.export(
        LevelMoveWrapper(lg),
        dummy,
        str(fp32_level),
        input_names=["base", "xf", "xt", "xm", "rbf"],
        output_names=["logits"],
        dynamic_axes={
            "base": {1: "L"},
            "xf": {1: "L"},
            "xt": {1: "L"},
            "rbf": {1: "K"},
            "logits": {1: "K", 2: "L"},
        },
        opset_version=17,
        **kw,
    )
    quantize_dynamic(
        str(fp32_level),
        str(out_dir / "toby2_level.int8.onnx"),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm"],
    )

    # Clean up large fp32 intermediates
    for p in tmp_dir.glob("*"):
        p.unlink(missing_ok=True)
    tmp_dir.rmdir()

    for f in sorted(out_dir.glob("*.onnx")):
        print(f"  READY: {f.name} ({f.stat().st_size / 1e6:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()
