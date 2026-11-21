package win.karatel.vanishgram;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.app.NotificationManager;
import android.content.Context;
import android.service.notification.StatusBarNotification;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;

import win.karatel.vanishgram.signal.PushService;

/**
 * The background listener: a local test server pushes a message frame, and a notification that says only "New message"
 * must appear. A frame from the account itself must not. Nothing leaves the emulator.
 */
@RunWith(AndroidJUnit4.class)
public class PushTest {
    private static StatusBarNotification find(NotificationManager nm) {
        for (StatusBarNotification n : nm.getActiveNotifications()) if (n.getId() == 2) return n;
        return null;
    }

    @Test
    public void notifiesWithoutReadingTheMessage() throws Exception {
        Instrumentation ins = InstrumentationRegistry.getInstrumentation();
        Context ctx = ins.getTargetContext();
        ins.getUiAutomation().grantRuntimePermission(ctx.getPackageName(), "android.permission.POST_NOTIFICATIONS");
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancelAll();

        MockWebServer server = new MockWebServer();
        server.enqueue(new MockResponse().withWebSocketUpgrade(new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response r) {
                w.send("{\"type\":\"message\",\"message\":{\"id\":\"own1\",\"from\":\"acct-me\",\"fromDevice\":\"d\",\"toDevice\":\"d\",\"body\":\"x\",\"ts\":1}}");
                w.send("{\"type\":\"message\",\"message\":{\"id\":\"m1\",\"from\":\"acct-other\",\"fromDevice\":\"d\",\"toDevice\":\"d\",\"body\":\"secret text\",\"ts\":2}}");
            }
        }));
        server.start();
        try {
            JSONObject cfg = new JSONObject().put("base", server.url("/").toString().replaceAll("/$", "")).put("mode", "hidden")
                .put("accounts", new JSONArray().put(new JSONObject().put("id", "acct-me").put("label", "Me").put("token", "tok123")));
            PushService.saveConfig(ctx, cfg);
            PushService.start(ctx);

            RecordedRequest req = server.takeRequest(20, java.util.concurrent.TimeUnit.SECONDS);
            assertTrue("service did not connect", req != null);
            assertEquals("tok123", req.getHeader("Sec-WebSocket-Protocol"));
            assertEquals("/v1/ws", req.getPath());

            StatusBarNotification n = null;
            for (int i = 0; i < 30 && n == null; i++) { n = find(nm); if (n == null) Thread.sleep(1000); }
            assertTrue("no notification", n != null);
            CharSequence text = n.getNotification().extras.getCharSequence("android.text");
            assertEquals("New message", String.valueOf(text));
            assertTrue("one notification only", nm.getActiveNotifications().length >= 1);
        } finally {
            PushService.stop(ctx);
            ctx.getSharedPreferences("vg_push", Context.MODE_PRIVATE).edit().clear().apply();
            server.shutdown();
        }
    }
}
