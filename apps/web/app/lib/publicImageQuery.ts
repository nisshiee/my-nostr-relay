/** 観測済みの公開画像変換queryだけを許可する。認証・署名付きURLは対象外。 */
export function hasAllowedPublicImageQuery(url: URL): boolean {
  if (!url.search) return true;
  if (url.hostname === 'baseec-img-mng.akamaized.net' && /^\/images\/item\/origin\/[a-f0-9]{32}\.(?:png|jpg|jpeg|webp)$/.test(url.pathname)) {
    // Observed public BASE resize only; do not allow arbitrary Akamai im DSL.
    return [...url.searchParams].length === 3 && url.searchParams.getAll('imformat').length === 1 &&
      url.searchParams.get('imformat') === 'generic' && url.searchParams.getAll('q').length === 1 &&
      url.searchParams.get('q') === '90' && url.searchParams.getAll('im').length === 1 &&
      url.searchParams.get('im') === 'Resize,width=1200,type=normal';
  }
  if (url.hostname === 'pbs.twimg.com' && /^(?:\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp))?|\/amplify_video_thumb\/[0-9]{1,24}\/img\/[A-Za-z0-9_-]+)$/.test(url.pathname)) {
    const entries = [...url.searchParams.entries()];
    return entries.length === 2 && url.searchParams.getAll('format').length === 1 && url.searchParams.get('format') === 'webp' &&
      url.searchParams.getAll('name').length === 1 && url.searchParams.get('name') === 'large';
  }
  if (!['0.gravatar.com', '2.gravatar.com'].includes(url.hostname) || !/^\/avatar\/(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(url.pathname)) return false;
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key]) => key !== 'size' && key !== 'd') || url.searchParams.getAll('size').length !== 1) return false;
  // d can also be an arbitrary URL in Gravatar; only the observed builtin is allowed.
  if (url.searchParams.has('d') && (url.searchParams.getAll('d').length !== 1 || url.searchParams.get('d') !== 'initials')) return false;
  const value = url.searchParams.get('size')!;
  return /^[1-9][0-9]{0,3}$/.test(value) && Number(value) <= 2048;
}
