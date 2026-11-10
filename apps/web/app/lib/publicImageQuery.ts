/** 観測済みの公開画像変換queryだけを許可する。認証・署名付きURLは対象外。 */
export function hasAllowedPublicImageQuery(url: URL): boolean {
  if (!url.search) return true;
  if (url.hostname === 'pbs.twimg.com' && /^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp))?$/.test(url.pathname)) {
    const entries = [...url.searchParams.entries()];
    return entries.length === 2 && url.searchParams.getAll('format').length === 1 && url.searchParams.get('format') === 'webp' &&
      url.searchParams.getAll('name').length === 1 && url.searchParams.get('name') === 'large';
  }
  if (url.hostname !== '0.gravatar.com' || !/^\/avatar\/(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(url.pathname)) return false;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'size') return false;
  const value = entries[0][1];
  return /^[1-9][0-9]{0,3}$/.test(value) && Number(value) <= 2048;
}
