package win.karatel.vanishgram.signal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the message listener after a reboot or an app update, if notifications were turned on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            if (PushService.hasConfig(ctx)) PushService.start(ctx);
        } catch (Throwable ignored) {
            // the system may refuse a background start; the next time the app opens it starts again
        }
    }
}
