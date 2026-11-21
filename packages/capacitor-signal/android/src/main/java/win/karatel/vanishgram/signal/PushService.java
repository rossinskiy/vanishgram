package win.karatel.vanishgram.signal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Keeps one WebSocket per signed-in account open while the app is in the background and shows a notification when a message
 * arrives. It cannot read messages (the keys stay in the app), and it never acknowledges them, so the server keeps the queue
 * until the app itself opens and processes it. No Google or Apple push service is involved.
 */
public class PushService extends Service {
    static final String PREFS = "vg_push";
    static final String CFG = "cfg";
    static final String SEEN = "seen";
    private static final String CH_LIVE = "vg_live", CH_MSG = "vg_msg";
    private static final int LIVE_ID = 1, MSG_ID = 2;

    /** True while the app window is on screen; the page shows messages itself then. */
    static volatile boolean appVisible = false;
    private static PushService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final HashMap<String, Conn> conns = new HashMap<>();
    private OkHttpClient http;
    private int unread = 0;

    // ---- control, used by the plugin and the boot receiver ----
    static boolean hasConfig(Context c) {
        try { return new JSONObject(prefs(c).getString(CFG, "{}")).optJSONArray("accounts") != null
            && new JSONObject(prefs(c).getString(CFG, "{}")).getJSONArray("accounts").length() > 0; } catch (Throwable t) { return false; }
    }

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    public static void saveConfig(Context c, JSONObject cfg) { prefs(c).edit().putString(CFG, cfg.toString()).apply(); }

    static void clearConfig(Context c) { prefs(c).edit().remove(CFG).remove(SEEN).apply(); }

    public static void start(Context c) {
        Intent i = new Intent(c, PushService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    public static void stop(Context c) { c.stopService(new Intent(c, PushService.class)); }

    /** The app came to the front: forget shown notifications. */
    static void onAppVisible(Context c, boolean visible) {
        appVisible = visible;
        if (visible) {
            ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(MSG_ID);
            PushService s = instance;
            if (s != null) s.unread = 0;
        }
    }

    /** Called when the configuration changed while the service is running. */
    static void reload() { PushService s = instance; if (s != null) s.main.post(s::sync); }

    // ---- service ----
    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        http = new OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build();
        channels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = live();
        if (Build.VERSION.SDK_INT >= 34) startForeground(LIVE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(LIVE_ID, n);
        sync();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        for (Conn c : new ArrayList<>(conns.values())) c.stop();
        conns.clear();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel live = new NotificationChannel(CH_LIVE, "Connection", NotificationManager.IMPORTANCE_MIN);
        live.setDescription("Shown while Vanishgram waits for new messages in the background");
        live.setShowBadge(false);
        nm.createNotificationChannel(live);
        NotificationChannel msg = new NotificationChannel(CH_MSG, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msg.setShowBadge(true);
        nm.createNotificationChannel(msg);
    }

    private PendingIntent open() {
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i != null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int f = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, 0, i != null ? i : new Intent(), f);
    }

    private Notification.Builder builder(String channel) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
    }

    private Notification live() {
        return builder(CH_LIVE).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Vanishgram")
            .setContentText("Waiting for new messages").setContentIntent(open()).setOngoing(true).setShowWhen(false).build();
    }

    private void show(String label, String mode) {
        unread++;
        String body = unread == 1 ? "New message" : unread + " new messages";
        if (!"hidden".equals(mode) && label != null && !label.isEmpty() && unread == 1) body = "New message in " + label;
        Notification.Builder b = builder(CH_MSG).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Vanishgram")
            .setContentText(body).setContentIntent(open()).setAutoCancel(true).setNumber(unread);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(MSG_ID, b.build());
    }

    // ---- connections ----
    private JSONObject config() {
        try { return new JSONObject(prefs(this).getString(CFG, "{}")); } catch (Throwable t) { return new JSONObject(); }
    }

    /** Make the open sockets match the saved list of accounts. */
    private void sync() {
        JSONObject cfg = config();
        JSONArray list = cfg.optJSONArray("accounts");
        if (list == null || list.length() == 0) { stopSelf(); return; }
        String base = cfg.optString("base", "");
        String mode = cfg.optString("mode", "hidden");
        List<String> keep = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject a = list.optJSONObject(i);
            if (a == null) continue;
            String id = a.optString("id"), token = a.optString("token"), label = a.optString("label");
            if (id.isEmpty() || token.isEmpty()) continue;
            keep.add(id);
            Conn c = conns.get(id);
            if (c != null && c.token.equals(token) && c.base.equals(base)) { c.label = label; c.mode = mode; continue; }
            if (c != null) c.stop();
            c = new Conn(id, token, label, base, mode);
            conns.put(id, c);
            c.start();
        }
        for (String id : new ArrayList<>(conns.keySet())) if (!keep.contains(id)) { conns.remove(id).stop(); }
    }

