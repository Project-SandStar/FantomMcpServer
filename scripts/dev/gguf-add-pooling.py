#!/usr/bin/env python3
"""
Re-pack a GGUF so Ollama (>= 0.3x) grants it the *embedding* capability.

Why: Ollama decides a model can embed only when the GGUF carries
`<architecture>.pooling_type` (server/images.go: `if m.metadata.Valid("pooling_type")`).
jinaai/jina-code-embeddings-1.5b-GGUF ships without that key, so native Ollama
0.32 on the Macs starts its runner without embeddings and answers
`HTTP 501 "This server does not support embeddings. Start it with --embeddings"`.
Ollama 0.24 (Docker image on BASWS35) never checks, which is why the same file
works there. jina-code-embeddings uses LAST-token pooling (pooling_type = 3).

Usage (on the sidecar host, needs `pip install gguf` — the llama.cpp python
package — and the Ollama blob of the pulled model):

  # 1. find the blob Ollama stores for the model
  python3 gguf-add-pooling.py --find 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0'
  # 2. write a copy with the pooling key
  python3 gguf-add-pooling.py --in /path/to/blob --out /tmp/jina-code-q8-pooled.gguf --pooling last
  # 3. register it under the SAME name so Fantom's model id (and stored vectors) stay valid
  printf 'FROM /tmp/jina-code-q8-pooled.gguf\n' > /tmp/Modelfile
  ollama create 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0' -f /tmp/Modelfile
  ollama show 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0'   # capabilities must list "embedding"
  # 4. in Fantom: POST /admin/sidecars/<id>/embed-fault/clear, then compare a vector
  #    against BASWS35 for the same input (cosine ~1.0) before trusting it fleet-wide.

Pooling codes (llama.cpp): none=0 mean=1 cls=2 last=3 rank=4
"""
import argparse
import json
import os
import subprocess
import sys

POOLING = {"none": 0, "mean": 1, "cls": 2, "last": 3, "rank": 4}


def find_blob(model: str) -> None:
    """Print the GGUF blob path Ollama uses for `model` (via `ollama show --modelfile`)."""
    try:
        out = subprocess.check_output(["ollama", "show", model, "--modelfile"], text=True)
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"ollama show failed: {exc}")
    for line in out.splitlines():
        if line.startswith("FROM "):
            print(line[5:].strip())
            return
    sys.exit("no FROM line in modelfile output")


def repack(src: str, dst: str, pooling: int) -> None:
    """Copy every KV and tensor of `src` into `dst`, adding <arch>.pooling_type.

    Mirrors llama.cpp's gguf-py/gguf/scripts/gguf_new_metadata.py (which cannot
    add arbitrary keys), streaming tensors so a 1.6 GB file is not held in RAM.
    """
    try:
        import gguf  # type: ignore
    except ImportError:
        sys.exit("pip install gguf   (llama.cpp's gguf-py package)")

    reader = gguf.GGUFReader(src)
    arch_field = reader.fields.get(gguf.Keys.General.ARCHITECTURE)
    if arch_field is None:
        sys.exit("general.architecture missing — not a GGUF model file?")
    arch = arch_field.contents()
    pooling_key = f"{arch}.pooling_type"

    writer = gguf.GGUFWriter(dst, arch=arch, endianess=reader.endianess)
    copied = 0
    for field in reader.fields.values():
        # Virtual fields and the ones GGUFWriter writes itself.
        if field.name == gguf.Keys.General.ARCHITECTURE or field.name.startswith("GGUF."):
            continue
        if field.name == pooling_key:
            continue  # replaced below
        val_type = field.types[0]
        sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
        value = field.contents()
        if value is None:
            continue
        writer.add_key_value(field.name, value, val_type, sub_type=sub_type)
        copied += 1
    writer.add_uint32(pooling_key, pooling)

    total = 0
    for tensor in reader.tensors:
        total += tensor.n_bytes
        writer.add_tensor_info(tensor.name, tensor.data.shape, tensor.data.dtype, tensor.data.nbytes, tensor.tensor_type)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_ti_data_to_file()
    written = 0
    for tensor in reader.tensors:
        writer.write_tensor_data(tensor.data, tensor_endianess=reader.endianess)
        written += tensor.n_bytes
        pct = written * 20 // total
        if pct != getattr(repack, "_last_pct", -1):
            repack._last_pct = pct  # type: ignore[attr-defined]
            print(f"  writing tensors {written / total:6.1%}", file=sys.stderr)
    writer.close()
    print(file=sys.stderr)
    print(json.dumps({"out": dst, "architecture": arch, pooling_key: pooling, "kv_copied": copied, "tensors": len(reader.tensors), "bytes": os.path.getsize(dst)}))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--find", metavar="MODEL", help="print the blob path Ollama uses for MODEL")
    ap.add_argument("--in", dest="src", help="source GGUF (Ollama blob or downloaded file)")
    ap.add_argument("--out", dest="dst", help="destination GGUF")
    ap.add_argument("--pooling", default="last", choices=sorted(POOLING), help="pooling type to write (default: last)")
    args = ap.parse_args()
    if args.find:
        find_blob(args.find)
        return
    if not (args.src and args.dst):
        ap.error("--in and --out are required (or --find MODEL)")
    repack(args.src, args.dst, POOLING[args.pooling])


if __name__ == "__main__":
    main()
