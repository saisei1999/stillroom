import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestWatchmode } from '../src/AvailabilityPanel';
import { accountClient } from '../src/AccountPanel';
beforeEach(() => { vi.spyOn(accountClient.auth, 'getSession').mockResolvedValue({ data: { session: { access_token:'test-token', user:{id:'test-user'} } }, error:null } as any); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Watchmode client contract', () => {
  it('accepts only candidates for the requested confirmed ID and region', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({source:'Watchmode', mediaType:'tv', externalId:'37680', region:'US', candidates:[{sourceId:1,name:'Netflix',region:'US',offerType:'sub',titleUrl:'https://www.netflix.com/title/123'}]})));
    expect((await requestWatchmode('Suits','tv','US','37680')).candidates).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({Authorization:'Bearer test-token'});
    await expect(requestWatchmode('Suits','tv','GB','37680')).rejects.toThrow();
  });
  it('deduplicates in-flight requests and separates media IDs and regions', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return Response.json({ source:'Watchmode', mediaType:url.searchParams.get('type'), externalId:url.searchParams.get('id'), region:url.searchParams.get('region'), candidates:[] });
    });
    vi.stubGlobal('fetch', fetcher);
    await Promise.all([requestWatchmode('Example','tv','US','9991'), requestWatchmode('Example','tv','US','9991')]);
    await requestWatchmode('Renamed','tv','US','9991');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await requestWatchmode('Example','tv','GB','9991');
    await requestWatchmode('Example','tv','US','9992');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not cache failed lookups', async () => {
    const fetcher = vi.fn(async () => new Response('', {status:503}));
    vi.stubGlobal('fetch', fetcher);
    await expect(requestWatchmode('Example','movie','US','9993')).rejects.toThrow();
    await expect(requestWatchmode('Example','movie','US','9993')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not cache a partial response when identity lookup can be retried', async () => {
    const fetcher = vi.fn(async () => Response.json({source:'Watchmode', mediaType:'tv', externalId:'9001', region:'US', candidates:[], retryable:true}));
    vi.stubGlobal('fetch', fetcher);
    await requestWatchmode('Example','tv','US','9001');
    await requestWatchmode('Example','tv','US','9001');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not use cached results or call the server after sign-out', async () => {
    vi.spyOn(accountClient.auth, 'getSession').mockResolvedValue({data:{session:null},error:null});
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(requestWatchmode('Example','tv','US','9991')).rejects.toThrow('Sign in required');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects the old service response and does not treat it as direct links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({source:'JustWatch',links:[]})));
    await expect(requestWatchmode('Suits','tv','US','37681')).rejects.toThrow();
  });
});
