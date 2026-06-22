import { NextResponse } from 'next/server';

export function middleware(request) {
  const url = new URL(request.url);
  
  // Forward API calls and track asset requests to the backend URL from environment variables
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tracks/')) {
    const backendUrl = process.env.api_key;
    if (backendUrl) {
      // Rewrite the URL transparently to the Render backend
      const targetUrl = new URL(url.pathname + url.search, backendUrl);
      return NextResponse.rewrite(targetUrl);
    }
  }
}
