#!/usr/bin/env python3
"""WSL 포트 중계 — Windows 브라우저가 WSL 안의 Penpot MCP 서버에 닿게 한다.

사용: python3 wsl_relay.py <받을 포트> <넘길 포트>
왜: Windows 가 4307~4406 을 예약 포트로 잡고 있어 4400·4402 를 그대로 못 넘긴다.
그래서 14400·14412 같은 다른 포트에서 받아 WSL 안쪽 포트로 넘긴다.
0.0.0.0(IPv4)에 붙여야 Windows localhost 로 넘어간다 — IPv6 바인딩은 안 넘어간다.
"""
import socket
import sys
import threading


def pipe(src, dst):
    # 한쪽에서 읽은 바이트를 다른 쪽에 그대로 쓴다. 끊기면 양쪽을 닫는다
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.close()
            except OSError:
                pass


def main():
    listen_port, target_port = int(sys.argv[1]), int(sys.argv[2])
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', listen_port))
    server.listen(64)
    print(f'relay {listen_port} -> {target_port}', flush=True)
    while True:
        client, peer = server.accept()
        print(f'conn from {peer}', flush=True)
        try:
            upstream = socket.create_connection(('127.0.0.1', target_port))
        except OSError as e:
            print(f'upstream fail: {e}', flush=True)
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


if __name__ == '__main__':
    main()
