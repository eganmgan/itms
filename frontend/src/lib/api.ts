export async function readJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || ''

  if (!contentType.toLowerCase().includes('application/json')) {
    if (response.status === 429) throw new Error('Too many requests. Please wait a moment and try again.')
    if (response.status === 502 || response.status === 503 || response.status === 504) throw new Error('The API service is temporarily unavailable.')
    throw new Error(`The API returned an invalid response (HTTP ${response.status}).`)
  }

  return response.json() as Promise<T>
}