// The worker's operator subcommands, used by the runbooks.
//
//   worker keygen             new Proving Key: secret to stdout, public key and keyHash to stderr
//   worker check-key <hash>   confirm the secret stored for keyHash loads and matches
//
// keygen writes the secret to stdout so it can be piped straight into `age`
// or `aws secretsmanager create-secret`; it never touches disk, and it refuses
// to print to a terminal.
import { ProvingKey } from './proving-key.ts';
import { type SecretSource, secretName } from './secrets.ts';
import type { Hex } from './vrf/prover.ts';

export interface CliDeps {
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutIsTTY: boolean;
  /** secrets is called only by commands that need the store. */
  secrets(): SecretSource;
}

const USAGE = 'usage: worker keygen | worker check-key <keyHash>\n';
const KEY_HASH = /^0x[0-9a-fA-F]{64}$/;

const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

/** runCli runs one subcommand and returns its exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'keygen':
      if (args.length !== 0) return usage(deps);
      return keygen(deps);
    case 'check-key':
      if (args.length !== 1 || !KEY_HASH.test(args[0]!)) return usage(deps);
      return checkKey(args[0]!.toLowerCase() as Hex, deps);
    default:
      return usage(deps);
  }
}

function usage(deps: CliDeps): number {
  deps.stderr(USAGE);
  return 2;
}

function keygen(deps: CliDeps): number {
  if (deps.stdoutIsTTY) {
    deps.stderr('keygen: refusing to print a Proving Key to a terminal; pipe stdout into age or Secrets Manager\n');
    return 1;
  }
  const key = ProvingKey.generate();
  const [x, y] = key.publicKey.map(word);
  deps.stderr(`publicKey: [${x}, ${y}]\nkeyHash: ${key.keyHash}\n`);
  deps.stdout(`${key.revealSecretHex()}\n`);
  return 0;
}

async function checkKey(keyHash: Hex, deps: CliDeps): Promise<number> {
  const name = secretName(keyHash);
  let key: ProvingKey;
  try {
    key = ProvingKey.fromHex(await deps.secrets().load(name));
  } catch (err) {
    // Neither the store nor fromHex puts secret text in its message.
    deps.stderr(`check-key: cannot load ${name}: ${err instanceof Error ? err.message : 'unknown error'}\n`);
    return 1;
  }
  if (key.keyHash !== keyHash) {
    deps.stderr(`check-key: ${name} holds the Proving Key for ${key.keyHash}, not ${keyHash}\n`);
    return 1;
  }
  deps.stdout(`check-key: ${name} loads and matches keyHash ${keyHash}\n`);
  return 0;
}
