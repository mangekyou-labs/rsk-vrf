// The public drand relays the worker uses when DRAND_RELAY_URLS and DRAND_RELAY_URL are unset.

/** The evmnet chain hash. A relay host without it in the path serves drand's default chain, not evmnet. */
export const EVMNET_CHAIN_HASH = '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';

/** The evmnet chain on the three public relay hosts, tried in order. */
export const DEFAULT_RELAYS: readonly string[] = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh']
  .map(host => `${host}/${EVMNET_CHAIN_HASH}`);
