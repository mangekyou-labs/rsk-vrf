#!/usr/bin/env python3
"""Check coordinator runtime size and compiler-derived ERC-7201 storage layouts."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import re

CONTRACTS = Path(__file__).resolve().parents[1]
SNAPSHOT = CONTRACTS / 'storage-layout' / 'VRFCoordinator.json'

def runtime(artifact):
    bytecode = artifact['deployedBytecode']['object'].removeprefix('0x')
    if len(bytecode) % 2:
        raise ValueError('Invalid runtime bytecode')
    size = len(bytes.fromhex(bytecode))
    margin = 24576 - size
    if margin < 0:
        raise ValueError(f'VRFCoordinator runtime is {size} B, exceeding 24,576 B by {-margin} B')
    print(f'VRFCoordinator runtime: {size} B; margin: {margin} B')
    if margin < 1024:
        print(f'::warning::VRFCoordinator runtime margin is only {margin} B (under 1,024 B)')

def compatible(old, new, path='layout', allow_append=True):
    """Existing fields retain their order, positions and representations."""
    if isinstance(old, dict):
        for key, value in old.items():
            if key not in new:
                raise ValueError(f'{path}: removed {key}')
            if key == 'bytes' and 'members' in old and allow_append:
                if int(new[key]) < int(value):
                    raise ValueError(f'{path}: storage shrank')
                continue
            compatible(value, new[key], f'{path}.{key}', allow_append and key != 'base')
    elif isinstance(old, list):
        if len(new) < len(old) or (not allow_append and len(new) != len(old)):
            raise ValueError(f'{path}: incompatible member count')
        for i, value in enumerate(old):
            compatible(value, new[i], f'{path}[{i}]', allow_append)
    elif old != new:
        raise ValueError(f'{path}: {old!r} changed to {new!r}')


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def run(*args):
    return subprocess.check_output(args, cwd=CONTRACTS, text=True)


def extract():
    # Force a coherent build-info file rather than combining stale compiler runs.
    subprocess.run(['forge', 'build', '--force', '--build-info', '--extra-output', 'storageLayout'], cwd=CONTRACTS, check=True, stdout=subprocess.DEVNULL)
    builds = [json.loads(p.read_text()) for p in (CONTRACTS / 'out/build-info').glob('*.json')]
    build = next(b for b in builds if 'src/VRFCoordinator.sol' in b.get('output', {}).get('sources', {}))
    nodes = {n['id']: n for source in build['output']['sources'].values() for n in walk(source.get('ast', {})) if 'id' in n}
    coordinator = next(n for n in nodes.values() if n.get('nodeType') == 'ContractDefinition' and n.get('name') == 'VRFCoordinator')
    def evaluate(expression, seen=None):
        seen = set() if seen is None else seen
        kind = expression.get('nodeType')
        if kind == 'Literal' and expression.get('kind') == 'number': return expression['value'].lower()
        if kind in ['Identifier', 'IdentifierPath']:
            declaration = nodes[expression['referencedDeclaration']]
            if declaration['id'] in seen: raise ValueError('Circular storage accessor')
            seen = seen | {declaration['id']}
            if declaration.get('value'): return evaluate(declaration['value'], seen)
            # Local variables used by the accessor, e.g. Initializable's slot.
            for node in nodes.values():
                if node.get('nodeType') == 'VariableDeclarationStatement' and any(d and d['id'] == declaration['id'] for d in node['declarations']):
                    return evaluate(node['initialValue'], seen)
        if kind == 'FunctionCall':
            function = nodes[expression['expression']['referencedDeclaration']]
            # Respect the most-derived implementation of a virtual slot getter.
            function = next((f for cid in coordinator['linearizedBaseContracts'] for f in nodes[cid]['nodes'] if f.get('nodeType') == 'FunctionDefinition' and f.get('name') == function['name'] and f.get('body')), function)
            returns = [n for n in walk(function.get('body', {})) if n.get('nodeType') == 'Return']
            if len(returns) == 1: return evaluate(returns[0]['expression'], seen)
        raise ValueError('Storage accessor expression is unsupported; review and extend the layout extractor')
    namespaces = []
    enums = {n['canonicalName']: [m['name'] for m in n['members']] for n in nodes.values() if n.get('nodeType') == 'EnumDefinition'}
    for contract_id in coordinator['linearizedBaseContracts']:
        contract = nodes[contract_id]
        source_path = next(path for path, source in build['output']['sources'].items() if contract_id in [n.get('id') for n in source.get('ast', {}).get('nodes', [])])
        for struct in contract['nodes']:
            if struct.get('nodeType') != 'StructDefinition':
                continue
            annotation = struct.get('documentation', {})
            if isinstance(annotation, dict): annotation = annotation.get('text', '')
            match = re.search(r'@custom:storage-location\s+erc7201:([^\s]+)', annotation or '')
            if not match:
                continue
            namespace = match[1]
            locations = []
            for function in contract['nodes']:
                if function.get('nodeType') != 'FunctionDefinition': continue
                if not any(p.get('typeName', {}).get('referencedDeclaration') == struct['id'] for p in function['returnParameters']['parameters']): continue
                for assembly in walk(function.get('body', {})):
                    if assembly.get('nodeType') != 'InlineAssembly': continue
                    for assignment in walk(assembly.get('AST', {})):
                        if assignment.get('nodeType') != 'YulAssignment' or not any(v['name'].endswith('.slot') for v in assignment['variableNames']): continue
                        value = assignment['value']
                        if value.get('nodeType') == 'YulLiteral':
                            locations.append(value['value'].lower())
                            continue
                        reference = next((r for r in assembly['externalReferences'] if r['src'] == value.get('src')), None)
                        if reference:
                            locations.append(evaluate({'nodeType': 'Identifier', 'referencedDeclaration': reference['declaration']}))
            if len(set(locations)) != 1:
                raise ValueError(f'{namespace}: cannot identify one accessor storage location')
            namespaces.append((namespace, contract['name'], struct['name'], source_path, locations[0]))
    if not namespaces: raise ValueError('No ERC-7201 namespaces found')
    if len({n[0] for n in namespaces}) != len(namespaces): raise ValueError('Duplicate ERC-7201 namespace')
    probe = 'pragma solidity 0.8.30;\n'
    for source in sorted({n[3] for n in namespaces}):
        probe += f'import "../{source}";\n'
    probe += 'contract StorageLayoutProbe {\n'
    for i, (_, contract, struct, _, _) in enumerate(namespaces):
        probe += f'{contract}.{struct} private namespace_{i};\n'
    probe += '}\n'
    with tempfile.NamedTemporaryFile(mode='w', suffix='.s.sol', prefix='StorageLayoutProbe', dir=CONTRACTS / 'script') as file:
        file.write(probe); file.flush()
        subprocess.run(['forge', 'build', f'script/{Path(file.name).name}', '--extra-output', 'storageLayout'], cwd=CONTRACTS, check=True, stdout=subprocess.DEVNULL)
        layout = json.loads((CONTRACTS / 'out' / Path(file.name).name / 'StorageLayoutProbe.json').read_text())['storageLayout']
    types = layout['types']
    def describe(type_id):
        entry = types[type_id]
        result = {'label': entry['label'], 'encoding': entry['encoding'], 'bytes': entry['numberOfBytes']}
        if entry['label'].startswith('enum '):
            result['variants'] = enums[entry['label'].removeprefix('enum ')]
        for key in ['base', 'key', 'value']:
            if key in entry: result[key] = describe(entry[key])
        if 'members' in entry:
            result['members'] = [{'label': m['label'], 'slot': m['slot'], 'offset': m['offset'], 'type': describe(m['type'])} for m in entry['members']]
        return result
    result = {'namespaces': {}}
    for i, (namespace, _, _, _, location) in enumerate(namespaces):
        field = next(m for m in layout['storage'] if m['label'] == f'namespace_{i}')
        result['namespaces'][namespace] = {'location': location, 'type': describe(field['type'])}
    # Namespace identifiers do not prevent accessors from targeting the same
    # physical slots. Include every occupied root slot, not just the first one.
    ranges = []
    for namespace, entry in result['namespaces'].items():
        location = entry['location']
        start = int(location, 16) if location.startswith('0x') else int(location)
        end = start + (int(entry['type']['bytes']) + 31) // 32
        if start < 0 or start >= 2**256 or end > 2**256:
            raise ValueError(f'{namespace}: namespace storage range exceeds uint256')
        ranges.append((start, end, namespace))
    ranges.sort()
    for before, after in zip(ranges, ranges[1:]):
        if after[0] < before[1]:
            raise ValueError(f'Namespace storage ranges overlap: {before[2]} and {after[2]}')
    # Unnamespaced state in the coordinator or a base must also be retained.
    ordinary = json.loads((CONTRACTS / 'out/VRFCoordinator.sol/VRFCoordinator.json').read_text())['storageLayout']
    if ordinary['storage']:
        raise ValueError('Coordinator has non-namespaced storage; add an explicit reviewed layout policy')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-artifact', type=Path)
    parser.add_argument('--compare', nargs=2, type=Path, metavar=('BASELINE', 'CANDIDATE'))
    parser.add_argument('--write-snapshot', action='store_true')
    parser.add_argument('--base-ref', help='Also preserve the snapshot from this git revision')
    args = parser.parse_args()
    if args.runtime_artifact:
        runtime(json.loads(args.runtime_artifact.read_text()))
        return
    if args.compare:
        compatible(*(json.loads(p.read_text()) for p in args.compare))
        return
    current = extract()
    if args.base_ref:
        base = subprocess.run(['git', 'show', f'{args.base_ref}:contracts/storage-layout/VRFCoordinator.json'], cwd=CONTRACTS, capture_output=True, text=True)
        if base.returncode == 0:
            compatible(json.loads(base.stdout), current)
        else:
            raise ValueError('Base revision has no storage snapshot; bootstrap this gate explicitly before using --base-ref')
    if args.write_snapshot:
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        if SNAPSHOT.exists(): compatible(json.loads(SNAPSHOT.read_text()), current)
        SNAPSHOT.write_text(json.dumps(current, indent=2, sort_keys=True) + '\n')
        print(f'Wrote {SNAPSHOT}')
    elif json.loads(SNAPSHOT.read_text()) != current:
        compatible(json.loads(SNAPSHOT.read_text()), current)
        raise ValueError('Storage snapshot is stale; run python3 script/check-upgrade-safety.py --write-snapshot and review the diff')
    runtime(json.loads((CONTRACTS / 'out/VRFCoordinator.sol/VRFCoordinator.json').read_text()))
    print('Storage layout is compatible and snapshot matches')

if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'::error::{error}', file=sys.stderr)
        sys.exit(1)
