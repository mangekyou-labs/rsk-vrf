// The worker CLI with a SecretSource that serves TEST_PROVING_KEY for any
// name, so check-key can run in a child process without AWS.
import { runCli } from '../../src/cli.ts';

const secret = process.env.TEST_PROVING_KEY ?? '';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdoutIsTTY: process.stdout.isTTY === true,
  secrets: () => ({ load: async () => secret }),
});
