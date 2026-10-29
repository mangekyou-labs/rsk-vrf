#!/usr/bin/env python3
"""Fill in the drill log template from the rollout wizard's state file.

    rollout-drill-log.py docs/runbooks/drill-log.md .rollout-31/state.env > drill-log.md

A value the wizard did not capture stays as the template's placeholder. Exits non-zero if
the template no longer has the rows the wizard times (7, 11 and 8).
"""
from datetime import datetime
import re
import sys

ROWS = {1: 7, 2: 11, 3: 8}
STAGES = ['rpc', 'safe', 'deploy', 'verify', 'handoff', 'check', 'discard', 'commit', 'gate',
          'drill_header', 'failover', 'rotation', 'revocation', 'outage', 'missed', 'final', 'publish']


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


def summary(v, titles):
    starts = [stamp(x) for k, x in v.items() if re.fullmatch(r'(S\dR\d+|OUT\d)_START_AT', k)]
    ends = [stamp(x) for k, x in v.items() if re.fullmatch(r'(S\dR\d+|OUT\d)_END_AT', k)]
    duration = None
    if starts and ends:
        minutes = int((max(ends) - min(starts)).total_seconds() // 60)
        duration = f'{minutes // 60}h {minutes % 60}m'
    changes = sum(1 for k, x in v.items() if re.fullmatch(r'S\dR\d+_CHANGE', k) and x != 'none')
    failed = []
    for (s, r), title in titles.items():
        outcome = v.get(f'S{s}R{r}_OUTCOME')
        if outcome is None or outcome == 'ok' or outcome.startswith('http') or outcome.startswith('no Incident Note'):
            continue
        failed.append(f'{s}. {title}: {outcome}')
    return duration, str(changes), ('; '.join(failed) if failed else 'none')


def render(template, v):
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
    duration, changes, failed = summary(v, titles)

    out, section, row = [], 0, 0
    for line in lines:
        m = re.match(r'^## (\d)\. ', line)
        if m:
            section, row = int(m[1]), 0
        elif line.startswith('## '):
            section = 0
        g = v.get
        if line.startswith('| Date (UTC) |'):
            line = fill(line, [('<date>', g('DL_DATE'))])
        elif line.startswith('| Operator |'):
            line = fill(line, [('<name>', g('DL_OPERATOR'))])
        elif line.startswith('| Admin Safe signers |'):
            line = fill(line, [('<signer>, <signer>', g('DL_SIGNERS'))])
        elif line.startswith('| Deployment record |'):
            line = fill(line, [('<commit>', g('DL_COMMIT'))])
        elif line.startswith('| Active Key before the drill |'):
            line = fill(line, [('<keyId>, keyHash <keyHash>', g('DL_KEY_BEFORE'))])
        elif line.startswith('| Announcement |'):
            line = fill(line, [('<link to the announcement in the Warn channel>', g('DL_ANNOUNCEMENT'))])
        elif section in ROWS and line.startswith('| ') and not line.startswith('| Step |') and not line.startswith('| ---'):
            row += 1
            cells = line.split(' | ')
            p = f'S{section}R{row}_'
            for i, key in ((2, 'START'), (3, 'END'), (4, 'BLOCK'), (5, 'TX'), (6, 'OUTCOME')):
                if g(p + key) is not None and cells[i].startswith('<'):
                    cells[i] = cell(g(p + key))
            if g(p + 'CHANGE') is not None:
                cells[7] = cell(g(p + 'CHANGE')) + ' |'
            line = ' | '.join(cells)
        elif line.startswith('Pending request:') and section == 1:
            line = fill(line, [('<requestId>', g('S1_REQUEST_ID')), ('<deadline>', g('S1_DEADLINE'))])
        elif line.startswith('Blocks from the request to the fulfillment:'):
            line = fill(line, [('<n>', g('S1_BLOCKS'))])
        elif line.startswith('Pending request:') and section == 2:
            line = fill(line, [('<requestId>', g('S2_REQUEST_ID')), ('<oldId>', g('S2_OLD_KEY_ID')),
                               ('<deadline>', g('S2_DEADLINE'))])
        elif line.startswith('New Active Key:'):
            line = fill(line, [('<newId>', g('S2_NEW_KEY_ID')), ('<NEW>', g('S2_NEW_KEY_HASH')),
                               ('<block>', g('S2_NEW_KEY_BLOCK'))])
        elif line.startswith('Pending request:') and section == 3:
            line = fill(line, [('<requestId>', g('S3_REQUEST_ID')), ('<keyId>', g('S3_KEY_ID')),
                               ('<deadline>', g('S3_DEADLINE'))])
        elif line.startswith('Blocks from the Revocation to the refund:'):
            line = fill(line, [('<n>', g('S3_BLOCKS')), ('<n>', g('S3_MISSED'))])
        elif line.startswith('- Total time, first step to last step:'):
            line = fill(line, [('<duration>', duration)])
        elif line.startswith('- Runbook changes made during the drill:'):
            line = fill(line, [('<n>', changes), ('<link to the PR>', g('SUM_PR'))])
        elif line.startswith('- Steps that did not pass:'):
            line = fill(line, [('<none | list each step and what happened>', failed)])
        out.append(line)

    text = '\n'.join(out).rstrip('\n') + '\n'
    timeline = [f'| {s.replace("_", "-")} | {v["DONE_" + s]} |' for s in STAGES if 'DONE_' + s in v]
    outage = [f'| {n} | {cell(v.get(f"OUT{n}_TITLE", ""))} | {v.get(f"OUT{n}_START", "")} | '
              f'{v.get(f"OUT{n}_END", "")} | {v.get(f"OUT{n}_BLOCK", "")} |'
              for n in range(1, 9) if f'OUT{n}_START' in v]
    if timeline:
        text += '\n## Rollout timeline\n\nWritten by contracts/script/rollout-wizard.sh: when each stage of #41 was done (UTC).\n\n'
        text += '| Stage | Done |\n| --- | --- |\n' + '\n'.join(timeline) + '\n'
    if outage:
        text += '\n## Outage window (outage.md 8.2)\n\n'
        if 'OUT_ANNOUNCEMENT' in v:
            text += f'Announcement: {v["OUT_ANNOUNCEMENT"]}. '
        if 'OUT_REQUEST_ID' in v:
            text += f'Request {v["OUT_REQUEST_ID"]}, Deadline block {v.get("OUT_DEADLINE", "<deadline>")}. '
        if 'OUT_WINDOW_FROM' in v:
            text += f'Window: blocks {v["OUT_WINDOW_FROM"]} to {v.get("OUT_WINDOW_TO", "<block>")}.'
        text = text.rstrip(' ') + '\n\n| Step | Step of 8.2 | Start | End | Block |\n| --- | --- | --- | --- | --- |\n'
        text += '\n'.join(outage) + '\n'
    if 'MISSED_COUNT' in v:
        text += (f'\nMissed Deadlines outside the window, blocks {v.get("MISSED_FROM", "?")} to '
                 f'{v.get("MISSED_TO", "?")}: {v["MISSED_COUNT"]}.\n')
    return text


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: rollout-drill-log.py <drill-log.md template> <state.env>')
    sys.stdout.write(render(open(sys.argv[1]).read(), load(sys.argv[2])))


if __name__ == '__main__':
    main()