    /** This account's session ended (signed out elsewhere): stop listening for it. */
    private void drop(String id) {
        main.post(() -> {
            try {
                JSONObject cfg = config();
                JSONArray list = cfg.optJSONArray("accounts");
                JSONArray left = new JSONArray();
                if (list != null) for (int i = 0; i < list.length(); i++) if (!id.equals(list.optJSONObject(i).optString("id"))) left.put(list.optJSONObject(i));
                cfg.put("accounts", left);
                saveConfig(this, cfg);
            } catch (Throwable ignored) { }
            sync();
        });
    }

    private boolean fresh(String messageId) {
        SharedPreferences p = prefs(this);
        synchronized (PushService.class) {
            try {
                JSONArray seen = new JSONArray(p.getString(SEEN, "[]"));
                for (int i = 0; i < seen.length(); i++) if (messageId.equals(seen.optString(i))) return false;
                JSONArray next = new JSONArray();
                int from = Math.max(0, seen.length() - 400);
                for (int i = from; i < seen.length(); i++) next.put(seen.optString(i));
                next.put(messageId);
                p.edit().putString(SEEN, next.toString()).apply();
            } catch (Throwable t) { return true; }
        }
        return true;
    }

    private final class Conn extends WebSocketListener {
        final String id, token, base;
        volatile String label, mode;
        private WebSocket ws;
        private boolean stopped = false;
        private int attempt = 0;

        Conn(String id, String token, String label, String base, String mode) { this.id = id; this.token = token; this.label = label; this.base = base; this.mode = mode; }

        void start() {
            if (stopped) return;
            Request r = new Request.Builder().url(base.replaceFirst("^http", "ws") + "/v1/ws").header("Sec-WebSocket-Protocol", token).build();
            ws = http.newWebSocket(r, this);
        }

        void stop() { stopped = true; if (ws != null) ws.cancel(); }

        private void retry() {
            if (stopped) return;
            long wait = Math.min(60_000L, 1000L << Math.min(attempt++, 6));
            main.postDelayed(this::start, wait);
        }

        @Override public void onOpen(WebSocket w, Response r) { attempt = 0; }

        @Override
        public void onMessage(WebSocket w, String text) {
            try {
                JSONObject f = new JSONObject(text);
                if (!"message".equals(f.optString("type"))) return;
                JSONObject m = f.optJSONObject("message");
                if (m == null || id.equals(m.optString("from"))) return;
                String mid = m.optString("id");
                if (mid.isEmpty() || !fresh(mid)) return;
                if (appVisible) return; // the page shows it
                main.post(() -> show(conns.size() > 1 ? label : "", mode));
            } catch (Throwable ignored) { }
        }

        @Override
        public void onClosing(WebSocket w, int code, String reason) { w.close(code, null); }

        @Override
        public void onClosed(WebSocket w, int code, String reason) {
            if (code == 4002) { stopped = true; drop(id); } else retry();
        }

        @Override
        public void onFailure(WebSocket w, Throwable t, Response r) {
            if (r != null && r.code() == 401) { stopped = true; drop(id); } else retry();
        }
    }
}
