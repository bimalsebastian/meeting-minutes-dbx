/**
 * Stronghold secure storage wrapper.
 * All sensitive data stored in encrypted Stronghold vault.
 */

import { Client, Stronghold } from '@tauri-apps/plugin-stronghold';
import { appDataDir } from '@tauri-apps/api/path';

const VAULT_PASSWORD = 'meetily-vault-password';
const CLIENT_NAME = 'meetily-client';

let strongholdInstance: { stronghold: Stronghold; client: Client } | null = null;

async function getStronghold(): Promise<{ stronghold: Stronghold; client: Client }> {
  if (strongholdInstance) {
    return strongholdInstance;
  }

  const vaultPath = `${await appDataDir()}/vault.hold`;
  const stronghold = await Stronghold.load(vaultPath, VAULT_PASSWORD);

  let client: Client;
  try {
    client = await stronghold.loadClient(CLIENT_NAME);
  } catch {
    client = await stronghold.createClient(CLIENT_NAME);
  }

  strongholdInstance = { stronghold, client };
  return strongholdInstance;
}

/**
 * Store a value securely in Stronghold.
 */
export async function secureStore(key: string, value: string): Promise<void> {
  try {
    const { stronghold, client } = await getStronghold();
    const store = client.getStore();
    const data = Array.from(new TextEncoder().encode(value));
    await store.insert(key, data);
    await stronghold.save();
    console.log(`[Stronghold] Successfully stored key: ${key}`);
  } catch (e) {
    console.error(`[Stronghold] Failed to store key "${key}":`, e);
    throw e; // Re-throw to let caller handle it
  }
}

/**
 * Retrieve a value from Stronghold. Returns empty string if not found.
 */
export async function secureRetrieve(key: string): Promise<string> {
  try {
    const { client } = await getStronghold();
    const store = client.getStore();
    const value = await store.get(key);
    if (value) {
      return new TextDecoder().decode(new Uint8Array(value));
    }
  } catch (e) {
    console.warn(`[Stronghold] Failed to retrieve key "${key}":`, e);
  }
  return '';
}

/**
 * Remove a value from Stronghold.
 */
export async function secureDelete(key: string): Promise<void> {
  const { stronghold, client } = await getStronghold();
  const store = client.getStore();
  await store.remove(key);
  await stronghold.save();
}

/**
 * Store a value with an expiry timestamp (Unix seconds).
 */
export async function secureStoreWithExpiry(
  key: string,
  value: string,
  expirySeconds: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + expirySeconds;

  const { stronghold, client } = await getStronghold();
  const store = client.getStore();

  const data = Array.from(new TextEncoder().encode(value));
  await store.insert(key, data);

  const expiryData = Array.from(new TextEncoder().encode(expiry.toString()));
  await store.insert(`${key}_expiry`, expiryData);

  await stronghold.save();
}

/**
 * Get the expiry timestamp for a key. Returns 0 if not found.
 */
export async function getTokenExpiry(key: string): Promise<number> {
  try {
    const { client } = await getStronghold();
    const store = client.getStore();
    const expiryData = await store.get(`${key}_expiry`);
    if (expiryData) {
      const expiryStr = new TextDecoder().decode(new Uint8Array(expiryData));
      const expiry = parseInt(expiryStr, 10);
      if (expiry) return expiry;
    }
  } catch (e) {
    console.warn(`[Stronghold] Failed to get expiry for key "${key}":`, e);
  }
  return 0;
}

