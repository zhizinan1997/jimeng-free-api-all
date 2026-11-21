// Loaded before application code inside the isolated server child process.
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(process.env.UI_INTEGRATION_ROOT || '/nonexistent-ui-integration-root');
const target = path.resolve(process.env.DB_PATH || '');
if (!root.includes('jimeng-pool-ui-int-') || !target.startsWith(root + path.sep)) {
  throw new Error(`Isolated UI integration refuses DB_PATH outside temp root: ${target}`);
}

const denied = () => {
  throw new Error('UI_INTEGRATION_OUTBOUND_NETWORK_BLOCKED');
};
const dns = require('node:dns');
const origLookup = dns.lookup.bind(dns);
require('node:net').Socket.prototype.connect = denied;
require('node:tls').connect = denied;
require('node:http').request = denied;
require('node:http').get = denied;
require('node:https').request = denied;
require('node:https').get = denied;
dns.lookup = (hostname, ...args) => {
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost') {
    return origLookup(hostname, ...args);
  }
  return denied();
};
globalThis.fetch = denied;
globalThis.WebSocket = class { constructor() { denied(); } };
