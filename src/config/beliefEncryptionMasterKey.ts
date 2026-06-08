import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Returns the path for the CSFLE master key.
 * Separate from the credential vault master key to avoid coupling.
 */
export function getBeliefMasterKeyPath(tenureHome?: string): string {
  if (process.env.TENURE_BELIEF_KEY_PATH) {
    return process.env.TENURE_BELIEF_KEY_PATH;
  }
  const base = tenureHome ?? resolve(homedir(), '.tenure');
  return resolve(base, 'belief.key');
}
