import { exportJWK, generateDPoPToken } from './bluesky-auth';

// Bluesky API utilities
const API_URL = 'https://bsky.social/xrpc';

// Create a custom lexicon schema for "im.flushing.right.now"
// This would normally be registered with the AT Protocol
export const FLUSHING_STATUS_NSID = 'im.flushing.right.now';

export interface FlushingRecord {
  $type: typeof FLUSHING_STATUS_NSID;
  text: string;
  emoji: string;
  createdAt: string;
}

// Make an authenticated request to the Bluesky API
export async function makeAuthenticatedRequest(
  endpoint: string,
  method: string,
  accessToken: string,
  keyPair: CryptoKeyPair,
  dpopNonce: string | null = null,
  body?: any
): Promise<any> {
  const url = `${API_URL}/${endpoint}`;
  
  // If no nonce is provided, try to get one first
  if (!dpopNonce) {
    try {
      // Make a HEAD request to get a nonce
      const headResponse = await fetch(url, {
        method: 'HEAD'
      });
      
      const nonce = headResponse.headers.get('DPoP-Nonce');
      if (nonce) {
        return makeAuthenticatedRequest(endpoint, method, accessToken, keyPair, nonce, body);
      }
    } catch (err) {
      console.warn('Failed to get nonce via HEAD request, continuing without it', err);
    }
  }
  
  // Generate the DPoP token
  const publicKey = await exportJWK(keyPair.publicKey);
  const dpopToken = await generateDPoPToken(
    keyPair.privateKey,
    publicKey,
    method,
    url,
    dpopNonce || undefined
  );
  
  // Set headers
  const headers: HeadersInit = {
    'Authorization': `DPoP ${accessToken}`,
    'DPoP': dpopToken,
    'Content-Type': 'application/json'
  };

  const requestOptions: RequestInit = {
    method,
    headers
  };

  if (body) {
    requestOptions.body = JSON.stringify(body);
  }

  // Make the request
  const response = await fetch(url, requestOptions);
  
  // Handle DPoP nonce errors or other 401 errors
  if (response.status === 401) {
    // Try to parse error response
    let responseBody;
    try {
      responseBody = await response.json();
    } catch (e) {
      responseBody = {};
    }
    
    // Check if this is a nonce error
    if (
      responseBody.error === 'use_dpop_nonce' || 
      (responseBody.error_description && responseBody.error_description.includes('nonce'))
    ) {
      // Get new nonce from header
      const newDpopNonce = response.headers.get('DPoP-Nonce');
      if (newDpopNonce) {
        console.log('Retrying API request with nonce:', newDpopNonce);
        return makeAuthenticatedRequest(endpoint, method, accessToken, keyPair, newDpopNonce, body);
      }
    }
    
    // Other 401 error, possibly expired token
    throw new Error(`API request unauthorized: ${JSON.stringify(responseBody)}`);
  }

  // Handle other errors
  if (!response.ok) {
    let errorText;
    try {
      const errorJson = await response.json();
      errorText = JSON.stringify(errorJson);
    } catch {
      errorText = await response.text();
    }
    throw new Error(`API request failed: ${response.status}, ${errorText}`);
  }

  // Parse JSON response if present
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    return null;
  }

  const result = await response.json();
  
  // Save any nonce for future requests
  const returnNonce = response.headers.get('DPoP-Nonce');
  if (returnNonce && returnNonce !== dpopNonce) {
    // If there's a place to store it, we would store it here
    console.log('New DPoP nonce received:', returnNonce);
  }
  
  return result;
}

// Get the user profile
export async function getProfile(
  accessToken: string,
  keyPair: CryptoKeyPair,
  dpopNonce: string | null = null
): Promise<any> {
  try {
    console.log('Getting profile via proxy API');
    
    // Generate a DPoP token for the profile request
    const publicKey = await exportJWK(keyPair.publicKey);
    const endpoint = 'https://bsky.social/xrpc/com.atproto.identity.resolveHandle';
    const dpopToken = await generateDPoPToken(
      keyPair.privateKey, 
      publicKey, 
      'GET', 
      endpoint, 
      dpopNonce || undefined
    );
    
    // Make the request via our proxy API
    const response = await fetch('/api/bluesky/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accessToken,
        dpopToken
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Profile fetch error:', errorData);
      throw new Error(`Profile fetch failed: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error resolving handle:', error);
    // If we fail to get the profile, return a basic object to avoid breaking the flow
    // The user can still use the app and we'll use the DID as the identifier
    return { handle: 'unknown' };
  }
}

// Create a flushing status record
export async function createFlushingStatus(
  accessToken: string,
  keyPair: CryptoKeyPair,
  did: string,
  text: string,
  emoji: string,
  dpopNonce: string | null = null
): Promise<any> {
  console.log('Creating flushing status with nonce:', dpopNonce);
  
  try {
    // Generate a DPoP token for the create request
    const publicKey = await exportJWK(keyPair.publicKey);
    const endpoint = 'https://bsky.social/xrpc/com.atproto.repo.createRecord';
    const dpopToken = await generateDPoPToken(
      keyPair.privateKey, 
      publicKey, 
      'POST', 
      endpoint, 
      dpopNonce || undefined
    );
    
    // Make the request via our proxy API
    const response = await fetch('/api/bluesky/flushing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        accessToken,
        dpopToken,
        did,
        text,
        emoji
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Status creation error:', errorData);
      throw new Error(`Status creation failed: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error creating flushing status:', error);
    throw error;
  }
}