"""Measure the probe contracts on Rootstock over JSON-RPC, read-only.

Each probe's constructor runs the verifier between two gasleft() reads and returns
abi.encode(bool ok, uint256 verifyGas, bytes32 output) as its "runtime code". We send the
contract-creation transaction (no `to`) via eth_call - which executes it against the latest
state without mining or spending anything - and via eth_estimateGas for the whole-tx figure.
No transaction is signed or broadcast and no account or funds are needed.

Usage: python3 -I scripts/measure_rsk.py <probe_root> [testnet|mainnet ...]
Reads only this project's own forge artifacts under <probe_root>/out.
"""
import json
import os
import sys
import urllib.request

RPC = {"testnet": "https://public-node.testnet.rsk.co", "mainnet": "https://public-node.rsk.co"}
PROBES = [
    ("ChainlinkVRFProbe.sol/ChainlinkVRFProbe.json", "chainlink VRF.sol (crosschain-prover copy)", [0, 1, 2]),
    ("EcvrfRskip516Probe.sol/EcvrfRskip516Probe.json", "RFC 9381-style ECVRF secp256k1 via RSKIP516", [0, 1, 2, 3]),
    ("WitnetVRFProbe.sol/WitnetVRFProbe.json", "witnet VRF.verify / fastVerify (modes 0/1; 2/3 tampered)", [0, 1, 2, 3]),
    ("DrandEvmnetProbe.sol/DrandEvmnetProbe.json", "drand evmnet BN254 (3 = hash-to-G1 only, 4 = off-curve sig)", [0, 1, 2, 3, 4]),
]


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json", "User-Agent": "rsk-proof-probe"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def calldata_gas(b: bytes) -> int:
    # RSKj GasCost: TX_ZERO_DATA 4, TX_NO_ZERO_DATA 16 after RSKIP400 (68 before)
    return sum(4 if x == 0 else 16 for x in b)


def main():
    root = sys.argv[1]
    nets = sys.argv[2:] or ["testnet"]
    for net in nets:
        url = RPC[net]
        blk = rpc(url, "eth_getBlockByNumber", ["latest", False])["result"]
        ver = rpc(url, "web3_clientVersion", [])["result"]
        bgl = int(blk["gasLimit"], 16)
        print(f"== {net} block {int(blk['number'], 16)} gasLimit {bgl} client {ver}")
        for art, label, modes in PROBES:
            with open(os.path.join(root, "out", art)) as f:
                bytecode = json.load(f)["bytecode"]["object"]
            code = bytes.fromhex(bytecode[2:] if bytecode.startswith("0x") else bytecode)
            for m in modes:
                data = code + m.to_bytes(32, "big")
                tx = {"data": "0x" + data.hex(), "gas": hex(min(bgl, 10_000_000))}
                c = rpc(url, "eth_call", [tx, "latest"])
                e = rpc(url, "eth_estimateGas", [tx])
                if "result" in c and len(c["result"]) == 2 + 192:
                    r = bytes.fromhex(c["result"][2:])
                    ok, used, out = bool(int.from_bytes(r[:32], "big")), int.from_bytes(r[32:64], "big"), r[64:].hex()
                    cres = f"ok={ok} verifyGas={used} out=0x{out[:16]}..."
                else:
                    cres = f"call={json.dumps(c.get('error', c.get('result')))[:160]}"
                eres = int(e["result"], 16) if "result" in e else json.dumps(e.get("error"))[:160]
                print(f"  {label} mode={m}: {cres} | estimateGas={eres} | initcode={len(data)}B calldataGas={calldata_gas(data)}")


if __name__ == "__main__":
    main()
