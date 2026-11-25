package com.toby.satranc;

import android.content.res.AssetManager;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

@CapacitorPlugin(name = "TobyOffline")
public class TobyOfflinePlugin extends Plugin {
    private static final String MODEL_DIR = "toby-models";
    private static final String BODY_FILE = "toby2_b.body.int8.onnx";
    private static final String HEADS_FILE = "toby2_b.heads.int8.onnx";
    private static final String LEVEL_FILE = "toby2_level.int8.onnx";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private OrtEnvironment env;
    private OrtSession bodySession;
    private OrtSession headsSession;
    private OrtSession levelSession;
    private volatile boolean initialized = false;

    private File ensureAssetCopied(String assetName) throws IOException {
        File dir = new File(getContext().getFilesDir(), MODEL_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Model klasörü oluşturulamadı: " + dir.getAbsolutePath());
        }
        File outFile = new File(dir, assetName);
        if (outFile.exists() && outFile.length() > 1024) {
            return outFile;
        }
        AssetManager am = getContext().getAssets();
        try (InputStream in = am.open(MODEL_DIR + "/" + assetName);
             FileOutputStream out = new FileOutputStream(outFile)) {
            byte[] buf = new byte[262144];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
        return outFile;
    }

    private synchronized void ensureInitialized() throws IOException, OrtException {
        if (initialized) return;
        File bodyFile = ensureAssetCopied(BODY_FILE);
        File headsFile = ensureAssetCopied(HEADS_FILE);
        File levelFile = ensureAssetCopied(LEVEL_FILE);

        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors()));
        opts.setIntraOpNumThreads(threads);
        opts.setInterOpNumThreads(1);
        opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);

        bodySession = env.createSession(bodyFile.getAbsolutePath(), opts);
        headsSession = env.createSession(headsFile.getAbsolutePath(), opts);
        levelSession = env.createSession(levelFile.getAbsolutePath(), opts);
        initialized = true;
    }

    private static float[] decodeFloatB64(String b64) {
        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        FloatBuffer fb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
        float[] out = new float[fb.remaining()];
        fb.get(out);
        return out;
    }

    private static float[] jsArrayToFloat(JSArray arr) throws JSONException {
        float[] out = new float[arr.length()];
        for (int i = 0; i < arr.length(); i++) {
            out[i] = (float) arr.getDouble(i);
        }
        return out;
    }

    private static long[] jsArrayToLong(JSArray arr) throws JSONException {
        long[] out = new long[arr.length()];
        for (int i = 0; i < arr.length(); i++) {
            out[i] = arr.getLong(i);
        }
        return out;
    }

    private float[] runBodyRaw(float[] planes, float[] extra) throws OrtException {
        try (OnnxTensor tPlanes = OnnxTensor.createTensor(env, FloatBuffer.wrap(planes), new long[]{1, 112, 8, 8});
             OnnxTensor tExtra = OnnxTensor.createTensor(env, FloatBuffer.wrap(extra), new long[]{1, 36})) {
            Map<String, OnnxTensor> inputs = new HashMap<>();
            inputs.put("planes", tPlanes);
            inputs.put("extra", tExtra);
            try (OrtSession.Result res = bodySession.run(inputs)) {
                float[][][] x3 = (float[][][]) res.get(0).getValue();
                float[] flat = new float[64 * 1024];
                for (int sq = 0; sq < 64; sq++) {
                    System.arraycopy(x3[0][sq], 0, flat, sq * 1024, 1024);
                }
                return flat;
            }
        }
    }

    private static class HeadsOut {
        float[] logits;
        float[] wdl;
    }

    private HeadsOut runHeadsRaw(float[] xFlat, long[] idx, long[] sqf, long[] sqt, float[] fr, float[] summ) throws OrtException {
        int L = idx.length;
        try (OnnxTensor tX = OnnxTensor.createTensor(env, FloatBuffer.wrap(xFlat), new long[]{1, 64, 1024});
             OnnxTensor tIdx = OnnxTensor.createTensor(env, LongBuffer.wrap(idx), new long[]{L});
             OnnxTensor tSqf = OnnxTensor.createTensor(env, LongBuffer.wrap(sqf), new long[]{L});
             OnnxTensor tSqt = OnnxTensor.createTensor(env, LongBuffer.wrap(sqt), new long[]{L});
             OnnxTensor tFr = OnnxTensor.createTensor(env, FloatBuffer.wrap(fr), new long[]{L, 31});
             OnnxTensor tSumm = OnnxTensor.createTensor(env, FloatBuffer.wrap(summ), new long[]{1, 6})) {
            Map<String, OnnxTensor> inputs = new HashMap<>();
            inputs.put("x", tX);
            inputs.put("idx", tIdx);
            inputs.put("sqf", tSqf);
            inputs.put("sqt", tSqt);
            inputs.put("fr", tFr);
            inputs.put("summ", tSumm);
            try (OrtSession.Result res = headsSession.run(inputs)) {
                HeadsOut out = new HeadsOut();
                out.logits = (float[]) res.get(0).getValue();
                float[][] wdl2 = (float[][]) res.get(1).getValue();
                out.wdl = wdl2[0];
                return out;
            }
        }
    }

    @PluginMethod
    public void initModels(PluginCall call) {
        executor.execute(() -> {
            try {
                long t0 = System.currentTimeMillis();
                ensureInitialized();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("version", "2.0-offline");
                ret.put("loadMs", System.currentTimeMillis() - t0);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Toby offline motor başlatılamadı: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void runPosition(PluginCall call) {
        executor.execute(() -> {
            try {
                ensureInitialized();
                long t0 = System.currentTimeMillis();

                float[] planes = decodeFloatB64(call.getString("planesB64"));
                float[] extra = jsArrayToFloat(call.getArray("extra"));
                long[] idx = jsArrayToLong(call.getArray("idx"));
                long[] sqf = jsArrayToLong(call.getArray("sqf"));
                long[] sqt = jsArrayToLong(call.getArray("sqt"));
                float[] fr = decodeFloatB64(call.getString("frB64"));
                float[] summ = jsArrayToFloat(call.getArray("summ"));

                float[] xFlat = runBodyRaw(planes, extra);
                HeadsOut ho = runHeadsRaw(xFlat, idx, sqf, sqt, fr, summ);

                JSArray logitsArr = new JSArray();
                for (float v : ho.logits) logitsArr.put(v);
                JSArray wdlArr = new JSArray();
                for (float v : ho.wdl) wdlArr.put(v);

                JSObject ret = new JSObject();
                ret.put("logits", logitsArr);
                ret.put("wdl", wdlArr);
                ret.put("elapsedMs", System.currentTimeMillis() - t0);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Toby pozisyon analizi hatası: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void runLevelStep(PluginCall call) {
        executor.execute(() -> {
            try {
                ensureInitialized();
                long t0 = System.currentTimeMillis();

                float[] planes = decodeFloatB64(call.getString("planesB64"));
                float[] extra0 = jsArrayToFloat(call.getArray("extra0"));
                float[] extra1 = jsArrayToFloat(call.getArray("extra1"));
                long[] idx = jsArrayToLong(call.getArray("idx"));
                long[] sqf = jsArrayToLong(call.getArray("sqf"));
                long[] sqt = jsArrayToLong(call.getArray("sqt"));
                float[] fr0 = decodeFloatB64(call.getString("fr0B64"));
                float[] fr1 = decodeFloatB64(call.getString("fr1B64"));
                float[] summ = jsArrayToFloat(call.getArray("summ"));
                float[] rbfAll = decodeFloatB64(call.getString("rbfAllB64")); // (K + 1) * 12
                int K = call.getInt("k", 37);
                int playedIndex = call.getInt("playedIndex", 0);

                int L = idx.length;
                float[] x0 = runBodyRaw(planes, extra0);
                HeadsOut h0 = runHeadsRaw(x0, idx, sqf, sqt, fr0, summ);
                float[] x1 = runBodyRaw(planes, extra1);
                HeadsOut h1 = runHeadsRaw(x1, idx, sqf, sqt, fr1, summ);

                // Assemble level head inputs: base (1, L, 2), xf (1, L, 2048), xt (1, L, 2048), xm (1, 2048)
                float[] base = new float[L * 2];
                float[] xf = new float[L * 2048];
                float[] xt = new float[L * 2048];
                float[] xm = new float[2048];

                for (int sq = 0; sq < 64; sq++) {
                    int off = sq * 1024;
                    for (int c = 0; c < 1024; c++) {
                        xm[c] += x0[off + c];
                        xm[1024 + c] += x1[off + c];
                    }
                }
                for (int c = 0; c < 2048; c++) xm[c] /= 64.0f;

                for (int m = 0; m < L; m++) {
                    base[m * 2] = h0.logits[m];
                    base[m * 2 + 1] = h1.logits[m];
                    int sf = (int) sqf[m];
                    int st = (int) sqt[m];
                    System.arraycopy(x0, sf * 1024, xf, m * 2048, 1024);
                    System.arraycopy(x1, sf * 1024, xf, m * 2048 + 1024, 1024);
                    System.arraycopy(x0, st * 1024, xt, m * 2048, 1024);
                    System.arraycopy(x1, st * 1024, xt, m * 2048 + 1024, 1024);
                }

                int totalK = K + 1; // K grid points + 1 dist rating
                float[][][] outLogits;
                try (OnnxTensor tBase = OnnxTensor.createTensor(env, FloatBuffer.wrap(base), new long[]{1, L, 2});
                     OnnxTensor tXf = OnnxTensor.createTensor(env, FloatBuffer.wrap(xf), new long[]{1, L, 2048});
                     OnnxTensor tXt = OnnxTensor.createTensor(env, FloatBuffer.wrap(xt), new long[]{1, L, 2048});
                     OnnxTensor tXm = OnnxTensor.createTensor(env, FloatBuffer.wrap(xm), new long[]{1, 2048});
                     OnnxTensor tRbf = OnnxTensor.createTensor(env, FloatBuffer.wrap(rbfAll), new long[]{1, totalK, 12})) {
                    Map<String, OnnxTensor> inputs = new HashMap<>();
                    inputs.put("base", tBase);
                    inputs.put("xf", tXf);
                    inputs.put("xt", tXt);
                    inputs.put("xm", tXm);
                    inputs.put("rbf", tRbf);
                    try (OrtSession.Result res = levelSession.run(inputs)) {
                        outLogits = (float[][][]) res.get(0).getValue(); // (1, K+1, L)
                    }
                }

                // Compute log-likelihood curve for playedIndex across K grid points
                JSArray curveArr = new JSArray();
                for (int k = 0; k < K; k++) {
                    float[] row = outLogits[0][k];
                    float maxV = Float.NEGATIVE_INFINITY;
                    for (float v : row) if (v > maxV) maxV = v;
                    double sumExp = 0.0;
                    for (float v : row) sumExp += Math.exp(v - maxV);
                    double logProb = (row[playedIndex] - maxV) - Math.log(sumExp);
                    curveArr.put(logProb);
                }

                // Compute softmax probability distribution at row K (dist rating)
                float[] distRow = outLogits[0][K];
                float maxD = Float.NEGATIVE_INFINITY;
                for (float v : distRow) if (v > maxD) maxD = v;
                double sumD = 0.0;
                double[] probs = new double[L];
                for (int m = 0; m < L; m++) {
                    probs[m] = Math.exp(distRow[m] - maxD);
                    sumD += probs[m];
                }
                JSArray distArr = new JSArray();
                for (int m = 0; m < L; m++) {
                    distArr.put(probs[m] / sumD);
                }

                JSObject ret = new JSObject();
                ret.put("curve", curveArr);
                ret.put("distProbs", distArr);
                ret.put("elapsedMs", System.currentTimeMillis() - t0);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Toby seviye tahmini hatası: " + e.getMessage(), e);
            }
        });
    }
}
