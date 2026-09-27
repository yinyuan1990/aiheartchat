"""Verify Arm contracts on Sourcify without a local compiler: sends sources + the deploy-time solc settings, Sourcify compiles and matches.
Usage: python arm/ops/sourcify_verify.py targets.txt  (one "<address> <path>:<Contract>" per line; already-verified ones are skipped)"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "contracts"
API = "https://sourcify.dev/server"
CHAIN = 5042
COMPILER = "0.8.26+commit.8a97fa7a"
REMAP = {"forge-std/": "lib/forge-std/src/", "@openzeppelin/contracts/": "lib/openzeppelin-contracts/contracts/"}
IMPORT = re.compile(r'import\s+(?:[^"\']*?from\s+)?["\']([^"\']+)["\']')


def resolve(frm: str, imp: str) -> str:
    for k, v in REMAP.items():
        if imp.startswith(k):
            return v + imp[len(k):]
    if imp.startswith("."):
        parts = (Path(frm).parent / imp).as_posix().split("/")
        out = []
        for p in parts:
            if p == "..":
                out.pop()
            elif p != ".":
                out.append(p)
        return "/".join(out)
    return imp


def collect(entry: str) -> dict:
    srcs, todo = {}, [entry]
    while todo:
        f = todo.pop()
        if f in srcs:
            continue
        text = (ROOT / f).read_text(encoding="utf-8")
        srcs[f] = {"content": text}
        todo += [resolve(f, i) for i in IMPORT.findall(text)]
    return srcs


def std_json(entry: str) -> dict:
    return {
        "language": "Solidity",
        "sources": collect(entry),
        "settings": {
            "remappings": sorted(f"{k}={v}" for k, v in REMAP.items()),
            "optimizer": {"enabled": True, "runs": 800},
            "metadata": {"useLiteralContent": False, "bytecodeHash": "ipfs", "appendCBOR": True},
            "outputSelection": {"*": {"*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata"]}},
            "evmVersion": "cancun",
            "viaIR": False,
            "libraries": {},
        },
    }


def req(method: str, url: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except (TimeoutError, OSError) as e:
        return 0, {"_net": str(e)}


def status(addr: str):
    return req("GET", f"{API}/v2/contract/{CHAIN}/{addr}")[1].get("match")


def verify(addr: str, ident: str, tx: str | None = None):
    m = status(addr)
    if m:
        print(f"{addr} already {m}")
        return
    path, _ = ident.split(":")
    body = {"stdJsonInput": std_json(path), "compilerVersion": COMPILER, "contractIdentifier": ident}
    if tx:
        body["creationTransactionHash"] = tx
    code, j = req("POST", f"{API}/v2/verify/{CHAIN}/{addr}", body)
    vid = j.get("verificationId")
    if not vid:
        print(f"{addr} submit failed {code}: {json.dumps(j)[:300]}")
        return
    for _ in range(40):
        time.sleep(5)
        _, s = req("GET", f"{API}/v2/verify/{vid}")
        if s.get("isJobCompleted"):
            err = s.get("error")
            print(f"{addr} {ident} -> {s.get('contract', {}).get('match')}" + (f" ERR {json.dumps(err)[:400]}" if err else ""))
            return
    print(f"{addr} still pending ({vid})")


if __name__ == "__main__":
    bc = json.loads((ROOT / "broadcast/Deploy.s.sol/5042/run-latest.json").read_text())
    txs = {t["contractAddress"].lower(): t["hash"] for t in bc["transactions"] if t.get("contractAddress")}
    for line in open(sys.argv[1], encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        addr, ident = line.split()
        verify(addr, ident, txs.get(addr.lower()))
