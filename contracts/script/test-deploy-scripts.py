#!/usr/bin/env python3
"""Exercise write-deployment.py and verify.sh through their command-line interfaces.

Needs `forge build` (for the coordinator ABI), cast and jq. verify.sh runs against a stub
forge, so no explorer is contacted.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
WRITE = SCRIPTS / 'write-deployment.py'
VERIFY = SCRIPTS / 'verify.sh'
IMPLEMENTATION = '0x' + 'aa' * 20
PROXY = '0x' + 'bb' * 20
DEPLOYER = '0x' + 'cc' * 20
SAFE = '0x' + 'dd' * 20
SET_FEE = '0x13b971fe'  # setFeeConfig(uint256)


def record(chain_id):
    return {
        'chainId': chain_id,
        'deployer': DEPLOYER.upper().replace('0X', '0x'),
        'safe': SAFE,
        'contracts': {'implementation': {'address': IMPLEMENTATION}, 'proxy': {'address': PROXY}},
        'config': {'drand': {'publicKey': ['0x' + '01' * 32] * 4, 'genesis': 1727521075, 'period': 3}, 'fee': 20000000000000},
    }


def broadcast(receipts=True, created=(IMPLEMENTATION, PROXY)):
    transactions = [{'transactionType': 'CREATE', 'contractAddress': address, 'hash': f'0x{i:064x}', 'function': None, 'transaction': {'input': '0x6080'}} for i, address in enumerate(created)]
    transactions.append({'transactionType': 'CALL', 'contractAddress': PROXY, 'hash': f'0x{9:064x}', 'function': None, 'transaction': {'input': SET_FEE + '00' * 32}})
    return {
        'transactions': transactions,
        'receipts': [{'transactionHash': tx['hash'], 'status': '0x1', 'blockNumber': hex(100 + i)} for i, tx in enumerate(transactions)] if receipts else [],
    }


def git(repo, *args):
    return subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


class WriteDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        git(self.repo, 'init', '-q')
        (self.repo / 'tracked.txt').write_text('a\n')
        (self.repo / 'deployments').mkdir()
        git(self.repo, 'add', 'tracked.txt')
        git(self.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
        self.head = git(self.repo, 'rev-parse', 'HEAD')

    def tearDown(self):
        self.tmp.cleanup()
        self.out.cleanup()

    def write(self, chain_id=31, flags=(), **kwargs):
        path = self.repo / 'deployments' / f'{chain_id}.json'
        path.write_text(json.dumps(record(chain_id)))
        # Outside the repo, as broadcast/ is gitignored.
        receipts = Path(self.out.name) / 'run-latest.json'
        receipts.write_text(json.dumps(broadcast(**kwargs)))
        result = subprocess.run([sys.executable, str(WRITE), str(path), str(receipts), '--repo', str(self.repo), *flags], capture_output=True, text=True)
        return result, path

    def test_merges_receipts_names_proxy_calls_and_lowercases(self):
        result, path = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        written = json.loads(path.read_text())
        self.assertEqual(list(written), ['chainId', 'commit', 'deployer', 'safe', 'contracts', 'transactions', 'config'])
        self.assertEqual(written['commit'], self.head, 'the record itself does not make the tree dirty')
        self.assertEqual(written['deployer'], DEPLOYER)
        self.assertEqual(written['contracts']['proxy'], {'address': PROXY, 'block': 101, 'txHash': f'0x{1:064x}'})
        self.assertEqual(written['transactions'], [{'function': 'setFeeConfig(uint256)', 'txHash': f'0x{9:064x}', 'block': 102}])
        self.assertNotIn('verification', written['contracts']['implementation'], 'verify.sh adds links once verified')

    def test_refuses_a_dirty_tree_on_chain_31_unless_allowed(self):
        (self.repo / 'tracked.txt').write_text('b\n')
        refused, _ = self.write()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('uncommitted changes', refused.stderr)

        allowed, path = self.write(flags=['--allow-dirty'])
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(json.loads(path.read_text())['commit'], f'{self.head}-dirty')

    def test_marks_a_dirty_tree_off_chain_31(self):
        (self.repo / 'untracked.txt').write_text('new\n')
        result, path = self.write(chain_id=33)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(path.read_text())['commit'], f'{self.head}-dirty')

    def test_names_a_missing_receipt(self):
        result, _ = self.write(receipts=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'no receipt for transaction 0x{0:064x}', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_names_an_unrecorded_creation(self):
        stranger = '0x' + 'ee' * 20
        result, _ = self.write(created=(IMPLEMENTATION, stranger))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'created {stranger}, which the record does not name', result.stderr)
        self.assertNotIn('Traceback', result.stderr)


STUB_FORGE = '''#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in *"--verifier $STUB_FAIL"*) exit 1 ;; esac
'''


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        bin_dir = self.dir / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'forge').write_text(STUB_FORGE)
        (bin_dir / 'forge').chmod(0o755)
        self.log = self.dir / 'forge.log'
        self.env = {**os.environ, 'PATH': f'{bin_dir}{os.pathsep}{os.environ["PATH"]}', 'STUB_LOG': str(self.log)}
        self.record = self.dir / '31.json'
        self.record.write_text(json.dumps(record(31) | {'deployer': DEPLOYER}))

    def tearDown(self):
        self.tmp.cleanup()

    def verify(self, fail='none'):
        # A path relative to the caller's cwd, which verify.sh must resolve before its cd.
        return subprocess.run([str(VERIFY), '31.json'], cwd=self.dir, env=self.env | {'STUB_FAIL': fail}, capture_output=True, text=True)

    def test_links_each_verified_contract(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        contracts = json.loads(self.record.read_text())['contracts']
        self.assertEqual(contracts['proxy']['verification'], {
            'blockscout': f'https://rootstock-testnet.blockscout.com/address/{PROXY}?tab=contract',
            'sourcify': f'https://repo.sourcify.dev/31/{PROXY}',
        })
        self.assertEqual(set(contracts['implementation']['verification']), {'blockscout', 'sourcify'})

    def test_a_failed_verifier_does_not_stop_the_other_or_get_a_link(self):
        result = self.verify(fail='blockscout')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.log.read_text().count('--verifier sourcify'), 2, 'Sourcify still runs for both contracts')
        for entry in json.loads(self.record.read_text())['contracts'].values():
            self.assertEqual(list(entry['verification']), ['sourcify'])


if __name__ == '__main__':
    unittest.main()
