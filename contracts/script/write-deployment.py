#!/usr/bin/env python3
"""Merge forge's broadcast receipts into the deployment record that DeployCoordinator wrote.

Adds the creation block and tx hash of both contracts, the config transactions and the commit
SHA. Addresses are lowercased (EIP-1191). verify.sh adds the explorer links once each
verification succeeds.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

CONTRACTS = Path(__file__).resolve().parents[1]
# Forge cannot name calls made through the proxy, so match their selectors to the coordinator ABI.
ARTIFACT = CONTRACTS / 'out' / 'VRFCoordinator.sol' / 'VRFCoordinator.json'
ADDRESS = re.compile(r'0x[0-9a-fA-F]{40}')
# The chain whose record is committed; its commit must name the exact source.
COMMITTED_CHAIN = 31


def lowercase(value):
    if isinstance(value, dict):
        return {key: lowercase(item) for key, item in value.items()}
    if isinstance(value, list):
        return [lowercase(item) for item in value]
    if isinstance(value, str) and ADDRESS.fullmatch(value):
        return value.lower()
    return value


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()


def commit(repo, record_path, chain_id, allow_dirty):
    """HEAD, with a `-dirty` suffix if the tree has changes other than the record itself."""
    top = Path(git(repo, 'rev-parse', '--show-toplevel')).resolve()
    record = record_path.resolve()
    pathspec = [':/']
    if record.is_relative_to(top):
        pathspec.append(f':(top,exclude){record.relative_to(top).as_posix()}')
    head = git(repo, 'rev-parse', 'HEAD')
    if not git(repo, 'status', '--porcelain', '--untracked-files=all', '--', *pathspec):
        return head
    if chain_id == COMMITTED_CHAIN and not allow_dirty:
        sys.exit(f'the tree has uncommitted changes, so commit {head} does not name the deployed source; '
                 'commit them or pass --allow-dirty')
    return f'{head}-dirty'


def merge(record, broadcast, functions):
    blocks = {}
    for receipt in broadcast['receipts']:
        if int(receipt['status'], 16) != 1:
            sys.exit(f'transaction {receipt["transactionHash"]} reverted')
        blocks[receipt['transactionHash']] = int(receipt['blockNumber'], 16)

    def block(tx):
        if tx['hash'] not in blocks:
            sys.exit(f'no receipt for transaction {tx["hash"]}; was the broadcast interrupted?')
        return blocks[tx['hash']]

    names = {entry['address']: name for name, entry in record['contracts'].items()}
    contracts = {}
    transactions = []
    for tx in broadcast['transactions']:
        if tx['transactionType'] == 'CREATE':
            address = tx['contractAddress'].lower()
            if address not in names:
                sys.exit(f'transaction {tx["hash"]} created {address}, which the record does not name')
            contracts[names[address]] = {'address': address, 'block': block(tx), 'txHash': tx['hash']}
        else:
            selector = tx['transaction']['input'][:10]
            function = tx['function'] or functions.get(selector)
            if function is None:
                sys.exit(f'transaction {tx["hash"]} calls {selector}, which the coordinator ABI does not name')
            transactions.append({'function': function, 'txHash': tx['hash'], 'block': block(tx)})
    missing = record['contracts'].keys() - contracts.keys()
    if missing:
        sys.exit(f'the broadcast does not create {", ".join(sorted(missing))}')
    return contracts, transactions


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('record', type=Path, help='the record DeployCoordinator wrote; rewritten in place')
    parser.add_argument('broadcast', type=Path, help='broadcast/DeployCoordinator.s.sol/<chainId>/run-latest.json')
    parser.add_argument('--repo', type=Path, default=CONTRACTS, help='the git checkout whose HEAD is recorded')
    parser.add_argument('--allow-dirty', action='store_true',
                        help=f'record HEAD-dirty instead of refusing a dirty tree on chain {COMMITTED_CHAIN}')
    args = parser.parse_args()

    record = lowercase(json.loads(args.record.read_text()))
    broadcast = json.loads(args.broadcast.read_text())
    methods = json.loads(ARTIFACT.read_text())['methodIdentifiers']
    functions = {'0x' + selector: name for name, selector in methods.items()}

    contracts, transactions = merge(record, broadcast, functions)
    deployment = {
        'chainId': record['chainId'],
        'commit': commit(args.repo, args.record, record['chainId'], args.allow_dirty),
        'deployer': record['deployer'],
        'safe': record['safe'],
        'contracts': contracts,
        'transactions': transactions,
        'config': record['config'],
    }
    args.record.write_text(json.dumps(deployment, indent=2) + '\n')


if __name__ == '__main__':
    main()
