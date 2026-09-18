'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { handleAuthCallback } from '@/lib/mcpAuth';

function CallbackLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Loading...</h1>
      </div>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackLoading />}>
      <OAuthCallbackContent />
    </Suspense>
  );
}

function OAuthCallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const processCallback = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const errorParam = searchParams.get('error');
      const errorDescription = searchParams.get('error_description');

      // Handle error from authorization server
      if (errorParam) {
        setStatus('error');
        setError(errorDescription || errorParam);
        return;
      }

      // Validate required parameters
      if (!code || !state) {
        setStatus('error');
        setError('Missing authorization code or state parameter');
        return;
      }

      try {
        // Exchange code for tokens
        await handleAuthCallback(code, state);
        setStatus('success');

        // Redirect back to explorer after short delay
        setTimeout(() => {
          router.push('/explorer');
        }, 1500);
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to complete authentication');
      }
    };

    processCallback();
  }, [searchParams, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        {status === 'processing' && (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Completing Authentication
            </h1>
            <p className="text-gray-600">
              Please wait while we complete the OAuth flow...
            </p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Authentication Successful
            </h1>
            <p className="text-gray-600">
              Redirecting you back to the Explorer...
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="h-12 w-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Authentication Failed
            </h1>
            <p className="text-red-600 mb-4">
              {error}
            </p>
            <button
              onClick={() => router.push('/explorer')}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              Return to Explorer
            </button>
          </>
        )}
      </div>
    </div>
  );
}
