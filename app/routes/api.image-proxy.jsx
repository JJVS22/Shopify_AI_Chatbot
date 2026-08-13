export async function loader({ request }) {
  const url = new URL(request.url);
  const imageUrl = url.searchParams.get('url');

  if (!imageUrl) {
    return new Response('Missing url parameter', { status: 400 });
  }

  try {
    const fetchResponse = await fetch(imageUrl);

    if (!fetchResponse.ok) {
      return new Response('Failed to fetch image', { status: fetchResponse.status });
    }

    const contentType = fetchResponse.headers.get('content-type') || 'image/jpeg';
    const cacheControl = 'public, max-age=86400';

    return new Response(fetchResponse.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('[ImageProxy] Failed to proxy image:', imageUrl, error.message);
    return new Response('Image proxy error', { status: 502 });
  }
}
