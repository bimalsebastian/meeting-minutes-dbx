/**
 * Stronghold secure storage wrapper with deterministic vault key.
 * All sensitive data stored in encrypted Stronghold vault.
 * 
 * CRITICAL: Vault password must match the Rust-side Argon2 derivation input.
 */

import { Client, Stronghold } from '@tauri-apps/plugin-stronghold';
import { appDataDir } from '@tauri-apps/api/path';

// Cached instances to avoid re-initialization
let strongholdInstance: Stronghold | null = null;
let clientInstance: Client | null = null;

// Constants - MUST NEVER CHANGE or vault becomes unreadable
const VAULT_PATH = 'meetily-vault.hold';
const CLIENT_NAME = 'meetily';
// Fixed password - matches Rust Argon2 derivation input
const VAULT_PASSWORD = 'meetily-dbx-fixed-password-2024';

/**
 * Get or initialize the Stronghold client.
 * Handles corrupt vault recovery automatically.
 */
async function getClient(): Promise<Client> {
  if (clientInstance) {
    return clientInstance;
  }

  const appDir = await appDataDir();
  const vaultPath = `${appDir}/${VAULT_PATH}`;
  
  console.log('[Stronghold] Initializing vault at:', vaultPath);
  
  // Try to load existing vault, handle corruption gracefully
  try {
    strongholdInstance = await Stronghold.load(vaultPath, VAULT_PASSWORD);
  } catch (e) {
    const errMsg = String(e);
    // Detect vault corruption/key mismatch
    if (
      errMsg.includes('BadFileKey') || 
      errMsg.includes('failed to decode') || 
      errMsg.includes('decrypt')
    ) {
      console.warn('[Stronghold] Corrupt vault detected, recreating:', errMsg);
      
      // Delete corrupt vault file via Tauri fs
      try {
        const { remove } = await import('@tauri-apps/plugin-fs');
        await remove(vaultPath);
        console.log('[Stronghold] Deleted corrupt vault file');
      } catch (deleteErr) {
        // File may not exist or permission denied, ignore
        console.warn('[Stronghold] Could not delete vault file:', deleteErr);
      }
      
      // Create fresh vault with correct key
      strongholdInstance = await Stronghold.load(vaultPath, VAULT_PASSWORD);
      console.log('[Stronghold] Created fresh vault');
    } else {
      // Other errors (permissions, disk full, etc.)
      throw e;
    }
  }
  
  // Load or create client
  try {
    clientInstance = await strongholdInstance.loadClient(CLIENT_NAME);
    console.log('[Stronghold] Loaded existing client');
  } catch {
    clientInstance = await strongholdInstance.createClient(CLIENT_NAME);
    console.log('[Stronghold] Created new client');
  }
  
  console.log('[Stronghold] Vault ready');
  return clientInstance;
}

/**
 * Store a value securely in Stronghold.
 * Automatically saves vault to disk.
 */
export async function secureStore(key: string, value: string): Promise<void> {
  console.log('[Stronghold] secureStore:', key);
  
  try {
    const client = await getClient();
    const store = client.getStore();
    
    const encoder = new TextEncoder();
    await store.insert(key, Array.from(encoder.encode(value)));
    
    // CRITICAL: explicitly save vault to disk after every write
    await strongholdInstance!.save();
    console.log('[Stronghold] Saved vault after writing:', key);
  } catch (e) {
    console.error('[Stronghold] Failed to store key:', key, e);
    throw e;
  }
}

/**
 * Retrieve a value from Stronghold.
 * Returns null if key not found.
 */
export async function secureRetrieve(key: string): Promise<string | null> {
  console.log('[Stronghold] secureRetrieve:', key);
  
  try {
    const client = await getClient();
    const store = client.getStore();
    
    const data = await store.get(key);
    if (!data) {
      console.log('[Stronghold] Key not found:', key);
      return null;
    }
    
    const decoder = new TextDecoder();
    const value = decoder.decode(new Uint8Array(data));
    console.log('[Stronghold] Retrieved key:', key, `(${value.length} chars)`);
    return value;
  } catch (e) {
    console.warn('[Stronghold] secureRetrieve failed for key:', key, e);
    return null;
  }
}

/**
 * Remove a value from Stronghold.
 * Automatically saves vault to disk.
 */
export async function secureDelete(key: string): Promise<void> {
  console.log('[Stronghold] secureDelete:', key);
  
  try {
    const client = await getClient();
    const store = client.getStore();
    await store.remove(key);
    
    // Save vault after deletion
    await strongholdInstance!.save();
    console.log('[Stronghold] Saved vault after deleting:', key);
  } catch (e) {
    console.warn('[Stronghold] secureDelete failed for key:', key, e);
    throw e;
  }
}

/**
 * Store a value with an expiry timestamp (Unix seconds).
 * Stores both the value and a separate expiry key.
 */
export async function secureStoreWithExpiry(
  key: string,
  value: string,
  expirySeconds: number
): Promise<void> {
  console.log('[Stronghold] secureStoreWithExpiry:', key, `expires in ${expirySeconds}s`);
  
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + expirySeconds;

  const client = await getClient();
  const store = client.getStore();

  const encoder = new TextEncoder();
  
  // Store value
  await store.insert(key, Array.from(encoder.encode(value)));
  
  // Store expiry timestamp
  await store.insert(`${key}_expiry`, Array.from(encoder.encode(expiry.toString())));

  // Save vault after both writes
  await strongholdInstance!.save();
  console.log('[Stronghold] Saved vault after writing with expiry:', key);
}

/**
 * Get the expiry timestamp for a key.
 * Returns 0 if not found or invalid.
 */
export async function getTokenExpiry(key: string): Promise<number> {
  console.log('[Stronghold] getTokenExpiry:', key);
  
  try {
    const client = await getClient();
    const store = client.getStore();
    
    const expiryData = await store.get(`${key}_expiry`);
    if (!expiryData) {
      console.log('[Stronghold] No expiry found for key:', key);
      return 0;
    }
    
    const decoder = new TextDecoder();
    const expiryStr = decoder.decode(new Uint8Array(expiryData));
    const expiry = parseInt(expiryStr, 10);
    
    if (isNaN(expiry)) {
      console.warn('[Stronghold] Invalid expiry value for key:', key, expiryStr);
      return 0;
    }
    
    console.log('[Stronghold] Expiry for key:', key, expiry);
    return expiry;
  } catch (e) {
    console.warn('[Stronghold] getTokenExpiry failed for key:', key, e);
    return 0;
  }
}
