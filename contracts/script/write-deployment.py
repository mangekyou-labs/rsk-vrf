#!/usr/bin/env python3
"""Merge forge's broadcast receipts into the deployment record that DeployCoordinator wrote.

Adds the creation block and tx hash of both contracts, the config transactions, the commit
SHA and, on chain 31, the Blockscout and Sourcify links. Addresses are lowercased (EIP-1191).

Usage: write-deployment.py <record.json> <broadcast/.../run-latest.json>
"""

import json
import pathlib
import re
import subprocess
import sys

ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
BLOCKSCOUT = {31: "https://rootstock-testnet.blockscout.com"}
SOURCIFY = "https://repo.sourcify.dev"
# Forge cannot name calls made through the proxy, so match their selectors to the coordinator ABI.
ARTIFACT = pathlib.Path(__file__).parent.parent / "out/VRFCoordinator.sol/VRFCoordinator.json"


def lowercase(value):
    if isinstance(value, dict):
        return {key: lowercase(item) for key, item in value.items()}
    if isinstance(value, list):
        return [lowercase(item) for item in value]
    if isinstance(value, str) and ADDRESS.fullmatch(value):
        return value.lower()
    return value


def main(record_path, broadcast_path):
    with open(record_path) as f:
        record = lowercase(json.load(f))
    with open(broadcast_path) as f:
        broadcast = json.load(f)

    blocks = {}
    for receipt in broadcast["receipts"]:
        if int(receipt["status"], 16) != 1:
            sys.exit(f"transaction {receipt['transactionHash']} reverted")
        blocks[receipt["transactionHash"]] = int(receipt["blockNumber"], 16)

    with open(ARTIFACT) as f:
        functions = {"0x" + selector: name for name, selector in json.load(f)["methodIdentifiers"].items()}

    chain_id = record["chainId"]
    contracts = {}
    transactions = []
    for tx in broadcast["transactions"]:
        if tx["transactionType"] == "CREATE":
            address = tx["contractAddress"].lower()
            name = next(name for name, entry in record["contracts"].items() if entry["address"] == address)
            entry = {"address": address, "block": blocks[tx["hash"]], "txHash": tx["hash"]}
            if chain_id in BLOCKSCOUT:
                entry["verification"] = {
                    "blockscout": f"{BLOCKSCOUT[chain_id]}/address/{address}?tab=contract",
                    "sourcify": f"{SOURCIFY}/{chain_id}/{address}",
                }
            contracts[name] = entry
        else:
            selector = tx["transaction"]["input"][:10]
            transactions.append({"function": tx["function"] or functions[selector], "txHash": tx["hash"], "block": blocks[tx["hash"]]})
    if contracts.keys() != record["contracts"].keys():
        sys.exit("broadcast does not create every recorded contract")

    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    deployment = {
        "chainId": chain_id,
        "commit": commit,
        "deployer": record["deployer"],
        "safe": record["safe"],
        "contracts": contracts,
        "transactions": transactions,
        "config": record["config"],
    }
    with open(record_path, "w") as f:
        json.dump(deployment, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
