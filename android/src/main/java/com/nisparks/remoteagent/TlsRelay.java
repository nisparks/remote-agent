package com.nisparks.remoteagent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Loopback relay that carries WebView traffic over the app's own TLS connections.
 *
 * <p>The WebView speaks plain HTTP to 127.0.0.1; every connection is forwarded byte-for-byte over a
 * certificate- and hostname-verified TLS connection made with the platform TLS stack, the same stack
 * the endpoint probe uses. Some networks let that stack through while breaking the WebView's own
 * connections. Requests still carry the pairing token, so the relay grants no access by itself.
 * Requests keep the WebView's Host header (127.0.0.1:port); the bridge server doesn't route by Host.
 */
final class TlsRelay {
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int HANDSHAKE_TIMEOUT_MS = 15000;
    private static final int DRAIN_TIMEOUT_MS = 2000;
    private static final int BUFFER_SIZE = 16 * 1024;

    private final String upstreamHost;
    private final int upstreamPort;
    private final HostnameVerifier hostnameVerifier;
    private final ServerSocket server;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final Set<Socket> openSockets = Collections.newSetFromMap(new ConcurrentHashMap<Socket, Boolean>());
    private volatile boolean closed = false;
    private volatile String lastError = "";

    private TlsRelay(String upstreamHost, int upstreamPort, HostnameVerifier hostnameVerifier, ServerSocket server) {
        this.upstreamHost = upstreamHost;
        this.upstreamPort = upstreamPort;
        this.hostnameVerifier = hostnameVerifier;
        this.server = server;
    }

    /**
     * Listens on 127.0.0.1:preferredPort (any free port if that one is taken) and relays to
     * upstreamHost:upstreamPort over TLS. A fixed port keeps the WebView origin, and its storage, stable.
     * hostnameVerifier may be null where endpoint identification alone is trusted (desktop JVM tests).
     */
    static TlsRelay start(String upstreamHost, int upstreamPort, int preferredPort, HostnameVerifier hostnameVerifier)
            throws IOException {
        final TlsRelay relay = new TlsRelay(upstreamHost, upstreamPort, hostnameVerifier, bindLoopback(preferredPort));
        relay.workers.execute(new Runnable() {
            @Override
            public void run() {
                relay.acceptLoop();
            }
        });
        return relay;
    }

    private static ServerSocket bindLoopback(int preferredPort) throws IOException {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        if (preferredPort > 0) {
            ServerSocket preferred = new ServerSocket();
            try {
                preferred.setReuseAddress(true);
                preferred.bind(new InetSocketAddress(loopback, preferredPort), 64);
                return preferred;
            } catch (IOException e) {
                preferred.close();
            }
        }
        ServerSocket any = new ServerSocket();
        any.bind(new InetSocketAddress(loopback, 0), 64);
        return any;
    }

    String localBase() {
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    boolean forwardsTo(String host, int port) {
        return !closed && upstreamHost.equalsIgnoreCase(host) && upstreamPort == port;
    }

    boolean isOpen() {
        return !closed;
    }

    /** Why the most recent upstream connection failed; empty once one succeeds. */
    String lastError() {
        return lastError;
    }

    void close() {
        closed = true;
        closeQuietly(server);
        for (Socket socket : openSockets) {
            closeQuietly(socket);
        }
        openSockets.clear();
        workers.shutdownNow();
    }

    private void acceptLoop() {
        while (!closed) {
            final Socket client;
            try {
                client = server.accept();
            } catch (IOException e) {
                if (closed) return;
                lastError = "relay listener failed: " + describe(e);
                try {
                    Thread.sleep(250);
                } catch (InterruptedException interrupted) {
                    return;
                }
                continue;
            }
            openSockets.add(client);
            try {
                workers.execute(new Runnable() {
                    @Override
                    public void run() {
                        serve(client);
                    }
                });
            } catch (RejectedExecutionException e) {
                release(client);
                return;
            }
        }
    }

    private void serve(final Socket client) {
        final SSLSocket upstream;
        try {
            client.setTcpNoDelay(true);
            upstream = openUpstream();
        } catch (IOException e) {
            lastError = describe(e);
            replyBadGateway(client, lastError);
            return;
        }
        openSockets.add(upstream);
        if (closed) {
            release(client, upstream);
            return;
        }
        lastError = "";
        try {
            workers.execute(new Runnable() {
                @Override
                public void run() {
                    pumpUpstreamToClient(upstream, client);
                }
            });
        } catch (RejectedExecutionException e) {
            release(client, upstream);
            return;
        }
        pumpClientToUpstream(client, upstream);
    }

    private void pumpClientToUpstream(Socket client, SSLSocket upstream) {
        try {
            copy(client.getInputStream(), upstream.getOutputStream());
        } catch (IOException ignored) {
            // Either side closed; cleanup below.
        } finally {
            // TLS can't half-close, and the WebView only stops sending once it is done with the connection.
            release(client, upstream);
        }
    }

    private void pumpUpstreamToClient(SSLSocket upstream, Socket client) {
        try {
            copy(upstream.getInputStream(), client.getOutputStream());
            // Server finished: end the WebView's stream after everything sent so far. The other pump
            // releases both sockets once the WebView closes its side.
            client.shutdownOutput();
        } catch (IOException e) {
            release(client, upstream);
        }
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE];
        int n;
        while ((n = in.read(buffer)) != -1) {
            out.write(buffer, 0, n);
            out.flush();
        }
    }

