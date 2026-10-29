package com.nisparks.remoteagent;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;

import javax.net.ssl.HttpsURLConnection;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "RemoteAgentPrefs";
    private static final String KEY_LAN_URL = "lan_url";
    private static final String KEY_WAN_URL = "wan_url";
    private static final String KEY_TOKEN = "auth_token";
    private static final String KEY_LAST_GOOD_URL = "last_good_url";
    private static final String KEY_LAN_ALTS = "lan_alt_urls";
    private static final String KEY_HOSTS_JSON = "saved_hosts_json";
    private static final String KEY_KEEP_AWAKE = "keep_awake";
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;
    // Cellular TLS handshakes can be slow; LAN addresses either answer quickly or are unreachable.
    private static final int PROBE_TIMEOUT_HTTPS_MS = 6000;
    private static final int PROBE_TIMEOUT_HTTP_MS = 2500;
    private static final long PROBE_DEADLINE_MS = 9000;
    private static final long PREFERRED_ENDPOINT_WAIT_MS = 3500;
    private static final long[] RETRY_DELAYS_MS = {2000, 4000, 8000, 15000, 30000};
    private static final String LOCAL_PAGE_BASE = "http://localhost/";
    // Fixed loopback port for the TLS relay, so the relayed page keeps a single origin (and its storage).
    private static final int RELAY_PORT = 47321;
    // A direct remote page load that shows nothing for this long is retried through the relay.
    private static final long DIRECT_LOAD_TIMEOUT_MS = 15000;

    private FrameLayout root;
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService probeExecutor = Executors.newCachedThreadPool();
    private ConnectivityManager.NetworkCallback networkCallback;

    // Endpoint whose web app is currently loaded; null while a native status/settings page is shown.
    private String currentBase = null;
    private volatile String currentPageUrl = "";
    private String localPageKind = null;
    private boolean connectInFlight = false;
    private int retryAttempt = 0;
    private Runnable pendingRetry = null;
    private long lastSwitchCheckMs = 0;
    // Background probes can finish after onDestroy; their UI work must then be skipped.
    private volatile boolean destroyed = false;
    // Some networks pass the app's own TLS connections (used by probes) but break the WebView's. After a
    // direct page load fails on an endpoint the probe reached, the page is loaded through this relay.
    private volatile TlsRelay relay = null;
    private boolean preferRelay = false;
    private boolean currentPageRelayed = false;
    // Origin the current web app page was requested from (the relay or the endpoint itself).
    private String currentPageBase = null;
    private Runnable directLoadWatchdog = null;

    private static final class ProbeResult {
        final String base;
        final boolean ok;
        final String error;

        ProbeResult(String base, boolean ok, String error) {
            this.base = base;
            this.ok = ok;
            this.error = error;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.parseColor("#0B0F19"));
        window.setNavigationBarColor(Color.parseColor("#0B0F19"));

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        initDefaultsIfEmpty();
        handleDeepLink(getIntent());
        applyKeepAwake(prefs.getBoolean(KEY_KEEP_AWAKE, true));

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0F19"));
        setContentView(root);
        createWebView();
        registerNetworkCallback();
        connectBest(true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handleDeepLink(intent)) {
            connectBest(true);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView == null) return;
        if (currentBase != null) {
            // The web app reconnects its own WebSocket and refreshes data; reloading here would
            // drop in-progress state such as a photo chosen in the file picker.
            webView.evaluateJavascript("if(window.__onAppResume) window.__onAppResume();", null);
        } else if (!"settings".equals(localPageKind)) {
            connectBest(true);
        }
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        unregisterNetworkCallback();
        handler.removeCallbacksAndMessages(null);
        probeExecutor.shutdownNow();
        closeRelay();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** Runs work on the main thread unless the activity was destroyed in the meantime. */
    private void postUi(final Runnable work) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (destroyed || webView == null) return;
                work.run();
            }
        });
    }

    private boolean runInBackground(Runnable work) {
        if (destroyed) return false;
        try {
            probeExecutor.execute(work);
            return true;
        } catch (RejectedExecutionException e) {
            return false;
        }
    }

    private void initDefaultsIfEmpty() {
        String defaultLan = getString(R.string.default_lan_url);
        String defaultWan = getString(R.string.default_wan_url);
        String defaultToken = getString(R.string.default_token);

        SharedPreferences.Editor ed = prefs.edit();
        // A pre-paired APK refreshes stored endpoints/token so stale values from older installs are replaced.
        if (defaultLan != null && !defaultLan.isEmpty()) {
            // Builds embed every desktop LAN address (e.g. Wi-Fi and Ethernet) as a comma-separated list.
            String[] lans = defaultLan.split(",");
            ed.putString(KEY_LAN_URL, lans[0].trim());
            ed.putString(KEY_LAN_ALTS, joinPrivateLanUrls(lans, 1, lans[0]));
        }
        if (defaultWan != null && !defaultWan.isEmpty()) {
            ed.putString(KEY_WAN_URL, defaultWan);
        }
        if (defaultToken != null && !defaultToken.isEmpty()) {
            ed.putString(KEY_TOKEN, defaultToken);
        }
        ed.apply();
    }

    private boolean handleDeepLink(Intent intent) {
        if (intent == null) return false;
        return applyPairingUri(intent.getData());
    }

    private boolean applyPairingUri(Uri uri) {
        if (uri == null || !"remoteagent".equalsIgnoreCase(uri.getScheme())) return false;
        SharedPreferences.Editor ed = prefs.edit();
        String lan = uri.getQueryParameter("lan");
        String wan = uri.getQueryParameter("wan");
        String token = uri.getQueryParameter("token");
        if (lan != null && !lan.isEmpty()) ed.putString(KEY_LAN_URL, normalizeEndpointUrl(lan));
        if (wan != null && !wan.isEmpty()) ed.putString(KEY_WAN_URL, normalizeEndpointUrl(wan));
        if (token != null && !token.isEmpty()) ed.putString(KEY_TOKEN, token);
        ed.apply();
        return true;
    }

    private void applyKeepAwake(boolean keepAwake) {
        if (keepAwake) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private void createWebView() {
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

        webView.setBackgroundColor(Color.parseColor("#0B0F19"));
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                currentPageUrl = url != null ? url : "";
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Native status pages must not remain in back history behind the loaded app.
                if (localPageKind == null && url != null && !url.startsWith(LOCAL_PAGE_BASE)) {
                    view.clearHistory();
                }
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                if (url != null && !url.startsWith(LOCAL_PAGE_BASE)) {
                    cancelDirectLoadWatchdog();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                if ("remoteagent".equalsIgnoreCase(uri.getScheme())) {
                    applyPairingUri(uri);
                    connectBest(true);
                    return true;
                }
                String url = uri.toString();
                if (request.isForMainFrame() && !isTrustedUrl(url)) {
                    // Keep untrusted pages out of this WebView: it exposes the AndroidNative bridge.
                    openExternally(url);
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                if (request.getUrl() != null && request.getUrl().toString().startsWith(LOCAL_PAGE_BASE)) return;
                // Errors from a navigation that was already abandoned (e.g. ERR_ABORTED) are not new failures.
                if (currentBase == null || !isCurrentPageUrl(request.getUrl())) return;
                String reason = error != null && error.getDescription() != null
                        ? error.getDescription().toString()
                        : "Network error";
                onEndpointFailed(reason);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request == null || !request.isForMainFrame() || response == null) return;
                if (currentBase == null || !isCurrentPageUrl(request.getUrl())) return;
                if (response.getStatusCode() == 502 && currentPageRelayed) {
                    TlsRelay r = relay;
                    String detail = r != null && !r.lastError().isEmpty() ? r.lastError() : "connection failed";
                    onEndpointFailed("The app's secure connection couldn't reach your desktop: " + detail);
                } else if (response.getStatusCode() >= 500) {
                    onEndpointFailed("Desktop server error (HTTP " + response.getStatusCode() + ")");
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
                sslHandler.cancel();
                String sslUrl = error != null ? error.getUrl() : null;
                if (currentBase == null || (sslUrl != null && !isCurrentPageUrl(Uri.parse(sslUrl)))) return;
                onEndpointFailed("The remote URL's HTTPS certificate is invalid or expired");
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Android may kill the WebView renderer under memory pressure; rebuild instead of crashing.
                if (webView != null) {
                    root.removeView(webView);
                    webView.destroy();
                    webView = null;
                }
                currentBase = null;
                createWebView();
                connectBest(true);
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                result.confirm();
                return true;
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "application/pdf", "text/*"});
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(intent, "Attach Photo or File"), FILE_CHOOSER_RESULT_CODE);
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                openExternally(url);
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
    }

    private void openExternally(String url) {
        // Relay URLs only work inside this app; hand other apps the real endpoint address instead.
        TlsRelay r = relay;
        if (url != null && currentPageRelayed && currentBase != null && r != null && url.startsWith(r.localBase() + "/")) {
            url = currentBase + url.substring(r.localBase().length());
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    // --- Endpoint selection -------------------------------------------------------------

    /** Remote HTTPS first: it works on cellular and (via hairpin NAT) at home, so the page origin stays stable. */
    private List<String> candidateEndpoints() {
        LinkedHashSet<String> ordered = new LinkedHashSet<>();
        String wan = prefs.getString(KEY_WAN_URL, "");
        addCandidate(ordered, wan);
        addCandidate(ordered, backupWanUrl(wan));
        addCandidate(ordered, prefs.getString(KEY_LAN_URL, ""));
        String alts = prefs.getString(KEY_LAN_ALTS, "");
        if (alts != null) {
            for (String alt : alts.split(",")) addCandidate(ordered, alt);
        }
        addCandidate(ordered, prefs.getString(KEY_LAST_GOOD_URL, ""));
        return new ArrayList<>(ordered);
    }

    /** Optional second router forward to the same desktop on the next port (e.g. 4322 -> its Ethernet IP). */
    private String backupWanUrl(String wanUrl) {
        String clean = normalizeEndpointUrl(wanUrl);
        if (clean.isEmpty()) return "";
        try {
            Uri u = Uri.parse(clean);
            int port = u.getPort();
            if (u.getHost() == null || port <= 0 || port >= 65535) return "";
            return u.getScheme() + "://" + u.getHost() + ":" + (port + 1);
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean isPrivateLanUrl(String url) {
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost();
            return "http".equals(u.getScheme()) && host != null
                    && host.matches("^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.)[0-9.]+$");
        } catch (Exception e) {
            return false;
        }
    }

    /** Joins valid private-LAN URLs from parts[start..], skipping the primary LAN URL. */
    private String joinPrivateLanUrls(String[] parts, int start, String primary) {
        String primaryClean = normalizeEndpointUrl(primary);
        StringBuilder sb = new StringBuilder();
        for (int i = start; i < parts.length; i++) {
            String clean = normalizeEndpointUrl(parts[i]);
            if (clean.isEmpty() || clean.equals(primaryClean) || !isPrivateLanUrl(clean)) continue;
            if (sb.length() > 0) sb.append(",");
            sb.append(clean);
        }
        return sb.toString();
    }

    private void addCandidate(LinkedHashSet<String> set, String raw) {
        String clean = normalizeEndpointUrl(raw);
        if (!clean.isEmpty()) set.add(clean);
    }

    private void connectBest(boolean showSpinnerIfIdle) {
        if (destroyed || connectInFlight) return;
        cancelPendingRetry();
        final List<String> candidates = candidateEndpoints();
        if (candidates.isEmpty()) {
            showConnectionManagerHtml();
            return;
        }
        connectInFlight = true;
        if (currentBase == null && showSpinnerIfIdle) {
            showStatusPage("Connecting to your desktop…", "", 0);
        }
        boolean started = runInBackground(new Runnable() {
            @Override
            public void run() {
                final List<ProbeResult> results = probeInPreferenceOrder(candidates);
                postUi(new Runnable() {
                    @Override
                    public void run() {
                        connectInFlight = false;
                        for (ProbeResult r : results) {
                            if (r.ok) {
                                retryAttempt = 0;
                                loadBase(r.base);
                                return;
                            }
                        }
                        currentBase = null;
                        long delay = nextRetryDelay();
                        showStatusPage("Can't reach your desktop", summarize(results), delay);
                        scheduleRetry(delay);
                    }
                });
            }
        });
        if (!started) connectInFlight = false;
    }

    /**
     * Probes all candidates in parallel and returns results in candidate order. The first ok entry is
     * the endpoint to use: the highest-priority reachable one. Higher-priority candidates are awaited
     * only during the preference window, but any candidate may still succeed until the deadline, so a
     * slow-but-working cellular link is not reported as unreachable.
     */
    private List<ProbeResult> probeInPreferenceOrder(List<String> candidates) {
        final int n = candidates.size();
        List<Future<ProbeResult>> futures = new ArrayList<>();
        for (final String base : candidates) {
            try {
                futures.add(probeExecutor.submit(new Callable<ProbeResult>() {
                    @Override
                    public ProbeResult call() {
                        return probe(base);
                    }
                }));
            } catch (RejectedExecutionException e) {
                return new ArrayList<>(); // Activity is shutting down
            }
        }
        ProbeResult[] done = new ProbeResult[n];
        long start = SystemClock.elapsedRealtime();
        while (true) {
            long elapsed = SystemClock.elapsedRealtime() - start;
            boolean allDone = true;
            for (int i = 0; i < n; i++) {
                if (done[i] != null) continue;
                Future<ProbeResult> f = futures.get(i);
                if (!f.isDone()) {
                    allDone = false;
                    continue;
                }
                try {
                    done[i] = f.get();
                } catch (Exception e) {
                    done[i] = new ProbeResult(candidates.get(i), false, "probe failed");
                }
            }
            boolean preferenceOver = elapsed >= PREFERRED_ENDPOINT_WAIT_MS;
            boolean higherPending = false;
            for (int i = 0; i < n; i++) {
                if (done[i] == null) {
                    higherPending = true;
                } else if (done[i].ok && (!higherPending || preferenceOver)) {
                    return snapshotProbeResults(candidates, done, futures);
                }
            }
            if (allDone || elapsed >= PROBE_DEADLINE_MS) {
                return snapshotProbeResults(candidates, done, futures);
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return snapshotProbeResults(candidates, done, futures);
            }
        }
    }

    private static List<ProbeResult> snapshotProbeResults(
            List<String> candidates, ProbeResult[] done, List<Future<ProbeResult>> futures) {
        List<ProbeResult> results = new ArrayList<>();
        for (int i = 0; i < done.length; i++) {
            if (done[i] != null) {
                results.add(done[i]);
            } else {
                futures.get(i).cancel(true);
                results.add(new ProbeResult(candidates.get(i), false, "timed out"));
            }
        }
        return results;
    }

    private ProbeResult probe(String base) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/api/health");
            int timeoutMs = base.startsWith("https://") ? PROBE_TIMEOUT_HTTPS_MS : PROBE_TIMEOUT_HTTP_MS;
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code != 200) return new ProbeResult(base, false, "HTTP " + code);
            StringBuilder body = new StringBuilder();
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null && body.length() < 4096) body.append(line);
            reader.close();
            boolean ok = body.toString().contains("\"ok\":true");
            return new ProbeResult(base, ok, ok ? "" : "unexpected response");
        } catch (javax.net.ssl.SSLException e) {
            return new ProbeResult(base, false, "TLS error: " + shortMessage(e));
        } catch (java.net.SocketTimeoutException e) {
            return new ProbeResult(base, false, "timed out");
        } catch (java.net.UnknownHostException e) {
            return new ProbeResult(base, false, "DNS lookup failed");
        } catch (java.net.ConnectException e) {
            return new ProbeResult(base, false, "can't connect" + errnoSuffix(e));
        } catch (Exception e) {
            return new ProbeResult(base, false, e.getClass().getSimpleName() + errnoSuffix(e));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Extracts the errno name (e.g. ECONNREFUSED, ENETUNREACH) that distinguishes network failure modes. */
    private static String errnoSuffix(Exception e) {
        String msg = e.getMessage();
        if (msg == null) return "";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\b(E[A-Z]{4,})\\b").matcher(msg);
        return m.find() ? " (" + m.group(1) + ")" : "";
    }

    private static String shortMessage(Exception e) {
        String msg = e.getMessage();
        if (msg == null || msg.isEmpty()) return e.getClass().getSimpleName();
        int colon = msg.lastIndexOf(": ");
        String tail = colon >= 0 && colon + 2 < msg.length() ? msg.substring(colon + 2) : msg;
        return tail.length() > 90 ? tail.substring(0, 90) + "…" : tail;
    }

    private String summarize(List<ProbeResult> results) {
        StringBuilder sb = new StringBuilder();
        String wan = normalizeEndpointUrl(prefs.getString(KEY_WAN_URL, ""));
        String backup = backupWanUrl(wan);
        for (ProbeResult r : results) {
            if (sb.length() > 0) sb.append(" • ");
            String label;
            if (r.base.equals(wan)) {
                label = "Remote";
            } else if (r.base.equals(backup)) {
                label = "Remote backup port";
            } else if (r.base.startsWith("http://")) {
                Uri u = Uri.parse(r.base);
                label = "Home network " + (u.getHost() != null ? u.getHost() : "");
            } else {
                label = "Saved URL";
            }
            sb.append(label).append(": ").append(r.error);
        }
        return sb.toString();
    }

    private long nextRetryDelay() {
        return RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
    }

    private void scheduleRetry(long delayMs) {
        if (destroyed) return;
        cancelPendingRetry();
        retryAttempt++;
        pendingRetry = new Runnable() {
            @Override
            public void run() {
                pendingRetry = null;
                connectBest(false);
            }
        };
        handler.postDelayed(pendingRetry, delayMs);
    }

    private void cancelPendingRetry() {
        if (pendingRetry != null) {
            handler.removeCallbacks(pendingRetry);
            pendingRetry = null;
        }
    }

    private void onEndpointFailed(String reason) {
        cancelDirectLoadWatchdog();
        final String failedBase = currentBase;
        final boolean wasRelayed = currentPageRelayed;
        currentBase = null;
        if (failedBase != null && failedBase.startsWith("https://") && !wasRelayed) {
            // The probe reached this endpoint with the app's own TLS stack, but the WebView's connection
            // failed; some networks break only browser-engine traffic, so retry through the relay now.
            preferRelay = true;
            retryAttempt = 0;
            showStatusPage("Reconnecting…",
                    "The page didn't load directly (" + reason + "). Retrying over the app's own secure connection.", 0);
            connectBest(false);
            return;
        }
        if (wasRelayed) {
            // Alternate modes so a network where only the WebView's direct connection works is never stuck.
            preferRelay = false;
        }
        long delay = nextRetryDelay();
        showStatusPage("Can't reach your desktop", reason, delay);
        scheduleRetry(delay);
    }

    /** Called when the loaded web app reports it has been offline for a while. */
    private void maybeSwitchEndpoint() {
        long now = SystemClock.elapsedRealtime();
        if (destroyed || connectInFlight || currentBase == null || now - lastSwitchCheckMs < 15000) return;
        lastSwitchCheckMs = now;
        final String current = currentBase;
        final List<String> candidates = candidateEndpoints();
        runInBackground(new Runnable() {
            @Override
            public void run() {
                if (probe(current).ok) return; // Same endpoint is fine; the page reconnects itself.
                final List<ProbeResult> results = probeInPreferenceOrder(candidates);
                postUi(new Runnable() {
                    @Override
                    public void run() {
                        for (ProbeResult r : results) {
                            if (r.ok && !r.base.equals(currentBase)) {
                                loadBase(r.base);
                                return;
                            }
                        }
                    }
                });
            }
        });
    }

    private void loadBase(String base) {
        if (webView == null) return;
        cancelPendingRetry();
        currentBase = base;
        localPageKind = null;
        prefs.edit().putString(KEY_LAST_GOOD_URL, base).apply();
        navigateTo(base, prefs.getString(KEY_TOKEN, ""));
    }

    private void loadBaseWithExplicitToken(String rawBase, String token) {
        if (webView == null) return;
        String base = normalizeEndpointUrl(rawBase);
        if (base.isEmpty()) {
            showConnectionManagerHtml();
            return;
        }
        cancelPendingRetry();
        currentBase = base;
        localPageKind = null;
        navigateTo(base, token);
    }

    /** Loads the web app for an endpoint, through the relay when this network needs it. */
    private void navigateTo(final String base, final String token) {
        if (preferRelay && base.startsWith("https://")) {
            boolean started = runInBackground(new Runnable() {
                @Override
                public void run() {
                    final String relayBase = ensureRelay(base);
                    postUi(new Runnable() {
                        @Override
                        public void run() {
                            if (!base.equals(currentBase)) {
                                // Superseded by a newer navigation.
                                if (!currentPageRelayed) closeRelay();
                                return;
                            }
                            if (relayBase != null) {
                                loadPage(relayBase, token, true);
                            } else {
                                loadPage(base, token, false);
                            }
                        }
                    });
                }
            });
            if (started) return;
        }
        loadPage(base, token, false);
    }

    private void loadPage(String pageBase, String token, boolean relayed) {
        if (webView == null) return;
        currentPageRelayed = relayed;
        currentPageBase = pageBase;
        if (!relayed) {
            closeRelay();
        }
        cancelDirectLoadWatchdog();
        if (!relayed && pageBase.startsWith("https://")) {
            armDirectLoadWatchdog(pageBase);
        }
        String url = (token != null && !token.isEmpty())
                ? pageBase + "/?token=" + Uri.encode(token)
                : pageBase + "/";
        webView.loadUrl(url);
    }

    /** Starts (or reuses) the loopback relay for an https endpoint; returns its base URL, or null on failure. */
    private synchronized String ensureRelay(String base) {
        Uri uri = Uri.parse(base);
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        int port = uri.getPort() > 0 ? uri.getPort() : 443;
        TlsRelay existing = relay;
        if (existing != null && existing.forwardsTo(host, port)) return existing.localBase();
        if (existing != null) existing.close();
        try {
            relay = TlsRelay.start(host, port, RELAY_PORT, HttpsURLConnection.getDefaultHostnameVerifier());
            return relay.localBase();
        } catch (Exception e) {
            relay = null;
            return null;
        }
    }

    private boolean isCurrentPageUrl(Uri uri) {
        if (uri == null || currentPageBase == null) return false;
        Uri base = Uri.parse(currentPageBase);
        if (uri.getScheme() == null || base.getScheme() == null || uri.getHost() == null || base.getHost() == null) {
            return false;
        }
        return uri.getScheme().equalsIgnoreCase(base.getScheme())
                && uri.getHost().equalsIgnoreCase(base.getHost())
                && effectivePort(uri) == effectivePort(base);
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() > 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private synchronized void closeRelay() {
        final TlsRelay r = relay;
        if (r == null) return;
        relay = null;
        // Closing sends TLS close alerts, which is network I/O and must stay off the main thread.
        new Thread(new Runnable() {
            @Override
            public void run() {
                r.close();
            }
        }).start();
    }

    private void armDirectLoadWatchdog(final String pageBase) {
        directLoadWatchdog = new Runnable() {
            @Override
            public void run() {
                directLoadWatchdog = null;
                if (destroyed || webView == null || currentBase == null || currentPageRelayed) return;
                if (!pageBase.equals(currentBase)) return;
                onEndpointFailed("no response within " + (DIRECT_LOAD_TIMEOUT_MS / 1000) + "s");
            }
        };
        handler.postDelayed(directLoadWatchdog, DIRECT_LOAD_TIMEOUT_MS);
    }

    private void cancelDirectLoadWatchdog() {
        if (directLoadWatchdog != null) {
            handler.removeCallbacks(directLoadWatchdog);
            directLoadWatchdog = null;
        }
    }

    private String normalizeEndpointUrl(String raw) {
        if (raw == null) return "";
        String clean = raw.trim();
        int q = clean.indexOf('?');
        if (q >= 0) clean = clean.substring(0, q);
        clean = clean.replaceAll("/+$", "");
        if (clean.isEmpty()) return "";
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
            if (clean.startsWith("192.168.") || clean.startsWith("10.") || clean.startsWith("127.")) {
                clean = "http://" + clean;
            } else {
                clean = "https://" + clean;
            }
        }
        return clean;
    }

    private boolean isTrustedUrl(String url) {
        if (url == null) return false;
        String lowerUrl = url.toLowerCase(java.util.Locale.ROOT);
        if (lowerUrl.startsWith(LOCAL_PAGE_BASE)) return true;
        TlsRelay r = relay;
        if (r != null && r.isOpen()) {
            String relayBase = r.localBase();
            if (lowerUrl.equals(relayBase) || lowerUrl.startsWith(relayBase + "/")) return true;
        }
        for (String base : candidateEndpoints()) {
            String lowerBase = base.toLowerCase(java.util.Locale.ROOT);
            if (lowerUrl.equals(lowerBase) || lowerUrl.startsWith(lowerBase + "/")) return true;
        }
        return false;
    }

    // --- Network change notifications ---------------------------------------------------

    private void registerNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    postUi(new Runnable() {
                        @Override
                        public void run() {
                            onNetworkChanged();
                        }
                    });
                }

                @Override
                public void onLost(Network network) {
                    postUi(new Runnable() {
                        @Override
                        public void run() {
                            if (webView != null && currentBase != null) {
                                webView.evaluateJavascript("if(window.__onNetworkChanged) window.__onNetworkChanged();", null);
                            }
                        }
                    });
                }
            };
            cm.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Exception ignored) {
            // Already unregistered
        }
        networkCallback = null;
    }

    private void onNetworkChanged() {
        if (webView == null) return;
        if (currentBase == null) {
            if (!"settings".equals(localPageKind)) {
                retryAttempt = 0;
                connectBest(false);
            }
            return;
        }
        webView.evaluateJavascript("if(window.__onNetworkChanged) window.__onNetworkChanged();", null);
        // Give the new network a moment, then switch endpoints only if the current one is unreachable.
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                lastSwitchCheckMs = 0;
                maybeSwitchEndpoint();
            }
        }, 3000);
    }

    // --- Native pages -------------------------------------------------------------------

    private void showStatusPage(String title, String detail, long retryInMs) {
        if (webView == null) return;
        localPageKind = "status";
        String retryScript = retryInMs > 0
                ? "var left=" + (retryInMs / 1000) + ";var el=document.getElementById('cd');"
                + "function tick(){el.textContent=left>0?('Retrying automatically in '+left+'s'):'Retrying…';left--;}"
                + "tick();setInterval(tick,1000);"
                : "document.getElementById('cd').textContent='';";
        String html = "<!DOCTYPE html><html><head>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1'/>"
                + "<style>"
                + "body{margin:0;padding:32px 20px;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;box-sizing:border-box;}"
                + ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px 20px;}"
                + "h2{margin:0 0 8px;font-size:19px;}"
                + "p{margin:0 0 6px;font-size:13px;color:#8b949e;line-height:1.45;word-break:break-word;}"
                + "#cd{color:#e3b341;font-size:13px;margin:10px 0 4px;}"
                + ".btn{display:block;width:100%;padding:12px;margin-top:10px;border-radius:8px;border:none;font-weight:600;font-size:14px;}"
                + ".primary{background:#1f6feb;color:#fff;}.sec{background:#21262d;color:#e6edf3;border:1px solid #30363d;}"
                + ".spin{width:18px;height:18px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;display:inline-block;animation:s 0.8s linear infinite;vertical-align:middle;margin-right:8px;}"
                + "@keyframes s{to{transform:rotate(360deg)}}"
                + "</style></head><body><div class='card'>"
                + "<h2>" + (retryInMs > 0 ? "" : "<span class='spin'></span>") + esc(title) + "</h2>"
                + (detail != null && !detail.isEmpty() ? "<p>" + esc(detail) + "</p>" : "")
                + "<p>The app keeps your session paired and reconnects automatically when your desktop is reachable.</p>"
                + "<div id='cd'></div>"
                + "<button class='btn primary' onclick='AndroidNative.retryNow()'>Retry now</button>"
                + "<button class='btn sec' onclick='AndroidNative.openConnectionSettings()'>Connection settings</button>"
                + "</div><script>" + retryScript + "</script></body></html>";
        webView.loadDataWithBaseURL(LOCAL_PAGE_BASE, html, "text/html", "UTF-8", LOCAL_PAGE_BASE);
    }

    private void showConnectionManagerHtml() {
        if (webView == null) return;
        cancelPendingRetry();
        currentBase = null;
        localPageKind = "settings";
        String lan = esc(prefs.getString(KEY_LAN_URL, ""));
        String wan = esc(prefs.getString(KEY_WAN_URL, ""));

        String html = "<!DOCTYPE html><html><head>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1'/>"
                + "<style>"
                + "body{margin:0;padding:24px 18px;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;box-sizing:border-box;}"
                + ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px 20px;}"
                + "h2{margin:0 0 10px;font-size:20px;color:#e6edf3;letter-spacing:-0.01em;}"
                + "p{margin:0 0 16px;font-size:13px;color:#8b949e;line-height:1.45;}"
                + "label{display:block;font-size:12px;font-weight:600;color:#c9d1d9;margin:12px 0 5px;}"
                + "input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#fff;font-size:14px;outline:none;}"
                + "input:focus{border-color:#58a6ff;}"
                + ".btn{display:block;width:100%;padding:12px;margin-top:10px;border-radius:8px;border:none;font-weight:600;font-size:14px;cursor:pointer;text-align:center;}"
                + ".btn-wan{background:#238636;color:#fff;}"
                + ".btn-primary{background:#1f6feb;color:#fff;}"
                + ".btn-sec{background:#21262d;color:#e6edf3;border:1px solid #30363d;}"
                + "#st{margin-top:12px;font-size:12.5px;color:#58a6ff;text-align:center;display:none;}"
                + "</style></head><body>"
                + "<div class='card'>"
                + "<h2>Connection settings</h2>"
                + "<p>Paste your Pairing URL, or enter your desktop's remote and home Wi-Fi URLs. Leave the code blank to keep your current pairing.</p>"
                + "<label>Remote HTTPS URL (cellular / anywhere)</label>"
                + "<input id='wan' value='" + wan + "' placeholder='https://remote.example.com:4321' />"
                + "<label>Desktop LAN URL (home Wi-Fi)</label>"
                + "<input id='lan' value='" + lan + "' placeholder='http://192.168.1.100:4321' />"
                + "<label>6-digit code or pairing token (optional)</label>"
                + "<input id='tok' value='' placeholder='Leave blank to keep the saved pairing' autocomplete='off' />"
                + "<div id='st'>Connecting to Desktop...</div>"
                + "<button class='btn btn-wan' onclick='autoConn()'>Save &amp; connect</button>"
                + "<button class='btn btn-primary' onclick='connLan()'>Use home Wi-Fi URL now</button>"
                + "<button class='btn btn-sec' onclick='connWan()'>Use remote URL now</button>"
                + "</div>"
                + "<script>"
                + "function showSt(msg){var el=document.getElementById('st');el.style.display='block';el.textContent=msg;}"
                + "function parseAndSave(){"
                + "  var l=document.getElementById('lan').value.trim();"
                + "  var w=document.getElementById('wan').value.trim();"
                + "  var t=document.getElementById('tok').value.trim();"
                + "  if(t.indexOf('http://')===0||t.indexOf('https://')===0){if(t.indexOf('https://')===0)w=t;else l=t;t='';}"
                + "  if(l.indexOf('?token=')!==-1){var p=l.split('?token=');l=p[0];t=decodeURIComponent(p[1].split('&')[0]);}"
                + "  if(w.indexOf('?token=')!==-1){var p2=w.split('?token=');w=p2[0];t=decodeURIComponent(p2[1].split('&')[0]);}"
                + "  AndroidNative.saveConfig(l,w,t);"
                + "  return {l:l,w:w,t:t};"
                + "}"
                + "function connLan(){var c=parseAndSave();showSt('Connecting to home Wi-Fi URL...');AndroidNative.connectTo(c.l,c.t);}"
                + "function connWan(){var c=parseAndSave();showSt('Connecting to remote URL...');AndroidNative.connectTo(c.w||c.l,c.t);}"
                + "function autoConn(){var c=parseAndSave();showSt('Finding the best connection...');if(/^\\d{6}$/.test(c.t)){AndroidNative.connectTo(c.w||c.l,c.t);}else{AndroidNative.autoConnect();}}"
                + "</script></body></html>";

        webView.loadDataWithBaseURL(LOCAL_PAGE_BASE, html, "text/html", "UTF-8", LOCAL_PAGE_BASE);
    }

    private String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("'", "&#39;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getDataString() != null) {
                    results = new Uri[]{Uri.parse(data.getDataString())};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            if ("settings".equals(localPageKind)) {
                connectBest(true);
                return;
            }
            if (localPageKind != null) {
                super.onBackPressed();
                return;
            }
            webView.evaluateJavascript(
                    "(function(){ return Boolean(window.__handleAndroidBack && window.__handleAndroidBack()); })()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if ("true".equals(value)) {
                                return;
                            }
                            if (webView != null && webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                MainActivity.super.onBackPressed();
                            }
                        }
                    }
            );
            return;
        }
        super.onBackPressed();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null) {
            onBackPressed();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    public class AndroidBridge {
        private boolean trusted() {
            return isTrustedUrl(currentPageUrl);
        }

        @JavascriptInterface
        public void saveConfig(final String lanUrl, final String wanUrl, final String token) {
            if (!trusted()) return;
            SharedPreferences.Editor ed = prefs.edit();
            if (lanUrl != null) ed.putString(KEY_LAN_URL, normalizeEndpointUrl(lanUrl));
            if (wanUrl != null) ed.putString(KEY_WAN_URL, normalizeEndpointUrl(wanUrl));
            // Never persist a short-lived 6-digit code; the web app exchanges it and syncs the resulting token.
            if (token != null && !token.trim().isEmpty() && !token.trim().matches("^\\d{6}$")) {
                ed.putString(KEY_TOKEN, token.trim());
            }
            ed.apply();
        }

        @JavascriptInterface
        public void syncEndpoints(String lanUrl, String wanUrl, String token) {
            if (!trusted()) return;
            SharedPreferences.Editor ed = prefs.edit();
            if (lanUrl != null && !lanUrl.isEmpty()) ed.putString(KEY_LAN_URL, normalizeEndpointUrl(lanUrl));
            if (wanUrl != null && !wanUrl.isEmpty()) ed.putString(KEY_WAN_URL, normalizeEndpointUrl(wanUrl));
            if (token != null && !token.isEmpty()) {
                String cleanTok = token.trim();
                String existingTok = prefs.getString(KEY_TOKEN, "");
                // Never overwrite a permanent pairing token with a temporary tmp_ session token
                if (existingTok == null || existingTok.isEmpty() || existingTok.startsWith("tmp_") || !cleanTok.startsWith("tmp_")) {
                    ed.putString(KEY_TOKEN, cleanTok);
                }
            }
            ed.apply();
        }

        @JavascriptInterface
        public void syncLanAlternates(String csv) {
            if (!trusted() || csv == null) return;
            String alts = joinPrivateLanUrls(csv.split(","), 0, prefs.getString(KEY_LAN_URL, ""));
            prefs.edit().putString(KEY_LAN_ALTS, alts).apply();
        }

        @JavascriptInterface
        public String getSavedToken() {
            return trusted() ? prefs.getString(KEY_TOKEN, "") : "";
        }

        @JavascriptInterface
        public void reportConnectionState(final String state) {
            if (!trusted()) return;
            postUi(new Runnable() {
                @Override
                public void run() {
                    if ("offline".equals(state)) {
                        maybeSwitchEndpoint();
                    }
                }
            });
        }

        @JavascriptInterface
        public void retryNow() {
            if (!trusted()) return;
            postUi(new Runnable() {
                @Override
                public void run() {
                    retryAttempt = 0;
                    connectBest(true);
                }
            });
        }

        @JavascriptInterface
        public void silentAutoRecover() {
            retryNow();
        }

        @JavascriptInterface
        public String getSavedHostsJson() {
            return trusted() ? prefs.getString(KEY_HOSTS_JSON, "[]") : "[]";
        }

        @JavascriptInterface
        public void saveHostsJson(String json) {
            if (trusted() && json != null) {
                prefs.edit().putString(KEY_HOSTS_JSON, json).apply();
            }
        }

        @JavascriptInterface
        public void connectTo(final String url, final String token) {
            if (!trusted()) return;
            postUi(new Runnable() {
                @Override
                public void run() {
                    loadBaseWithExplicitToken(url, token);
                }
            });
        }

        @JavascriptInterface
        public void autoConnect() {
            retryNow();
        }

        @JavascriptInterface
        public void openConnectionSettings() {
            if (!trusted()) return;
            postUi(new Runnable() {
                @Override
                public void run() {
                    showConnectionManagerHtml();
                }
            });
        }
    }
}
