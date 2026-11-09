"""Integration checks against an isolated local server; never contacts Jimeng."""
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

with tempfile.TemporaryDirectory(prefix='jimeng-http-test-') as folder:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    database = str(Path(folder) / 'test.db')
    env = {**os.environ, 'DB_PATH': database, 'SERVER_PORT': str(port),
           'SERVER_HOST': '127.0.0.1', 'JIMENG_ACCOUNT_POOL_KEY': secrets.token_hex(32)}
    log = open(Path(folder) / 'server.log', 'w')
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(path, data=None, key=None, opener=client):
        headers = {'Content-Type': 'application/json'}
        if key:
            headers['Authorization'] = 'Bearer ' + key
        req = urllib.request.Request(base + path, headers=headers,
                                     data=json.dumps(data).encode() if data is not None else None)
        try:
            res = opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            res = error
        with res:
            body = res.read().decode()
            try:
                body = json.loads(body)
            except ValueError:
                pass
            return res.status, body

    def start():
        process = subprocess.Popen(['node', 'dist/index.js'], env=env, stdout=log, stderr=log)
        for _ in range(100):
            try:
                if call('/dashboard/status')[0] == 200:
                    return process
            except OSError:
                pass
            if process.poll() is not None:
                raise RuntimeError('test server failed to start')
            time.sleep(0.05)
        process.terminate()
        raise RuntimeError('test server startup timed out')

    process = start()
    try:
        assert call('/dashboard/usage', opener=urllib.request.build_opener())[0] == 401
        account = {'username': 'test-admin', 'password': secrets.token_urlsafe(20)}
        assert call('/dashboard/setup', account)[1]['success']
        assert call('/dashboard/login', account)[1]['success']
        a = call('/dashboard/keys', {'name': 'caller A'})[1]
        b = call('/dashboard/keys', {'name': 'caller B'})[1]
        # Empty account pool causes a local failure before any upstream HTTP request.
        for path, payload in [('/v1/images/generations', {'prompt': 'test'}),
                              ('/v1/videos/generations', {'prompt': 'test'}),
                              ('/v1/chat/completions', {'messages': [{'role': 'user', 'content': 'test'}], 'stream': True})]:
            call(path, payload, a['key'])
        call('/v1/images/generations', {}, b['key'])  # validation failure
        usage = call('/dashboard/usage')[1]
        assert usage['totals']['requests'] == 4
        assert usage['totals']['failed'] == 4
        assert usage['totals']['estimated_credits'] is None
        assert usage['totals']['unknown_credits'] == 4
        assert call('/dashboard/usage?key_id=' + str(a['apiKey']['id']))[1]['totals']['requests'] == 3
        assert call('/dashboard/usage?days=7&key_id=' + str(b['apiKey']['id']))[1]['totals']['requests'] == 1
        assert call('/dashboard/usage?days=-1')[0] == 400
        assert call('/dashboard/usage?key_id=oops')[0] == 400
        assert call('/usage.css')[0] == 200
        assert 'du-table' in call('/usage.css')[1]
        assert a['key'] not in json.dumps(usage)
        assert b['key'] not in json.dumps(usage)
        # Simulate a process ending while a request was still running.
        process.terminate()
        process.wait(timeout=10)
        with sqlite3.connect(database) as sql:
            sql.execute("INSERT INTO usage_requests (id,api_key_id,key_name,key_preview,endpoint,model,started_at) VALUES (?,?,?,?,?,?,?)",
                        ('restart-case', a['apiKey']['id'], 'caller A', a['apiKey']['key_preview'], '/v1/videos/generations', 'video', '2026-11-08T00:00:00.000Z'))
        process = start()
        usage = call('/dashboard/usage')[1]
        assert usage['totals']['requests'] == 5
        assert usage['totals']['interrupted'] == 1
        assert usage['totals']['running'] == 0
        print('PASS: HTTP authentication, three generation routes, input errors, per-key/time filters, CSS, secret masking, persistence and interrupted-request recovery.')
    finally:
        process.terminate()
        process.wait(timeout=10)
        log.close()