    private SSLSocket openUpstream() throws IOException {
        Socket transport = openTransport();
        try {
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket tls = (SSLSocket) factory.createSocket(transport, upstreamHost, upstreamPort, true);
            SSLParameters params = tls.getSSLParameters();
            params.setEndpointIdentificationAlgorithm("HTTPS");
            tls.setSSLParameters(params);
            tls.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            tls.startHandshake();
            if (hostnameVerifier != null && !hostnameVerifier.verify(upstreamHost, tls.getSession())) {
                throw new SSLPeerUnverifiedException("certificate does not match " + upstreamHost);
            }
            tls.setSoTimeout(0);
            return tls;
        } catch (IOException e) {
            closeQuietly(transport);
            throw e;
        }
    }

    /** Opens TCP to the upstream, honoring the system proxy the same way HttpURLConnection does. */
    private Socket openTransport() throws IOException {
        Proxy proxy = Proxy.NO_PROXY;
        try {
            ProxySelector selector = ProxySelector.getDefault();
            if (selector != null) {
                List<Proxy> proxies = selector.select(new URI("https", null, upstreamHost, upstreamPort, "/", null, null));
                if (proxies != null && !proxies.isEmpty() && proxies.get(0) != null) {
                    proxy = proxies.get(0);
                }
            }
        } catch (Exception ignored) {
            // No usable proxy configuration: connect directly.
        }
        if (proxy.type() == Proxy.Type.HTTP && proxy.address() instanceof InetSocketAddress) {
            return openHttpTunnel((InetSocketAddress) proxy.address());
        }
        if (proxy.type() == Proxy.Type.SOCKS) {
            Socket socket = new Socket(proxy);
            try {
                configure(socket);
                socket.connect(InetSocketAddress.createUnresolved(upstreamHost, upstreamPort), CONNECT_TIMEOUT_MS);
                return socket;
            } catch (IOException e) {
                closeQuietly(socket);
                throw e;
            }
        }
        IOException lastFailure = null;
        for (InetAddress address : InetAddress.getAllByName(upstreamHost)) {
            Socket socket = new Socket();
            try {
                configure(socket);
                socket.connect(new InetSocketAddress(address, upstreamPort), CONNECT_TIMEOUT_MS);
                return socket;
            } catch (IOException e) {
                closeQuietly(socket);
                lastFailure = e;
            }
        }
        throw lastFailure != null ? lastFailure : new IOException("no addresses for " + upstreamHost);
    }

    private Socket openHttpTunnel(InetSocketAddress proxyAddress) throws IOException {
        Socket socket = new Socket();
        try {
            configure(socket);
            InetSocketAddress target = proxyAddress.isUnresolved()
                    ? new InetSocketAddress(proxyAddress.getHostString(), proxyAddress.getPort())
                    : proxyAddress;
            socket.connect(target, CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            String authority = upstreamHost + ":" + upstreamPort;
            OutputStream out = socket.getOutputStream();
            out.write(("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority
                    + "\r\nProxy-Connection: Keep-Alive\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            String statusLine = readResponseHead(socket.getInputStream());
            String[] parts = statusLine.split(" ");
            if (parts.length < 2 || !"200".equals(parts[1])) {
                throw new IOException("proxy refused the tunnel: " + statusLine);
            }
            socket.setSoTimeout(0);
            return socket;
        } catch (IOException e) {
            closeQuietly(socket);
            throw e;
        }
    }

    /** Reads a proxy response head byte by byte (so no tunneled bytes are consumed) and returns its status line. */
    private static String readResponseHead(InputStream in) throws IOException {
        StringBuilder head = new StringBuilder();
        while (head.length() < 16384) {
            int b = in.read();
            if (b == -1) throw new IOException("proxy closed the connection");
            head.append((char) b);
            int len = head.length();
            if (len >= 4 && head.charAt(len - 4) == '\r' && head.charAt(len - 3) == '\n'
                    && head.charAt(len - 2) == '\r' && head.charAt(len - 1) == '\n') {
                int lineEnd = head.indexOf("\r\n");
                return head.substring(0, lineEnd);
            }
        }
        throw new IOException("proxy response head too large");
    }

    private static void configure(Socket socket) throws IOException {
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);
    }

    private void replyBadGateway(Socket client, String reason) {
        try {
            byte[] body = ("Remote Agent could not reach " + upstreamHost + ":" + upstreamPort + " - " + reason + "\n")
                    .getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 502 Bad Gateway\r\n"
                    + "Content-Type: text/plain; charset=utf-8\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = client.getOutputStream();
            out.write(head.getBytes(StandardCharsets.ISO_8859_1));
            out.write(body);
            out.flush();
            client.shutdownOutput();
            // Read what the WebView already sent so closing doesn't reset the connection before it reads the reply.
            client.setSoTimeout(DRAIN_TIMEOUT_MS);
            InputStream in = client.getInputStream();
            byte[] sink = new byte[4096];
            while (in.read(sink) != -1) {
                // discard
            }
        } catch (IOException ignored) {
            // Best effort: the WebView reports a network error instead.
        } finally {
            release(client);
        }
    }

    private void release(Socket... sockets) {
        for (Socket socket : sockets) {
            openSockets.remove(socket);
            closeQuietly(socket);
        }
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // Already closed
        }
    }

    private static String describe(Exception e) {
        String message = e.getMessage();
        String text = e.getClass().getSimpleName() + (message != null && !message.isEmpty() ? ": " + message : "");
        return text.length() > 160 ? text.substring(0, 160) + "…" : text;
    }
}
