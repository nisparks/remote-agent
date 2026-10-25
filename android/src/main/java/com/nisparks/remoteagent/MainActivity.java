package com.nisparks.remoteagent;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.os.Handler;

import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "RemoteAgentPrefs";
    private static final String KEY_LAN_URL = "lan_url";
    private static final String KEY_WAN_URL = "wan_url";
    private static final String KEY_LAN_ALTS = "lan_alt_urls";
    private static final String KEY_TOKEN = "auth_token";
    private static final String KEY_LAST_GOOD_URL = "last_good_url";
    private static final String KEY_HOSTS_JSON = "saved_hosts_json";
    private static final String KEY_KEEP_AWAKE = "keep_awake";
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private SharedPreferences prefs;
    private final Handler reconnectHandler = new Handler();
    private Runnable reconnectWatchdog;
    private volatile boolean mainFrameError = false;
    // Load coordinator: only one navigation at a time, so slow (cellular) loads are not restarted mid-flight.
    private volatile boolean pageLoading = false;
    private volatile long loadStartedMs = 0;
    private volatile String loadingBase = "";
    private volatile String lastRequestedUrl = "";
    private volatile boolean errorRecoveryRunning = false;
    private static final long LOAD_GRACE_MS = 45000;
    private boolean reconnectWatchdogRunning = false;
    private String lastConnectionProbeTarget = "";

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

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0F19"));

        webView = new WebView(this);
        setupWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        setContentView(root);
        connectImmediateOrAuto();
        startConnectionWatchdog();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
        connectImmediateOrAuto();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.evaluateJavascript("if(window.__onAppResume) window.__onAppResume();", null);
            webView.evaluateJavascript(
                    "(function(){ if(window.ensureLiveConnectionOnWake) window.ensureLiveConnectionOnWake(); })()",
                    null
            );
        }
        reconnectHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                connectImmediateOrAuto();
            }
        }, 500);
    }

    private void initDefaultsIfEmpty() {
        String defaultLan = getString(R.string.default_lan_url);
        String defaultWan = getString(R.string.default_wan_url);
        String defaultToken = getString(R.string.default_token);

        SharedPreferences.Editor ed = prefs.edit();
        // When an APK is built with embedded local/WAN defaults, always refresh SharedPreferences so stale URLs/tokens are replaced
        if (defaultLan != null && !defaultLan.isEmpty()) {
            String[] lans = defaultLan.split(",");
            defaultLan = lans[0].trim();
            ed.putString(KEY_LAN_URL, defaultLan);
            StringBuilder alts = new StringBuilder();
            for (int i = 1; i < lans.length; i++) {
                if (alts.length() > 0) alts.append(",");
                alts.append(lans[i].trim());
            }
            ed.putString(KEY_LAN_ALTS, alts.toString());
        }
        if (defaultWan != null && !defaultWan.isEmpty()) {
            ed.putString(KEY_WAN_URL, defaultWan);
            ed.putString(KEY_LAST_GOOD_URL, defaultWan);
        } else if (defaultLan != null && !defaultLan.isEmpty()) {
            ed.putString(KEY_LAST_GOOD_URL, defaultLan);
        }
        if (defaultToken != null && !defaultToken.isEmpty()) {
            ed.putString(KEY_TOKEN, defaultToken);
        }
        ed.apply();
    }

    private void connectImmediateOrAuto() {
        final String lastGood = prefs.getString(KEY_LAST_GOOD_URL, "");
        final String wanUrl = prefs.getString(KEY_WAN_URL, "");
        final String lanUrl = prefs.getString(KEY_LAN_URL, "");
        final String token = prefs.getString(KEY_TOKEN, "");

        final String immediateTarget = (lastGood != null && !lastGood.isEmpty())
                ? lastGood
                : ((wanUrl != null && !wanUrl.isEmpty()) ? wanUrl : lanUrl);

        if (immediateTarget != null && !immediateTarget.isEmpty()) {
            loadEndpointWithToken(immediateTarget, token);
            // Parallel 1.5s health verification: if immediateTarget doesn't respond, seamlessly switch to whichever endpoint is alive!
            new Thread(new Runnable() {
                @Override
                public void run() {
                    if (probeEndpoint(immediateTarget)) {
                        return;
                    }
                    final String nextTarget = findReachableEndpoint(lanUrl, wanUrl);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (nextTarget != null) {
                                prefs.edit().putString(KEY_LAST_GOOD_URL, nextTarget).apply();
                                loadEndpointWithToken(nextTarget, token);
                            } else {
                                showConnectionManagerHtml();
                            }
                        }
                    });
                }
            }).start();
        } else {
            autoConnectBestEndpoint();
        }
    }

    private void handleDeepLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri uri = intent.getData();
        if ("remoteagent".equalsIgnoreCase(uri.getScheme())) {
            SharedPreferences.Editor ed = prefs.edit();
            String lan = uri.getQueryParameter("lan");
            String wan = uri.getQueryParameter("wan");
            String token = uri.getQueryParameter("token");
            if (lan != null && !lan.isEmpty()) ed.putString(KEY_LAN_URL, lan);
            if (wan != null && !wan.isEmpty()) {
                ed.putString(KEY_WAN_URL, wan);
                ed.putString(KEY_LAST_GOOD_URL, wan);
            } else if (lan != null && !lan.isEmpty()) {
                ed.putString(KEY_LAST_GOOD_URL, lan);
            }
            if (token != null && !token.isEmpty()) ed.putString(KEY_TOKEN, token);
            ed.apply();
        }
    }

    private void applyKeepAwake(boolean keepAwake) {
        if (keepAwake) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setBackgroundColor(Color.parseColor("#0B0F19"));
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                mainFrameError = false;
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    pageLoading = true;
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageLoading = false;
                if (!mainFrameError && url != null && (url.startsWith("http://") || url.startsWith("https://")) && !url.startsWith("http://localhost")) {
                    String base = url.split("\\?")[0].replaceAll("/+$", "");
                    prefs.edit().putString(KEY_LAST_GOOD_URL, base).apply();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                String failedUrl = request.getUrl() != null ? request.getUrl().toString() : "";
                // Errors for navigations we've already superseded (e.g. ERR_ABORTED) are not real failures.
                if (!failedUrl.isEmpty() && !lastRequestedUrl.isEmpty() && !failedUrl.equals(lastRequestedUrl)) return;
                mainFrameError = true;
                pageLoading = false;
                if (errorRecoveryRunning) return;
                errorRecoveryRunning = true;
                final String wanUrl = prefs.getString(KEY_WAN_URL, "");
                final String lanUrl = prefs.getString(KEY_LAN_URL, "");
                final String token = prefs.getString(KEY_TOKEN, "");
                new Thread(new Runnable() {
                    @Override public void run() {
                        try {
                            try { Thread.sleep(750); } catch (InterruptedException ignored) {}
                            final String target = findReachableEndpoint(lanUrl, wanUrl);
                            if (target != null) {
                                runOnUiThread(new Runnable() {
                                    @Override public void run() { loadEndpointWithToken(target, token); }
                                });
                            }
                        } finally {
                            errorRecoveryRunning = false;
                        }
                    }
                }).start();
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
                    WebView webView,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                String[] mimeTypes = new String[]{"image/*", "application/pdf", "text/*"};
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
                startActivityForResult(Intent.createChooser(intent, "Attach Photo or File"), FILE_CHOOSER_RESULT_CODE);
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setData(Uri.parse(url));
                    startActivity(i);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot open download URL", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private void autoConnectBestEndpoint() {
        final String lanUrl = prefs.getString(KEY_LAN_URL, "");
        final String wanUrl = prefs.getString(KEY_WAN_URL, "");
        final String token = prefs.getString(KEY_TOKEN, "");

        new Thread(new Runnable() {
            @Override
            public void run() {
                final String target = findReachableEndpoint(lanUrl, wanUrl);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (target != null) {
                            loadEndpointWithToken(target, token);
                        } else {
                            showConnectionManagerHtml();
                        }
                    }
                });
            }
        }).start();
    }

    // Backup WAN route: same host on the next port (e.g. router forwards 4321 -> Wi-Fi IP, 4322 -> Ethernet IP)
    private String backupWanUrl(String wanUrl) {
        try {
            Uri u = Uri.parse(normalizeEndpointUrl(wanUrl));
            int port = u.getPort();
            if (u.getHost() == null || port <= 0) return null;
            return u.getScheme() + "://" + u.getHost() + ":" + (port + 1);
        } catch (Exception e) {
            return null;
        }
    }

    private java.util.List<String> candidateEndpoints(String lanUrl, String wanUrl) {
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<String>();
        if (lanUrl != null && !lanUrl.isEmpty()) set.add(lanUrl.trim().replaceAll("/+$", ""));
        String alts = prefs.getString(KEY_LAN_ALTS, "");
        if (alts != null) {
            for (String a : alts.split(",")) {
                if (!a.trim().isEmpty()) set.add(a.trim().replaceAll("/+$", ""));
            }
        }
        if (wanUrl != null && !wanUrl.isEmpty()) {
            set.add(wanUrl.trim().replaceAll("/+$", ""));
            String backup = backupWanUrl(wanUrl);
            if (backup != null) set.add(backup);
        }
        return new java.util.ArrayList<String>(set);
    }

    // Probes all candidates in parallel; returns the highest-priority (list order) reachable one,
    // so dead LAN addresses never delay a working WAN route.
    private String findReachableEndpoint(String lanUrl, String wanUrl) {
        final java.util.List<String> candidates = candidateEndpoints(lanUrl, wanUrl);
        final int n = candidates.size();
        if (n == 0) return null;
        final int[] results = new int[n]; // 0 = pending, 1 = ok, -1 = failed
        for (int i = 0; i < n; i++) {
            final int idx = i;
            final String candidate = candidates.get(i);
            new Thread(new Runnable() {
                @Override
                public void run() {
                    boolean ok = probeEndpoint(candidate);
                    synchronized (results) {
                        results[idx] = ok ? 1 : -1;
                        results.notifyAll();
                    }
                }
            }).start();
        }
        long deadline = System.currentTimeMillis() + 20000;
        synchronized (results) {
            while (true) {
                for (int i = 0; i < n; i++) {
                    if (results[i] == 1) return candidates.get(i);
                    if (results[i] == 0) break;
                }
                boolean allDone = true;
                for (int r : results) if (r == 0) { allDone = false; break; }
                long remaining = deadline - System.currentTimeMillis();
                if (allDone || remaining <= 0) return null;
                try {
                    results.wait(remaining);
                } catch (InterruptedException e) {
                    return null;
                }
            }
        }
    }

    private void startConnectionWatchdog() {
        if (reconnectWatchdogRunning) return;
        reconnectWatchdogRunning = true;
        reconnectWatchdog = new Runnable() {
            private int consecutiveMisses = 0;
            private int backoffSeconds = 5;
            private long lastTryMs = 0;
            private final java.util.concurrent.atomic.AtomicBoolean probing = new java.util.concurrent.atomic.AtomicBoolean(false);
            @Override
            public void run() {
                final long now = System.currentTimeMillis();
                if (probing.get()) {
                    reconnectHandler.postDelayed(this, 1000);
                    return;
                }
                if (pageLoading && !mainFrameError && now - loadStartedMs < LOAD_GRACE_MS) {
                    reconnectHandler.postDelayed(this, 2000);
                    return;
                }
                final String currentUrl = webView != null ? webView.getUrl() : null;
                final String lanUrl = prefs.getString(KEY_LAN_URL, "");
                final String wanUrl = prefs.getString(KEY_WAN_URL, "");
                final String lastGood = prefs.getString(KEY_LAST_GOOD_URL, "");
                final String token = prefs.getString(KEY_TOKEN, "");
                if (now - lastTryMs < 1000 * backoffSeconds) {
                    reconnectHandler.postDelayed(this, 1000 * backoffSeconds);
                    return;
                }
                lastTryMs = now;
                probing.set(true);
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                      try {
                        String target = null;
                        String active = currentUrl != null ? currentUrl : lastGood;
                        if (active != null && !active.isEmpty() && !active.startsWith("http://localhost")) {
                            String activeBase = active.split("\\?")[0].replaceAll("/+$", "");
                            if (probeEndpoint(activeBase)) {
                                target = activeBase;
                                consecutiveMisses = 0;
                                backoffSeconds = 5;
                            }
                        }
                        if (target == null) {
                            target = findReachableEndpoint(lanUrl, wanUrl);
                            if (target == null) {
                                consecutiveMisses++;
                                backoffSeconds = Math.min(60, 5 * (1 << Math.min(3, consecutiveMisses)));
                            } else {
                                consecutiveMisses = 0;
                                backoffSeconds = 5;
                            }
                        }
                        if (target != null) {
                            final String chosenTarget = target;
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    String currentBase = webView.getUrl() != null
                                            ? webView.getUrl().split("\\?")[0].replaceAll("/+$", "")
                                            : "";
                                    if (mainFrameError || !chosenTarget.replaceAll("/+$", "").equals(currentBase)) {
                                        prefs.edit().putString(KEY_LAST_GOOD_URL, chosenTarget).apply();
                                        loadEndpointWithToken(chosenTarget, token);
                                    } else {
                                        webView.evaluateJavascript(
                                                "(function(){ if(window.AndroidNative && window.AndroidNative.getSavedToken) return true; return false; })()",
                                                null
                                        );
                                    }
                                }
                            });
                        } else if (currentUrl == null || !currentUrl.startsWith("http://localhost")) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    showConnectionManagerHtml();
                                }
                            });
                        }
                      } finally {
                        probing.set(false);
                      }
                    }
                }).start();
                reconnectHandler.postDelayed(this, 1000 * backoffSeconds);
            }
        };
        reconnectHandler.post(reconnectWatchdog);
    }

    private boolean probeEndpoint(String baseUrl) {
        HttpURLConnection conn = null;
        try {
            String clean = normalizeEndpointUrl(baseUrl).split("\\?")[0].replaceAll("/+$", "");
            String token = prefs.getString(KEY_TOKEN, "");
            String urlWithToken = token != null && !token.isEmpty()
                    ? clean + "/api/health?token=" + Uri.encode(token)
                    : clean + "/api/health";
            URL url = new URL(urlWithToken);
            conn = (HttpURLConnection) url.openConnection();
            // LAN (http) should answer fast; WAN (https over cellular) needs time for DNS + TLS.
            int timeoutMs = clean.startsWith("https://") ? 8000 : 2500;
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) return false;
            BufferedReader reader = new BufferedReader(new InputStreamReader(
                    conn.getInputStream(),
                    java.nio.charset.StandardCharsets.UTF_8
            ));
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
            reader.close();
            String json = body.toString();
            if (token != null && !token.isEmpty()) {
                return json.contains("\"authenticated\":true");
            }
            return json.contains("\"ok\":true");
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String normalizeEndpointUrl(String raw) {
        if (raw == null) return "";
        String clean = raw.trim().replaceAll("/+$", "");
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

    private void loadEndpointWithToken(String baseUrl, String token) {
        String clean = normalizeEndpointUrl(baseUrl);
        if (clean.isEmpty()) {
            showConnectionManagerHtml();
            return;
        }
        String base = clean.split("\\?")[0].replaceAll("/+$", "");
        long now = System.currentTimeMillis();
        if (pageLoading && !mainFrameError && base.equals(loadingBase) && now - loadStartedMs < LOAD_GRACE_MS) {
            return; // same endpoint already loading; let it finish
        }
        String full;
        if (clean.contains("?token=")) {
            full = clean + "&_t=" + now;
        } else {
            full = (token != null && !token.isEmpty())
                    ? clean + "/?token=" + Uri.encode(token) + "&_t=" + now
                    : clean + "/?_t=" + now;
        }
        loadingBase = base;
        loadStartedMs = now;
        lastRequestedUrl = full;
        pageLoading = true;
        mainFrameError = false;
        webView.loadUrl(full);
    }

    private void showConnectionManagerHtml() {
        String lan = esc(prefs.getString(KEY_LAN_URL, ""));
        String wanPref = prefs.getString(KEY_WAN_URL, "");
        if (wanPref == null) {
            wanPref = "";
        }
        String wan = esc(wanPref);
        String tok = esc(prefs.getString(KEY_TOKEN, ""));

        String html = "<!DOCTYPE html><html><head>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1'/>"
                + "<style>"
                + "body{margin:0;padding:24px 18px;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;box-sizing:border-box;}"
                + ".card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px 20px;}"
                + ".hdr{display:flex;align-items:center;gap:12px;margin-bottom:10px;}"
                + ".badge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(34,197,94,0.16);color:#4ade80;border:1px solid rgba(34,197,94,0.35);}"
                + "h2{margin:0;font-size:20px;color:#e6edf3;letter-spacing:-0.01em;}"
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
                + "<div class='hdr'><h2>Copilot Remote Agent</h2><span class='badge'>TLS READY</span></div>"
                + "<p>Paste your Pairing URL, or enter your Desktop's WAN / LAN URL and the 6-digit MFA code shown on your Desktop.</p>"
                + "<label>Remote WAN HTTPS URL (5G / Anywhere)</label>"
                + "<input id='wan' value='" + wan + "' placeholder='https://remote.example.com:4321' />"
                + "<label>Desktop LAN URL (Home Wi-Fi)</label>"
                + "<input id='lan' value='" + lan + "' placeholder='http://192.168.1.100:4321' />"
                + "<label>6-Digit MFA Code or Pairing Token</label>"
                + "<input id='tok' value='" + tok + "' placeholder='6-digit MFA code (e.g. 482910) or token' />"
                + "<div id='st'>Connecting to Desktop...</div>"
                + "<button class='btn btn-wan' onclick='connWan()'>Connect via HTTPS WAN</button>"
                + "<button class='btn btn-primary' onclick='connLan()'>Connect via Local LAN</button>"
                + "<button class='btn btn-sec' onclick='autoConn()'>Auto-Select Best Endpoint</button>"
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
                + "function connLan(){var c=parseAndSave();showSt('Connecting to LAN...');AndroidNative.connectTo(c.l,c.t);}"
                + "function connWan(){var c=parseAndSave();showSt('Connecting to HTTPS WAN...');AndroidNative.connectTo(c.w||c.l,c.t);}"
                + "function autoConn(){parseAndSave();showSt('Probing LAN & WAN endpoints...');AndroidNative.autoConnect();}"
                + "setInterval(function(){if(document.activeElement&&document.activeElement.tagName==='INPUT')return;AndroidNative.silentAutoRecover();},4000);"
                + "</script></body></html>";

        webView.loadDataWithBaseURL("http://localhost/", html, "text/html", "UTF-8", null);
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
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
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
            String currentUrl = webView.getUrl();
            if (currentUrl != null && currentUrl.startsWith("http://localhost")) {
                connectImmediateOrAuto();
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
                            if (webView.canGoBack()) {
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
        @JavascriptInterface
        public void saveConfig(String lanUrl, String wanUrl, String token) {
            SharedPreferences.Editor ed = prefs.edit();
            if (lanUrl != null) ed.putString(KEY_LAN_URL, lanUrl.trim());
            if (wanUrl != null) ed.putString(KEY_WAN_URL, wanUrl.trim());
            // Do not overwrite KEY_TOKEN with a 30-second 6-digit MFA code; initTokenFromUrl() will sync the exchanged 30-day token via syncEndpoints()
            if (token != null && !token.trim().matches("^\\d{6}$")) {
                ed.putString(KEY_TOKEN, token.trim());
            }
            ed.apply();
        }

        @JavascriptInterface
        public void syncEndpoints(String lanUrl, String wanUrl, String token) {
            SharedPreferences.Editor ed = prefs.edit();
            if (lanUrl != null && !lanUrl.isEmpty()) ed.putString(KEY_LAN_URL, lanUrl.trim());
            if (wanUrl != null && !wanUrl.isEmpty()) {
                ed.putString(KEY_WAN_URL, wanUrl.trim());
                ed.putString(KEY_LAST_GOOD_URL, wanUrl.trim());
            }
            if (token != null && !token.isEmpty()) {
                String cleanTok = token.trim();
                String existingTok = prefs.getString(KEY_TOKEN, "");
                // Never overwrite a permanent master pairing token with a temporary tmp_ token
                if (existingTok == null || existingTok.isEmpty() || existingTok.startsWith("tmp_") || !cleanTok.startsWith("tmp_")) {
                    ed.putString(KEY_TOKEN, cleanTok);
                }
            }
            ed.apply();
        }

        @JavascriptInterface
        public void syncLanAlternates(String csv) {
            if (csv != null) prefs.edit().putString(KEY_LAN_ALTS, csv.trim()).apply();
        }

        @JavascriptInterface
        public String getSavedToken() {
            return prefs.getString(KEY_TOKEN, "");
        }

        @JavascriptInterface
        public void silentAutoRecover() {
            final String lanUrl = prefs.getString(KEY_LAN_URL, "");
            final String wanUrl = prefs.getString(KEY_WAN_URL, "");
            final String token = prefs.getString(KEY_TOKEN, "");
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final String target = findReachableEndpoint(lanUrl, wanUrl);
                    if (target != null) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                loadEndpointWithToken(target, token);
                            }
                        });
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public String getSavedHostsJson() {
            return prefs.getString(KEY_HOSTS_JSON, "[]");
        }

        @JavascriptInterface
        public void saveHostsJson(String json) {
            if (json != null) {
                prefs.edit().putString(KEY_HOSTS_JSON, json).apply();
            }
        }

        @JavascriptInterface
        public void connectTo(final String url, final String token) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    loadEndpointWithToken(url, token);
                }
            });
        }

        @JavascriptInterface
        public void autoConnect() {
            autoConnectBestEndpoint();
        }

        @JavascriptInterface
        public void openConnectionSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showConnectionManagerHtml();
                }
            });
        }
    }
}
