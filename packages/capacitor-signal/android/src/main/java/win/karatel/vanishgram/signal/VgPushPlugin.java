package win.karatel.vanishgram.signal;

import android.Manifest;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/** Background message notifications for the Android app: the page hands over the signed-in sessions, a service listens. */
@CapacitorPlugin(name = "VgPush", permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") })
public class VgPushPlugin extends Plugin {
    private boolean granted() {
        return Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (granted()) { done(call); return; }
        requestPermissionForAlias("notifications", call, "afterPermission");
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) { done(call); }

    private void done(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted());
        call.resolve(r);
    }

    /** { base, mode, accounts: [{ id, label, token }] } */
    @PluginMethod
    public void start(PluginCall call) {
        try {
            Context c = getContext();
            JSONArray accounts = call.getArray("accounts", new com.getcapacitor.JSArray());
            if (accounts.length() == 0) { stopAll(c); call.resolve(); return; }
            JSONObject cfg = new JSONObject();
            cfg.put("base", call.getString("base", ""));
            cfg.put("mode", call.getString("mode", "hidden"));
            cfg.put("accounts", accounts);
            PushService.saveConfig(c, cfg);
            PushService.start(c);
            PushService.reload();
            call.resolve();
        } catch (Throwable t) {
            call.reject(t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopAll(getContext());
        call.resolve();
    }

    private void stopAll(Context c) {
        PushService.clearConfig(c);
        PushService.stop(c);
    }

    @Override
    protected void handleOnResume() { PushService.onAppVisible(getContext(), true); }

    @Override
    protected void handleOnPause() { PushService.onAppVisible(getContext(), false); }

}
