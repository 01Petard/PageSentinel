#!/bin/sh
set -eu

# Configure the container's network namespace before dropping to an unprivileged
# application user. Established API responses work; new private-network requests
# (including redirects, subresources and DNS rebinding) are blocked at the kernel.
iptables -N PAGESENTINEL_OUT
iptables -A OUTPUT -j PAGESENTINEL_OUT
iptables -A PAGESENTINEL_OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for resolver in $(awk '/^nameserver / {print $2}' /etc/resolv.conf); do
  case "$resolver" in
    *:*) ;;
    # Docker DNATs its resolver port before the filter table. Match the original
    # destination, rather than allowing all ports on its loopback address.
    *) iptables -A PAGESENTINEL_OUT -p udp -m conntrack --ctorigdst "$resolver" --ctorigdstport 53 -j ACCEPT
       iptables -A PAGESENTINEL_OUT -p tcp -m conntrack --ctorigdst "$resolver" --ctorigdstport 53 -j ACCEPT ;;
  esac
done
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A PAGESENTINEL_OUT -d "$cidr" -j REJECT
done
if [ -s /proc/net/if_inet6 ]; then
  ip6tables -N PAGESENTINEL_OUT
  ip6tables -A OUTPUT -j PAGESENTINEL_OUT
  ip6tables -A PAGESENTINEL_OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A PAGESENTINEL_OUT -j REJECT
fi
chown node:node "$DATA_DIR"
# Existing bind-mounted databases can retain a different host user ID.
for database_file in "$DATA_DIR"/pagesentinel.sqlite*; do
  if [ -f "$database_file" ]; then
    chown node:node "$database_file"
  fi
done
exec gosu node "$@"
