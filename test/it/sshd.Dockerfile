# The "remote box" for test/it-self-hosted.test.mjs: sshd plus the docker CLI, talking to this computer's Docker through
# the mounted socket, so worker containers are siblings on the local Docker. Root logs in with the throwaway key only.
FROM alpine:3.20
RUN apk add --no-cache openssh-server docker-cli \
 && ssh-keygen -A \
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow \
 && printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n' >> /etc/ssh/sshd_config \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh
CMD ["sh", "-c", "printf '%s\\n' \"$AUTHORIZED_KEY\" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
