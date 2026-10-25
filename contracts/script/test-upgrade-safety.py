#!/usr/bin/env python3
"""Exercise the CI gate's public command-line interface."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('check-upgrade-safety.py')

class RuntimeGateTest(unittest.TestCase):
    def test_runtime_limit_and_warning_boundaries(self):
        for size, status, warning in [(23552, 0, False), (23553, 0, True), (24576, 0, True), (24577, 1, False)]:
            with self.subTest(size=size), tempfile.TemporaryDirectory() as tmp:
                artifact = Path(tmp) / 'artifact.json'
                artifact.write_text(json.dumps({'deployedBytecode': {'object': '0x' + '00' * size}}))
                result = subprocess.run([sys.executable, str(SCRIPT), '--runtime-artifact', str(artifact)], capture_output=True, text=True)
                self.assertEqual(result.returncode, status, result.stdout + result.stderr)
                self.assertEqual('::warning::' in result.stdout, warning)

class StorageGateTest(unittest.TestCase):
    def test_existing_fields_cannot_move_or_change_type(self):
        old = {'namespaces': {'rsk-vrf.storage.VRFCoordinator': {'location': '0x1234', 'type': {'label': 'struct CoordinatorStorage', 'encoding': 'inplace', 'bytes': '32', 'members': [{'label': 'fee', 'slot': '0', 'offset': 0, 'type': {'label': 'uint96', 'encoding': 'inplace', 'bytes': '12'}}]}}}}
        import copy
        for mutation in ['same', 'append', 'slot', 'offset', 'type', 'location', 'delete']:
            new = copy.deepcopy(old)
            ns = new['namespaces']['rsk-vrf.storage.VRFCoordinator']
            field = ns['type']['members'][0]
            if mutation == 'append':
                ns['type']['members'].append({'label': 'cap', 'slot': '0', 'offset': 12, 'type': {'label': 'uint32', 'encoding': 'inplace', 'bytes': '4'}})
            elif mutation == 'slot': field['slot'] = '1'
            elif mutation == 'offset': field['offset'] = 1
            elif mutation == 'type': field['type']['label'] = 'uint104'
            elif mutation == 'location': ns['location'] = '0x5678'
            elif mutation == 'delete': del new['namespaces']['rsk-vrf.storage.VRFCoordinator']
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                before, after = Path(tmp) / 'old.json', Path(tmp) / 'new.json'
                before.write_text(json.dumps(old)); after.write_text(json.dumps(new))
                result = subprocess.run([sys.executable, str(SCRIPT), '--compare', str(before), str(after)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if mutation in ['same', 'append'] else 1, result.stdout + result.stderr)

class CompiledLayoutTest(unittest.TestCase):
    @unittest.skipUnless('--integration' in sys.argv, 'pass --integration to compile real source mutations')
    def test_snapshot_regeneration_rejects_overlapping_namespace_ranges(self):
        source = SCRIPT.parents[1] / 'src/VRFCoordinator.sol'
        snapshot = SCRIPT.parents[1] / 'storage-layout/VRFCoordinator.json'
        original, original_snapshot = source.read_text(), snapshot.read_bytes()
        declaration = 'contract VRFCoordinator is VRF, UUPSUpgradeable, Ownable2StepUpgradeable {'
        location = int('93e472312740d9d8ceb01cbb3b48eb9a4521b1f1a04d71a14a7e0f61bd068900', 16)
        try:
            for start, fields, error in [
                (location, 'uint256 value;', 'overlap'),
                (location + 1, 'uint256 value;', 'overlap'),
                (2**256 - 1, 'uint256 first; uint256 second;', 'exceeds uint256'),
            ]:
                with self.subTest(location=hex(start)):
                    snapshot.write_bytes(original_snapshot)
                    injected = f'''
    /// @custom:storage-location erc7201:test.overlapping
    struct OverlappingStorage {{ {fields} }}
    function _overlappingStorage() private pure returns (OverlappingStorage storage result) {{
        assembly {{ result.slot := 0x{start:064x} }}
    }}
'''
                    source.write_text(original.replace(declaration, declaration + injected))
                    result = subprocess.run([sys.executable, str(SCRIPT), '--write-snapshot'], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertIn(error, result.stderr)
                    self.assertEqual(snapshot.read_bytes(), original_snapshot)
        finally:
            source.write_text(original)
            snapshot.write_bytes(original_snapshot)

    @unittest.skipUnless('--integration' in sys.argv, 'pass --integration to compile real source mutations')
    def test_compiler_detects_namespace_slot_and_nested_layout_mutations(self):
        source = SCRIPT.parents[1] / 'src/VRFCoordinator.sol'
        original = source.read_text()
        mutations = [
            ('accessor location', '0x93e472312740d9d8ceb01cbb3b48eb9a4521b1f1a04d71a14a7e0f61bd068900', '0x93e472312740d9d8ceb01cbb3b48eb9a4521b1f1a04d71a14a7e0f61bd068800'),
            ('mapped request layout', 'uint48 requestBlock;\n        uint8 drandConfigId;', 'uint8 drandConfigId;\n        uint48 requestBlock;'),
            ('array config layout', 'uint64 genesis;\n        uint64 period;', 'uint64 period;\n        uint64 genesis;'),
        ]
        try:
            for name, before, after in mutations:
                with self.subTest(mutation=name):
                    self.assertIn(before, original)
                    source.write_text(original.replace(before, after))
                    result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertIn('changed to', result.stderr)
        finally:
            source.write_text(original)

if __name__ == '__main__':
    if '--integration' in sys.argv: sys.argv.remove('--integration')
    unittest.main()
