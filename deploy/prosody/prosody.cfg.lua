-- Prosody configuration for HomeMail chat federation.
--
-- HomeMail connects to Prosody as an external component (XEP-0114) and answers for every
-- user@<chat domain> address. Prosody takes care of talking to other XMPP servers
-- (server-to-server connections, TLS, DNS). No user accounts live in Prosody itself.
--
-- Environment (set in docker-compose.yml):
--   HOMEMAIL_CHAT_DOMAIN       the chat domain, same as HomeMail's CHAT_DOMAIN / SERVER_DOMAIN
--   HOMEMAIL_COMPONENT_SECRET  shared secret, same as HomeMail's XMPP_COMPONENT_SECRET
--   PROSODY_S2S_SECURE_AUTH    "0" to accept servers without valid certificates (testing only)
--
-- For federation with the public XMPP network you need, for your chat domain:
--   * DNS:  _xmpp-server._tcp.<domain> SRV 0 5 5269 <host>.  (or an A record on <domain>)
--   * port 5269 reachable from the internet
--   * a TLS certificate in ./deploy/prosody/certs/<domain>.crt and <domain>.key

admins = {}
plugin_paths = {}

modules_enabled = {
	"disco";
	"tls";
	"dialback";
	"limits";
	"ping";
	"time";
	"uptime";
	"version";
}

-- HomeMail connects from another container.
component_interfaces = { "*" }
component_ports = { 5347 }

-- Nothing connects as a client; only servers and the HomeMail component.
c2s_ports = { }

s2s_secure_auth = ENV_PROSODY_S2S_SECURE_AUTH ~= "0"

limits = {
	s2sin = { rate = "30kb/s" };
}

storage = "internal"
certificates = "certs"
log = { info = "*console" }

-- Prosody refuses to start without at least one host. This one has no accounts and,
-- with client connections disabled above, nothing can log in to it.
VirtualHost "localhost"
	authentication = "anonymous"
	modules_disabled = { "register" }
	allow_registration = false

Component (ENV_HOMEMAIL_CHAT_DOMAIN or "home.mail")
	component_secret = ENV_HOMEMAIL_COMPONENT_SECRET

-- Extra configuration (e.g. for tests) can be mounted here.
Include "/etc/prosody/conf.d/*.cfg.lua"
