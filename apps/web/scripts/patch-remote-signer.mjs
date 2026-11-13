import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ORIGINAL_SHA256 = "834280c17b4ba20818c56be1c022f01114ce2eee4cc6cc4f5a4f322b4e1597d7";
const MARKER = "/* NLC window.nostr.js 0.8.1 connect lifecycle patch */";
export const originalConnect = 'async function gc(P=void 0){P=P||hr.fromBunker(I,N,pf),n(10,m=!0);let J=setTimeout(()=>{n(14,R=!0),n(50,L="opened")},5e3);try{await P.connect(),b=!0,Kn(),Date.now()%20===0&&await P.switchRelays(),localStorage.setItem(f.BUNKER_POINTER,JSON.stringify(N)),$(P),await tt()}catch(nt){q((nt==null?void 0:nt.message)||String(nt))}finally{clearTimeout(J),n(10,m=!1),n(14,R=!1),n(11,x=null),n(12,k=null),n(13,C=null),M&&!w&&yn()}}';

// Identifiers below are the verified names in this exact upstream release.
// Resolve the signer and public-key queue before optional relay maintenance.
// On failure, reject every queued caller and replace the rejected signer promise
// so a subsequent connection attempt can resolve it.
export const patchedConnect = `async function gc(P=void 0){
  const attempt=B;
  let failed=false;
  P=P||hr.fromBunker(I,N,pf);
  n(10,m=!0);
  let J=setTimeout(()=>{if(B===attempt){n(14,R=!0);n(50,L="opened")}},5000);
  try{
    await P.connect();
    if(B!==attempt) return;
    b=!0;
    Kn();
    localStorage.setItem(f.BUNKER_POINTER,JSON.stringify(N));
    $(P);
    await tt();
    if(B===attempt && Date.now()%20===0) void P.switchRelays().catch(()=>{});
  }catch(nt){
    if(B!==attempt) return;
    failed=true;
    const reason=(nt==null?void 0:nt.message)||String(nt);
    b=!1;
    void B.catch(()=>{});
    q(reason);
    K.forEach(reject=>reject(reason));
    K=[];
    Q=[];
  }finally{
    clearTimeout(J);
    if(B===attempt){
      n(10,m=!1);n(14,R=!1);n(11,x=null);n(12,k=null);n(13,C=null);
      if(failed){
        B=new Promise((resolve,reject)=>{$=resolve;q=reject});
        void B.catch(()=>{});
      }
      M&&!w&&yn();
    }
  }
}`;

const hash = value => createHash("sha256").update(value).digest("hex");

export function patchRemoteSigner(source) {
  // Verify the inverse too: a marker alone must never bypass integrity checks.
  if (source.includes(MARKER)) {
    const restored = source.replace(MARKER, "").replace(patchedConnect, originalConnect);
    if (hash(restored) !== ORIGINAL_SHA256) throw new Error("Unexpected patched window.nostr.js content");
    return source;
  }
  if (hash(source) !== ORIGINAL_SHA256 || source.split(originalConnect).length !== 2) {
    throw new Error("window.nostr.js differs from the audited 0.8.1 bundle; review the patch before installing");
  }
  return MARKER + source.replace(originalConnect, patchedConnect);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("window.nostr.js/package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  if (metadata.version !== "0.8.1") throw new Error("Review remote signer patch for the new version");
  const path = require.resolve("window.nostr.js");
  const source = readFileSync(path, "utf8");
  const patched = patchRemoteSigner(source);
  if (patched !== source) writeFileSync(path, patched);
}
