FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends dovecot-imapd openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 synthetic && mkdir -p /home/synthetic/Maildir && chown synthetic:synthetic /home/synthetic/Maildir
RUN openssl req -x509 -newkey rsa:2048 -nodes -days 7 -keyout /etc/dovecot/test.key -out /etc/dovecot/test.pem -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' && chmod 600 /etc/dovecot/test.key
COPY dovecot.conf /etc/dovecot/dovecot.conf
EXPOSE 993
CMD ["dovecot", "-F"]
