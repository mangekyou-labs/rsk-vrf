#!/usr/bin/env python3
"""Fill in the drill log template from the rollout wizard's state file.

    rollout-drill-log.py docs/runbooks/drill-log.md .rollout-31/state.env > drill-log.md

A value the wizard did not capture stays as the template's placeholder. Exits non-zero if
the template no longer has the rows the wizard times (7, 11 and 8).
"""
from datetime import datetime
from pathlib import Path
import re
import subprocess
import sys

ROWS = {1: 7, 2: 11, 3: 8}
WIZARD = Path(__file__).resolve().parent / 'rollout-wizard.sh'


def stages():
    """The wizard's stage ids, in order."""
    return subprocess.run(['bash', str(WIZARD), '--list-stages'], capture_output=True, text=True,
                          check=True).stdout.split()


def load(path):
    values = {}
    for line in open(path):
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)='(.*)'$", line.rstrip('\n'))
        if m:
            values[m[1]] = m[2].replace("'\\''", "'")
    return {k: v for k, v in values.items() if v != ''}


def cell(value):
    return value.replace('|', '\\|')


def fill(line, placeholders):
    """Replace each (placeholder, value) in order, once; a missing value keeps the placeholder."""
    done, rest = '', line
    for placeholder, value in placeholders:
        head, found, rest = rest.partition(placeholder)
        if not found:
            return done + head
        done += head + (placeholder if value is None else cell(value))
    return done + rest


def stamp(value):
    return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ')


