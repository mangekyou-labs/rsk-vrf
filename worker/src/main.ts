#!/usr/bin/env node
// Entry point: `worker keygen` and `worker check-key <keyHash>`.
import { runCli } from './cli.ts';
import { AwsSecretSource } from './secrets.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdoutIsTTY: process.stdout.isTTY === true,
  secrets: () => new AwsSecretSource(),
});
