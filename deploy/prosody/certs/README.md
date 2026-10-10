# Prosody certificates

Other XMPP servers only federate over TLS with a valid certificate for your chat domain.
Put the certificate and key for `CHAT_DOMAIN` here, named after the domain:

    example.com.crt   (full chain)
    example.com.key

They must be readable by the container (e.g. `chmod 644`), then `docker compose restart prosody`.
Any ACME client works (certbot, acme.sh, your reverse proxy's certificates).

Without a certificate, chat between users on this server still works; only federation fails.