def summary(values, titles):
    starts = [stamp(x) for k, x in values.items() if re.fullmatch(r'(S\dR\d+|OUT\d)_START_AT', k)]
    ends = [stamp(x) for k, x in values.items() if re.fullmatch(r'(S\dR\d+|OUT\d)_END_AT', k)]
    duration = None
    if starts and ends:
        minutes = int((max(ends) - min(starts)).total_seconds() // 60)
        duration = f'{minutes // 60}h {minutes % 60}m'
    changes = sum(1 for k, x in values.items() if re.fullmatch(r'S\dR\d+_CHANGE', k) and x != 'none')
    failed = []
    for (section, row), title in titles.items():
        outcome = values.get(f'S{section}R{row}_OUTCOME')
        if outcome is None or outcome == 'ok' or outcome.startswith('http') or outcome.startswith('no Incident Note'):
            continue
        failed.append(f'{section}. {title}: {outcome}')
    return duration, str(changes), ('; '.join(failed) if failed else 'none')


def render(template, values):
    lines = template.split('\n')
    section, row, titles = 0, 0, {}
    counts = {1: 0, 2: 0, 3: 0}
    for line in lines:
        m = re.match(r'^## (\d)\. ', line)
        if m:
            section = int(m[1])
        elif line.startswith('## '):
            section = 0
        if section in ROWS and line.startswith('| ') and not line.startswith('| Step |') and not line.startswith('| ---'):
            counts[section] += 1
            titles[(section, counts[section])] = line.split(' | ')[0][2:]
    if counts != ROWS:
        sys.exit(f'drill-log.md has {counts} rows per section, the wizard times {ROWS}: update rollout-drill-log.py')
    duration, changes, failed = summary(values, titles)

    get = values.get
    out, section, row = [], 0, 0
    for line in lines:
        m = re.match(r'^## (\d)\. ', line)
        if m:
            section, row = int(m[1]), 0
        elif line.startswith('## '):
            section = 0
        if line.startswith('| Date (UTC) |'):
            line = fill(line, [('<date>', get('DL_DATE'))])
        elif line.startswith('| Operator |'):
            line = fill(line, [('<name>', get('DL_OPERATOR'))])
        elif line.startswith('| Admin Safe signers |'):
            line = fill(line, [('<signer>, <signer>', get('DL_SIGNERS'))])
        elif line.startswith('| Deployment record |'):
            line = fill(line, [('<commit>', get('DL_COMMIT'))])
        elif line.startswith('| Active Key before the drill |'):
            line = fill(line, [('<keyId>, keyHash <keyHash>', get('DL_KEY_BEFORE'))])
        elif line.startswith('| Announcement |'):
            line = fill(line, [('<link to the announcement in the Warn channel>', get('DL_ANNOUNCEMENT'))])
        elif section in ROWS and line.startswith('| ') and not line.startswith('| Step |') and not line.startswith('| ---'):
            row += 1
            cells = line.split(' | ')
            prefix = f'S{section}R{row}_'
            for i, key in ((2, 'START'), (3, 'END'), (4, 'BLOCK'), (5, 'TX'), (6, 'OUTCOME')):
                if get(prefix + key) is not None and cells[i].startswith('<'):
                    cells[i] = cell(get(prefix + key))
            if get(prefix + 'CHANGE') is not None:
                cells[7] = cell(get(prefix + 'CHANGE')) + ' |'
            line = ' | '.join(cells)
        elif line.startswith('Pending request:') and section == 1:
            line = fill(line, [('<requestId>', get('S1_REQUEST_ID')), ('<deadline>', get('S1_DEADLINE'))])
        elif line.startswith('Blocks from the request to the fulfillment:'):
            line = fill(line, [('<n>', get('S1_BLOCKS'))])
        elif line.startswith('Pending request:') and section == 2:
            line = fill(line, [('<requestId>', get('S2_REQUEST_ID')), ('<oldId>', get('S2_OLD_KEY_ID')),
                               ('<deadline>', get('S2_DEADLINE'))])
        elif line.startswith('New Active Key:'):
            line = fill(line, [('<newId>', get('S2_NEW_KEY_ID')), ('<NEW>', get('S2_NEW_KEY_HASH')),
                               ('<block>', get('S2_NEW_KEY_BLOCK'))])
        elif line.startswith('Pending request:') and section == 3:
            line = fill(line, [('<requestId>', get('S3_REQUEST_ID')), ('<keyId>', get('S3_KEY_ID')),
                               ('<deadline>', get('S3_DEADLINE'))])
        elif line.startswith('Blocks from the Revocation to the refund:'):
            line = fill(line, [('<n>', get('S3_BLOCKS')), ('<n>', get('S3_MISSED'))])
        elif line.startswith('- Total time, first step to last step:'):
            line = fill(line, [('<duration>', duration)])
        elif line.startswith('- Runbook changes made during the drill:'):
            line = fill(line, [('<n>', changes), ('<link to the PR>', get('SUM_PR'))])
        elif line.startswith('- Steps that did not pass:'):
            line = fill(line, [('<none | list each step and what happened>', failed)])
        out.append(line)

    text = '\n'.join(out).rstrip('\n') + '\n'
    done = {stage: values.get('DONE_' + stage.replace('-', '_')) for stage in stages()}
    timeline = [f'| {stage} | {at} |' for stage, at in done.items() if at is not None]
    outage = [f'| {n} | {cell(values.get(f"OUT{n}_TITLE", ""))} | {values.get(f"OUT{n}_START", "")} | '
              f'{values.get(f"OUT{n}_END", "")} | {values.get(f"OUT{n}_BLOCK", "")} |'
              for n in range(1, 9) if f'OUT{n}_START' in values]
    if timeline:
        text += '\n## Rollout timeline\n\nWritten by contracts/script/rollout-wizard.sh: when each stage of #41 was done (UTC).\n\n'
        text += '| Stage | Done |\n| --- | --- |\n' + '\n'.join(timeline) + '\n'
    if outage:
        text += '\n## Outage window (outage.md 8.2)\n\n'
        if 'OUT_ANNOUNCEMENT' in values:
            text += f'Announcement: {values["OUT_ANNOUNCEMENT"]}. '
        if 'OUT_REQUEST_ID' in values:
            text += f'Request {values["OUT_REQUEST_ID"]}, Deadline block {values.get("OUT_DEADLINE", "<deadline>")}. '
        if 'OUT_WINDOW_FROM' in values:
            text += f'Window: blocks {values["OUT_WINDOW_FROM"]} to {values.get("OUT_WINDOW_TO", "<block>")}.'
        text = text.rstrip(' ') + '\n\n| Step | Step of 8.2 | Start | End | Block |\n| --- | --- | --- | --- | --- |\n'
        text += '\n'.join(outage) + '\n'
    if 'READY_CI' in values or 'READY_FINDINGS' in values:
        text += (f'\n## Before the final demo run\n\n'
                 f'CI green on the deployed commit {values.get("READY_COMMIT", "<commit>")}: '
                 f'{values.get("READY_CI", "<yes | no>")}. '
                 f'Every review finding of severity High or above fixed: {values.get("READY_FINDINGS", "<yes | no>")}.')
        if 'READY_AT' in values:
            text += f' Confirmed at {values["READY_AT"]}.'
        text += '\n'
    if 'MISSED_COUNT' in values:
        text += (f'\nMissed Deadlines outside the window, blocks {values.get("MISSED_FROM", "?")} to '
                 f'{values.get("MISSED_TO", "?")}: {values["MISSED_COUNT"]}.\n')
    return text


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: rollout-drill-log.py <drill-log.md template> <state.env>')
    sys.stdout.write(render(open(sys.argv[1]).read(), load(sys.argv[2])))


if __name__ == '__main__':
    main()
