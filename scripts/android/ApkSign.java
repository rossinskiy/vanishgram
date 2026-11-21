// Signs an APK with v2/v3 signatures using Google's apksig library (the engine behind apksigner).
//   java -cp apksig.jar ApkSign.java <keystore.p12> <alias> <in.apk> <out.apk>   (password in the VG_KEYSTORE_PASSWORD environment variable)
import com.android.apksig.ApkSigner;
import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.List;

public class ApkSign {
    public static void main(String[] a) throws Exception {
        char[] pw = System.getenv("VG_KEYSTORE_PASSWORD").toCharArray();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (FileInputStream in = new FileInputStream(a[0])) { ks.load(in, pw); }
        PrivateKey key = (PrivateKey) ks.getKey(a[1], pw);
        X509Certificate cert = (X509Certificate) ks.getCertificate(a[1]);
        ApkSigner.SignerConfig cfg = new ApkSigner.SignerConfig.Builder("vanishgram", key, List.of(cert)).build();
        new ApkSigner.Builder(List.of(cfg)).setInputApk(new File(a[2])).setOutputApk(new File(a[3]))
            .setMinSdkVersion(24).setV1SigningEnabled(false).setV2SigningEnabled(true).setV3SigningEnabled(true).build().sign();
    }
}
