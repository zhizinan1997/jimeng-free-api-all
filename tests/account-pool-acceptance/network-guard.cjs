// Loaded before application code, including restart/concurrency children.
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.env.ACCEPTANCE_ROOT || '/nonexistent-acceptance-root');
const target = path.resolve(process.env.DB_PATH || '');
if (!root.includes('jimeng-pool-acceptance-') || !target.startsWith(root + path.sep)) {
  throw new Error('Acceptance refuses DB_PATH outside its newly created temporary root');
}
const denied = () => { throw new Error('ACCEPTANCE_NETWORK_BLOCKED'); };
require('node:net').Socket.prototype.connect = denied;
require('node:tls').connect = denied;
require('node:http').request = denied;
require('node:http').get = denied;
require('node:https').request = denied;
require('node:https').get = denied;
require('node:dns').lookup = denied;
globalThis.fetch = denied;
globalThis.WebSocket = class { constructor() { denied(); } };
