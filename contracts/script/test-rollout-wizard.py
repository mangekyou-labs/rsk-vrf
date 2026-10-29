#!/usr/bin/env python3
"""Exercise rollout-wizard.sh and rollout-drill-log.py through their command-line interfaces.

The wizard runs with its answers on stdin and stub `cast` and browser commands on PATH, so no
chain or browser is contacted. Each test drives one stage from a state file that marks the
stages before it as done.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent.parent
WIZARD = SCRIPTS / 'rollout-wizard.sh'
RENDER = SCRIPTS / 'rollout-drill-log.py'
TEMPLATE = REPO / 'docs' / 'runbooks' / 'drill-log.md'

SAFE = '0x' + 'dd' * 20
PROXY = '0x' + 'bb' * 20
SINGLETON = '0x00000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c762'
KEY_SHAPED = '0x' + '4c' * 32
TX = '0x' + '7a' * 32
STEPS = ['rpc', 'safe', 'deploy', 'verify', 'handoff', 'check', 'discard', 'commit', 'gate',
         'drill-header', 'failover', 'rotation', 'revocation', 'outage', 'missed', 'final', 'publish']

# A stub cast. It answers from stub.json in $STUB_DIR, and logs each call to calls.log.
CAST_STUB = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    d = os.environ['STUB_DIR']
    stub = json.load(open(os.path.join(d, 'stub.json')))
    args = sys.argv[1:]
    open(os.path.join(d, 'calls.log'), 'a').write(' '.join(args) + '\\n')
    cmd = args[0]
    if cmd == 'chain-id':
        print(stub.get('chainId', 31))
    elif cmd == 'block-number':
        print(stub.get('block', 1000))
    elif cmd == 'logs':
        sys.exit(stub.get('logsRc', 0))
    elif cmd == 'receipt':
        receipt = stub.get('receipts', {}).get(args[args.index('--rpc-url') + 2])
        if receipt is None:
            print('transaction not found', file=sys.stderr)
            sys.exit(1)
        print(receipt[args[-1]] if args[-1] in receipt else json.dumps(receipt))
    elif cmd in ('call', 'storage'):
        for sig, out in stub.get('calls', {}).items():
            if sig in args:
                print(out)
                break
        else:
            print('no stub for ' + ' '.join(args), file=sys.stderr)
            sys.exit(1)
    else:
        print('no stub for ' + cmd, file=sys.stderr)
        sys.exit(1)
''')

SAFE_CALLS = {
    'VERSION()(string)': '"1.4.1"',
    '0': SINGLETON,
    'getThreshold()(uint256)': '2',
    'getOwners()(address[])': '[0x' + '01' * 20 + ', 0x' + '02' * 20 + ', 0x' + '03' * 20 + ']',
}


def done_state(*steps):
    return {f'DONE_{s.replace("-", "_")}': '2026-10-29T00:00:00Z' for s in steps}


class WizardRun:
    """One temporary rollout directory, stub tools and a way to run the wizard in it."""

    def __init__(self, test):
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dir = self.root / 'rollout'
        self.bin = self.root / 'bin'
        self.stub = self.root / 'stub'
        for d in (self.dir, self.bin, self.stub):
            d.mkdir()
        (self.bin / 'cast').write_text(CAST_STUB)
        (self.bin / 'wslview').write_text('#!/bin/sh\nexit 0\n')
        for f in self.bin.iterdir():
            f.chmod(0o755)
        self.set_stub({})
        self.record = self.root / '31.json'
        self.record.write_text(json.dumps({
            'chainId': 31, 'safe': SAFE,
            'contracts': {'proxy': {'address': PROXY, 'block': 900}, 'implementation': {'address': '0x' + 'aa' * 20}},
        }))

    def set_stub(self, stub):
        (self.stub / 'stub.json').write_text(json.dumps(stub))

    def set_state(self, values):
        state = self.dir / 'state.env'
        state.write_text(''.join(f"{k}='{v}'\n" for k, v in values.items()))
        state.chmod(0o600)

    def state(self):
        path = self.dir / 'state.env'
        if not path.exists():
            return {}
        return {m[1]: m[2] for m in re.finditer(r"^([A-Za-z0-9_]+)='(.*)'$", path.read_text(), re.M)}

    def calls(self):
        path = self.stub / 'calls.log'
        return path.read_text() if path.exists() else ''

    def run(self, *args, answers='', env=None):
        full_env = {
            'PATH': f'{self.bin}:{os.environ["PATH"]}',
            'HOME': str(self.root),
            'STUB_DIR': str(self.stub),
            'ROLLOUT_DIR': str(self.dir),
            'RECORD': str(self.record),
            'TERM': 'dumb',
        }
        full_env.update(env or {})
        # The first line answers the banner's "Ready to start?".
        return subprocess.run(['bash', str(WIZARD), *args], input='\n' + answers, env=full_env,
                              capture_output=True, text=True, timeout=60)


class RefusesKeyMaterialTest(unittest.TestCase):
    def test_refuses_to_start_with_a_private_key_in_its_environment(self):
        w = WizardRun(self)
        for name in ('DEMO_PRIVATE_KEY', 'PRIVATE_KEY', 'ETH_PRIVATE_KEY'):
            with self.subTest(name=name):
                out = w.run(answers='\n' * 20, env={name: KEY_SHAPED})
                self.assertNotEqual(out.returncode, 0)
                self.assertIn(name, out.stderr)
                self.assertNotIn(KEY_SHAPED[2:], out.stdout + out.stderr)
                self.assertEqual(w.state(), {})

    def test_refuses_a_key_shaped_answer_where_it_asks_for_an_address(self):
        w = WizardRun(self)
        w.set_stub({'calls': SAFE_CALLS})
        w.set_state(done_state('rpc') | {'RPC_URL': 'https://public-node.testnet.rsk.co'})
        out = w.run(answers=f'{KEY_SHAPED}\n{SAFE}\n' + '\n' * 5)
        self.assertIn('looks like key material', out.stdout)
        self.assertEqual(w.state()['SAFE'], SAFE)
        self.assertNotIn(KEY_SHAPED[2:], (w.dir / 'state.env').read_text())

    def test_refuses_a_mnemonic(self):
        w = WizardRun(self)
        w.set_stub({'calls': SAFE_CALLS})
        w.set_state(done_state('rpc') | {'RPC_URL': 'https://public-node.testnet.rsk.co'})
        mnemonic = ' '.join(['abandon'] * 11 + ['about'])
        out = w.run(answers=f'{mnemonic}\n{SAFE}\n' + '\n' * 5)
        self.assertIn('looks like key material', out.stdout)
        self.assertNotIn('abandon', (w.dir / 'state.env').read_text())


    def test_refuses_a_bare_hash_where_it_asks_for_a_transaction_and_never_sends_it(self):
        w = WizardRun(self)
        w.set_state(outage_state())
        out = w.run(answers=f'{KEY_SHAPED}\n')
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('looks like key material', out.stdout)
        self.assertNotIn(KEY_SHAPED[2:], w.calls())
        self.assertNotIn(KEY_SHAPED[2:], (w.dir / 'state.env').read_text())


def outage_state():
    return done_state(*STEPS[:13], 'OUT1', 'OUT2', 'OUT3') | {
        'RPC_URL': 'https://rpc.example', 'LOGS_RPC_URL': 'https://logs.example',
        'SAFE': SAFE, 'PROXY': PROXY, 'OUT_ANNOUNCED_EPOCH': '1000000000',
    }


class TransactionLinkTest(unittest.TestCase):
    def test_a_link_to_an_unknown_transaction_is_not_saved(self):
        w = WizardRun(self)
        w.set_state(outage_state())
        out = w.run(answers=f'https://rootstock-testnet.blockscout.com/tx/{TX}\n')
        self.assertIn('was not saved', out.stdout)
        self.assertNotIn('OUT_REQUEST_TX', w.state())

    def test_a_request_link_saves_the_hash_its_block_and_the_request_id_from_the_receipt(self):
        w = WizardRun(self)
        request_id = '0x' + '11' * 32
        topic0 = '0x548fbfced1f0370ecbb6d0a49365208f8b1711725efcadc9d1650ecc6be3e377'
        deadline = 1234
        get_request = '0x' + ''.join(f'{v:064x}' for v in [0, 1, 0, 0, 0, 0, 0, deadline, 0, 1])
        w.set_stub({
            'receipts': {TX: {'status': '1 (success)', 'blockNumber': '950',
                              'logs': [{'topics': [topic0, request_id, '0x' + '00' * 32]}]}},
            'calls': {'getRequest(bytes32)': get_request},
        })
        w.set_state(outage_state())
        w.run(answers=f'https://rootstock-testnet.blockscout.com/tx/{TX}/\n')
        state = w.state()
        self.assertEqual(state['OUT_REQUEST_TX'], TX)
        self.assertEqual(state['OUT_REQUEST_TX_BLOCK'], '950')
        self.assertEqual(state['OUT_REQUEST_ID'], request_id)
        self.assertEqual(state['OUT_DEADLINE'], '1234')
        self.assertIn('DONE_OUT4', state)


class StatusAndResumeTest(unittest.TestCase):
    def test_status_lists_the_stages_in_order_and_names_the_next(self):
        w = WizardRun(self)
        w.set_state(done_state('rpc', 'safe'))
        out = w.run('--status')
        self.assertEqual(out.returncode, 0, out.stderr)
        lines = out.stdout.splitlines()
        self.assertEqual([line.split()[1] for line in lines[:-1]], STEPS)
        self.assertEqual([line.split()[0] for line in lines[:3]], ['done', 'done', 'todo'])
        self.assertEqual(lines[-1], 'next: deploy')

    def test_status_says_none_when_every_stage_is_done(self):
        w = WizardRun(self)
        w.set_state(done_state(*STEPS))
        self.assertEqual(w.run('--status').stdout.splitlines()[-1], 'next: none')

    def test_a_rerun_resumes_at_the_first_stage_not_done(self):
        w = WizardRun(self)
        w.set_state(done_state(*STEPS[:8]) | {'RPC_URL': 'https://rpc.example', 'LOGS_RPC_URL': 'https://logs.example'})
        out = w.run(answers='')
        self.assertNotIn('RPC_URL:', out.stdout)
        self.assertIn('Stage 9/17', out.stdout)
        self.assertIn('Step 2: gate', out.stdout)


GOOD_LOG = 'chain 31, coordinator 0xbb\nrequest roll: https://x/tx/0x1\nok: fulfilled\nRESULT {"requestId": "0x1"}\n'


class GateTest(unittest.TestCase):
    def gate_run(self, logs, answers, stub=None):
        w = WizardRun(self)
        w.set_stub(stub or {})
        w.set_state(done_state(*STEPS[:8]) | {'RPC_URL': 'https://rpc.example', 'LOGS_RPC_URL': 'https://logs.example'})
        (w.dir / 'gate').mkdir()
        for name, text in logs.items():
            (w.dir / 'gate' / f'demo-{name}.log').write_text(text)
        return w, w.run(answers=answers)

    def test_passes_when_every_demo_log_ends_with_a_result_on_chain_31(self):
        names = ['dice', 'read-path', 'reverting-consumer', 'withdraw-fees', 'recompute-beta', 'rejections']
        w, out = self.gate_run({n: GOOD_LOG for n in names}, answers='')
        self.assertIn('DONE_gate', w.state())
        self.assertIn('gate passed', out.stdout)

    def test_refuses_to_pass_when_a_demo_failed(self):
        failed = 'chain 31, coordinator 0xbb\nFAILED: fulfillment never came\n'
        w, out = self.gate_run({'dice': GOOD_LOG, 'read-path': failed}, answers='\nn\n')
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('demo:read-path did not pass', out.stdout)
        self.assertIn('gate is not passed', out.stdout)
        self.assertNotIn('DONE_gate', w.state())
        self.assertNotIn('drill', out.stdout.split('gate is not passed')[1])

    def test_refuses_a_demo_log_from_another_chain(self):
        other = GOOD_LOG.replace('chain 31', 'chain 30')
        w, out = self.gate_run({'dice': other}, answers='\nn\n')
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn('DONE_gate', w.state())

    def test_shows_the_demo_command_for_a_second_shell_without_any_key(self):
        w, out = self.gate_run({}, answers='\nn\n')
        self.assertIn('npm run demo:dice --prefix worker', out.stdout)
        self.assertIn('second shell', out.stdout)
        self.assertNotIn('--private-key', out.stdout)

    def test_refuses_a_logs_rpc_that_does_not_serve_logs(self):
        w, out = self.gate_run({}, answers='n\n', stub={'logsRc': 1})
        self.assertNotEqual(out.returncode, 0)
        self.assertIn('does not serve eth_getLogs', out.stdout)
        self.assertNotIn('DONE_gate', w.state())
        self.assertNotIn('demo:dice', out.stdout)

    def test_asks_for_the_logs_rpc_when_none_is_set_and_checks_it_with_cast_logs(self):
        w = WizardRun(self)
        w.set_state(done_state(*STEPS[:8]) | {'RPC_URL': 'https://rpc.example'})
        out = w.run(answers='https://logs.example\n')
        self.assertIn('not decided yet', out.stdout)
        self.assertEqual(w.state()['LOGS_RPC_URL'], 'https://logs.example')
        self.assertIn('logs --rpc-url https://logs.example', w.calls())


TIME = re.compile(r'^\d\d:\d\d:\d\d$')


class DrillRowTest(unittest.TestCase):
    def failover_state(self, *rows, **extra):
        return (done_state(*STEPS[:10], *rows) |
                {'RPC_URL': 'https://rpc.example', 'LOGS_RPC_URL': 'https://logs.example', 'PROXY': PROXY} | extra)

    def test_times_a_row_and_records_its_block_and_outcome(self):
        w = WizardRun(self)
        w.set_stub({'block': 1042})
        w.set_state(self.failover_state())
        w.run(answers='\n\n\n\n')
        state = w.state()
        self.assertRegex(state['S1R1_START'], TIME)
        self.assertRegex(state['S1R1_END'], TIME)
        self.assertEqual(state['S1R1_BLOCK'], '1042')
        self.assertEqual(state['S1R1_TX'], 'none')
        self.assertEqual(state['S1R1_OUTCOME'], 'ok')
        self.assertEqual(state['S1R1_CHANGE'], 'none')
        self.assertIn('DONE_S1R1', state)
        self.assertNotIn('DONE_S1R2', state)
        self.assertNotIn('DONE_failover', state)

    def test_records_what_differed_and_the_runbook_change(self):
        w = WizardRun(self)
        w.set_state(self.failover_state())
        w.run(answers='\n\nno Page after 5 min\nfixed the wait in 8.1.1\n')
        state = w.state()
        self.assertEqual(state['S1R1_OUTCOME'], 'no Page after 5 min')
        self.assertEqual(state['S1R1_CHANGE'], 'fixed the wait in 8.1.1')

    def test_a_rerun_resumes_at_the_row_not_done(self):
        w = WizardRun(self)
        w.set_state(self.failover_state('S1R1'))
        out = w.run(answers='')
        self.assertNotIn('Announce the drill', out.stdout)
        self.assertIn('Stop only the Primary Worker', out.stdout)

    def test_the_incident_note_of_the_failover_is_the_operators_choice(self):
        rows = [f'S1R{n}' for n in range(1, 7)]
        extra = {'S1R4_BLOCK': '1000', 'S1R5_BLOCK': '1101', 'S1R4_REQUEST_ID': '0x' + '11' * 32}
        with self.subTest(choice='no'):
            w = WizardRun(self)
            w.set_state(self.failover_state(*rows, **extra))
            out = w.run(answers='\nn\n\n')
            state = w.state()
            self.assertIn('not decided yet', out.stdout)
            self.assertEqual(state['S1_INCIDENT_NOTE'], 'no')
            self.assertIn('no Incident Note', state['S1R7_OUTCOME'])
            self.assertEqual(state['S1_BLOCKS'], '101')
            self.assertIn('DONE_failover', state)
        with self.subTest(choice='yes'):
            w = WizardRun(self)
            w.set_state(self.failover_state(*rows, **extra))
            w.run(answers='\ny\n\nhttps://github.com/mangekyou-labs/rsk-vrf/issues/90\n\n')
            state = w.state()
            self.assertEqual(state['S1_INCIDENT_NOTE'], 'yes')
            self.assertEqual(state['S1R7_OUTCOME'], 'https://github.com/mangekyou-labs/rsk-vrf/issues/90')


class DrillLogTest(unittest.TestCase):
    def render(self, values):
        with tempfile.TemporaryDirectory() as d:
            env = Path(d) / 'state.env'
            env.write_text(''.join(f"{k}='{v}'\n" for k, v in values.items()))
            out = subprocess.run([sys.executable, str(RENDER), str(TEMPLATE), str(env)],
                                 capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout

    def test_fills_the_header_rows_and_prose(self):
        text = self.render({
            'DL_DATE': '2026-10-29', 'DL_OPERATOR': 'Kyle', 'DL_SIGNERS': 'Ann, Bo',
            'DL_COMMIT': 'abc1234', 'DL_KEY_BEFORE': '1, keyHash 0x99', 'DL_ANNOUNCEMENT': 'https://chat/1',
            'S1R1_START': '10:00:00', 'S1R1_END': '10:01:00', 'S1R1_BLOCK': '1042', 'S1R1_TX': 'none',
            'S1R1_OUTCOME': 'ok', 'S1R1_CHANGE': 'none',
            'S1R7_START': '11:00:00', 'S1R7_END': '11:02:00', 'S1R7_BLOCK': '1200', 'S1R7_TX': 'none',
            'S1R7_OUTCOME': 'https://github.com/x/issues/9', 'S1R7_CHANGE': 'reworded 1.5',
            'S1R1_START_AT': '2026-10-29T10:00:00Z', 'S1R7_END_AT': '2026-10-29T11:02:00Z',
            'S1_REQUEST_ID': '0x11', 'S1_DEADLINE': '5000', 'S1_BLOCKS': '101',
            'S3_MISSED': '0', 'SUM_PR': 'https://github.com/x/pull/3',
        })
        self.assertIn('| Date (UTC) | 2026-10-29 |', text)
        self.assertIn('| Operator | Kyle |', text)
        self.assertIn('| Admin Safe signers | Ann, Bo |', text)
        self.assertIn('| Deployment record | `deployments/31.json` at commit abc1234 |', text)
        self.assertIn('| Active Key before the drill | 1, keyHash 0x99 |', text)
        self.assertIn('| Announce the drill | outage.md 8.1.1 | 10:00:00 | 10:01:00 | 1042 | none | ok | none |', text)
        self.assertIn('| Post the Incident Note | outage.md 1.5 | 11:00:00 | 11:02:00 | 1200 | none | '
                      'https://github.com/x/issues/9 | reworded 1.5 |', text)
        self.assertIn('Pending request: 0x11, Deadline block 5000.', text)
        self.assertIn('Blocks from the request to the fulfillment: 101 (`GRACE_BLOCKS` is 100).', text)
        self.assertIn('Requests that missed a Deadline in the drill: 0.', text)
        self.assertIn('- Total time, first step to last step: 1h 2m', text)
        self.assertIn('- Runbook changes made during the drill: 1, in https://github.com/x/pull/3', text)
        self.assertIn('- Steps that did not pass: none', text)

    def test_leaves_a_value_not_captured_as_its_placeholder(self):
        text = self.render({'DL_OPERATOR': 'Kyle'})
        self.assertIn('| Date (UTC) | <date> |', text)
        self.assertIn('| Stop only the Primary Worker (`docker compose ... stop worker`) | outage.md 8.1.2 | '
                      '<start> | <end> | <block> | none | <outcome> | <change> |', text)

    def test_lists_the_steps_that_did_not_pass(self):
        text = self.render({'S2R4_OUTCOME': 'backup failed check-key', 'S2R4_START': '10:00:00'})
        self.assertIn('- Steps that did not pass: 2. `check-key` on both hosts: backup failed check-key', text)

    def test_the_last_stage_writes_the_filled_in_drill_log(self):
        w = WizardRun(self)
        w.set_state(done_state(*STEPS[:-1]) | {'DL_OPERATOR': 'Kyle', 'S3_MISSED': '0'})
        out = w.run(answers='https://github.com/x/pull/3\n')
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        log = (w.dir / 'drill-log.md').read_text()
        self.assertIn('| Operator | Kyle |', log)
        self.assertIn('in https://github.com/x/pull/3', log)
        self.assertIn('| final |', log)
        self.assertIn('DONE_publish', w.state())


if __name__ == '__main__':
    unittest.main()
