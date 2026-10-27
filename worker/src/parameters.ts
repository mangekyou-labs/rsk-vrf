// Worker configuration held in SSM Parameter Store, one parameter per variable.
//
// `/rsk-vrf/<worker>/COORDINATOR_ADDRESS` becomes COORDINATOR_ADDRESS. Variables
// already set in the environment win, so a host can override one value.
import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';

/** SsmSender is the part of SSMClient this module uses. */
export interface SsmSender {
  send(command: GetParametersByPathCommand): Promise<{ Parameters?: { Name?: string; Value?: string }[]; NextToken?: string }>;
}

/**
 * isPlaceholder tells whether value is the text Terraform puts in a parameter
 * that must be set out of band (infra/modules/worker-host/config.tf).
 */
export function isPlaceholder(value: string): boolean {
  return value.startsWith('unset');
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** loadParameters returns the parameters directly under path, decrypted, by variable name. */
export async function loadParameters(opts: { ssm: SsmSender; path: string }): Promise<Record<string, string>> {
  const path = opts.path.endsWith('/') ? opts.path : `${opts.path}/`;
  const out: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const page = await opts.ssm.send(new GetParametersByPathCommand({ Path: path, Recursive: false, WithDecryption: true, NextToken }));
    for (const parameter of page.Parameters ?? []) {
      const name = (parameter.Name ?? '').slice(path.length);
      // The name is public; never quote the value.
      if (!ENV_NAME.test(name)) throw new Error(`Invalid parameter name ${parameter.Name}`);
      out[name] = parameter.Value ?? '';
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

/** applyParameters sets each parameter the environment leaves unset or empty. */
export function applyParameters(env: Record<string, string | undefined>, parameters: Record<string, string>): void {
  for (const [name, value] of Object.entries(parameters)) {
    if (!env[name]) env[name] = value;
  }
}
