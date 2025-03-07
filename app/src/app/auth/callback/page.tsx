'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAccessToken } from '@/lib/bluesky-auth';
import { getProfile } from '@/lib/bluesky-api';
import { useAuth } from '@/lib/auth-context';
import styles from './callback.module.css';

// Loading component to show while waiting
function CallbackLoader() {
  return (
    <div className={styles.container}>
      <div className={styles.loaderContainer}>
        <div className={styles.loader}></div>
        <p>Processing login...</p>
      </div>
    </div>
  );
}

// Main callback handler component
function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Processing login...');
  const [isClient, setIsClient] = useState(false);

  // Set isClient to true once component mounts
  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    // Only proceed if we're on the client side
    if (!isClient) return;

    async function handleCallback() {
      try {
        // Get parameters from URL
        const code = searchParams.get('code');
        const state = searchParams.get('state');
        const iss = searchParams.get('iss');
        
        if (!code || !state || !iss) {
          setError('Invalid callback parameters');
          return;
        }

        // Get stored values from session storage
        if (typeof window === 'undefined' || !window.sessionStorage) {
          setError('Browser storage not available');
          return;
        }

        const storedState = sessionStorage.getItem('oauth_state');
        const codeVerifier = sessionStorage.getItem('code_verifier');
        const serializedKeyPair = sessionStorage.getItem('key_pair');

        // Validate state
        if (state !== storedState) {
          setError('Invalid state parameter');
          return;
        }

        if (!codeVerifier || !serializedKeyPair) {
          setError('Missing authorization data');
          return;
        }

        setStatus('Exchanging authorization code...');

        // Check if crypto is available
        if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
          setError('Web Crypto API not available');
          return;
        }

        // Deserialize key pair
        const keyPairData = JSON.parse(serializedKeyPair);
        const publicKey = await window.crypto.subtle.importKey(
          'jwk',
          keyPairData.publicKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        );
        const privateKey = await window.crypto.subtle.importKey(
          'jwk',
          keyPairData.privateKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign']
        );
        const keyPair = { publicKey, privateKey };

        // Exchange code for tokens - we may need several attempts
        setStatus('Getting access token...');
        console.log('Exchanging code for token...');
        let tokenResponse;
        try {
          tokenResponse = await getAccessToken(code, codeVerifier, keyPair);
        } catch (tokenError: any) {
          console.error('Token exchange error:', tokenError);
          setError(`Failed to get access token: ${tokenError.message}`);
          return;
        }
        
        if (!tokenResponse.access_token || !tokenResponse.refresh_token) {
          setError('Token response missing required fields');
          return;
        }

        // Save the DPoP nonce from the response headers if present
        let dpopNonce = null;
        if (tokenResponse.dpop_nonce) {
          dpopNonce = tokenResponse.dpop_nonce;
        }

        setStatus('Getting user profile...');

        // Get user profile
        let profileResponse;
        try {
          // Extract the PDS endpoint from the token audience
          let pdsEndpoint = null;
          if (tokenResponse.aud && typeof tokenResponse.aud === 'string') {
            if (tokenResponse.aud.startsWith('did:web:')) {
              // Convert did:web:example.com to https://example.com
              pdsEndpoint = 'https://' + tokenResponse.aud.replace('did:web:', '');
              console.log('Extracted PDS endpoint from token:', pdsEndpoint);
            }
          }
          
          profileResponse = await getProfile(
            tokenResponse.access_token,
            keyPair,
            dpopNonce,
            undefined, // Use default handle
            pdsEndpoint // Pass the PDS endpoint
          );
        } catch (profileError: any) {
          console.error('Profile fetch error:', profileError);
          // Continue anyway - we at least have the tokens
          profileResponse = { handle: 'unknown_user' };
        }

        // Serialize key pair for storage
        const serializedKeysForStorage = JSON.stringify({
          publicKey: keyPairData.publicKey,
          privateKey: keyPairData.privateKey
        });

        // Extract the DID from the token response
        console.log('Token response:', tokenResponse);
        const userDid = tokenResponse.sub;
        console.log('User DID from token:', userDid);
        
        // Try to resolve the user's own handle using the DID
        let userHandle = profileResponse?.handle || 'unknown';
        
        // Log the PDS endpoint that will be used
        console.log('Using PDS endpoint for API requests:', pdsEndpoint);
        
        // Make sure pdsEndpoint is accessible here for setAuth function
        const extractedPdsEndpoint = pdsEndpoint;
        
        // Store auth data
        setAuth({
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          did: userDid,
          handle: userHandle,
          serializedKeyPair: serializedKeysForStorage,
          dpopNonce: dpopNonce,
          pdsEndpoint: extractedPdsEndpoint // Store the PDS endpoint for later use
        });

        // Clear session storage
        sessionStorage.removeItem('oauth_state');
        sessionStorage.removeItem('code_verifier');
        sessionStorage.removeItem('key_pair');

        // Redirect to dashboard
        router.push('/dashboard');
      } catch (err: any) {
        console.error('Login callback error:', err);
        setError(`Login failed: ${err.message || 'Unknown error'}`);
      }
    }

    handleCallback();
  }, [searchParams, router, setAuth, isClient]);

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.errorContainer}>
          <h1>Authentication Error</h1>
          <p className={styles.error}>{error}</p>
          <button onClick={() => router.push('/')} className={styles.button}>
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.loaderContainer}>
        <div className={styles.loader}></div>
        <p>{status}</p>
      </div>
    </div>
  );
}

// Main export with Suspense boundary
export default function CallbackPage() {
  return (
    <Suspense fallback={<CallbackLoader />}>
      <CallbackHandler />
    </Suspense>
  );
}