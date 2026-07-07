// Preloaded (via NODE_OPTIONS --import) into the Google Calendar MCP subprocess.
//
// Routes Node's global `fetch` — which google-auth-library/gaxios uses inside
// @cocal/google-calendar-mcp — through the OneCLI gateway proxy. Node 22's built-in
// fetch does NOT honor NODE_USE_ENV_PROXY (Node 24+ only), so the OAuth refresh would
// otherwise egress straight to Google carrying the `onecli-managed` stub client_id and
// fail with `invalid_client`. undici's setGlobalDispatcher writes the shared global
// symbol (Symbol.for('undici.globalDispatcher.1')) that Node's built-in fetch reads,
// so installing a ProxyAgent here redirects those requests through the gateway, which
// MITM-injects the real Google credentials. The gateway's MITM cert is trusted via
// NODE_EXTRA_CA_CERTS (honored by undici fetch). ProxyAgent auto-extracts any inline
// user:pass@ credentials in the proxy URL into a Proxy-Authorization header.
import { setGlobalDispatcher, ProxyAgent } from 'undici';

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl }));
}
