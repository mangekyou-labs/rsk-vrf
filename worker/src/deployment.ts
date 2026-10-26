// Reads the coordinator address from a deployments/<chainId>.json record written by
// contracts/script/deploy.sh. The worker has no start block: each poll backfills a fixed
// window, so the record's creation block is not needed.
import { getAddress, isAddress, type Address } from 'viem';

export function coordinatorFromDeployment(text: string, chainId: number): Address {
  let record: unknown;
  try { record = JSON.parse(text); } catch { throw new Error('Invalid deployment'); }
  if (typeof record !== 'object' || record === null) throw new Error('Invalid deployment');
  const { chainId: recorded, contracts } = record as { chainId?: unknown; contracts?: { proxy?: { address?: unknown } } };
  const address = contracts?.proxy?.address;
  if (recorded !== chainId || typeof address !== 'string' || !isAddress(address, { strict: false })) throw new Error('Invalid deployment');
  return getAddress(address.toLowerCase());
}
