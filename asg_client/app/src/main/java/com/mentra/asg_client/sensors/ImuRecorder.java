package com.mentra.asg_client.sensors;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;

/**
 * Records IMU (accelerometer + gyroscope) data during photo/video capture.
 * Writes a sidecar JSON file alongside the media file for phone-side
 * post-processing (e.g., gyro-based video stabilization).
 *
 * <p>Sampling at ~100Hz, captures timestamp + accel[3] + gyro[3] per sample.
 *
 * <h3>Threading</h3>
 * Sensor callbacks are delivered on a dedicated {@link HandlerThread} owned by this recorder, NOT
 * the thread that calls {@link #startRecording()}. This matters: the camera pipeline calls
 * {@code startRecording()} from a background {@code HandlerThread} that has a Looper but never
 * pumps sensor events, and the no-Handler {@code registerListener} overload posts to the
 * <em>main</em> looper. Registering against our own handler guarantees delivery regardless of the
 * caller's thread (the previous code silently captured zero samples on longer video recordings —
 * registration succeeded but no {@code onSensorChanged} ever fired).
 *
 * <h3>Crash safety</h3>
 * Samples are streamed to a {@code imu.jsonl.partial} file as they arrive rather than buffered in
 * memory and written only at stop. A non-graceful termination (process kill, MediaRecorder.stop()
 * throw) therefore leaves the captured samples on disk for recovery instead of losing the whole
 * track. At graceful stop the partial is assembled into the canonical {@code imu.json} object.
 */
public class ImuRecorder implements SensorEventListener {
  private static final String TAG = "ImuRecorder";
  private static final int SAMPLING_PERIOD_US = 10000; // 100Hz
  private static final String PARTIAL_NAME = "imu.jsonl.partial";
  private static final String SIDECAR_NAME = "imu.json";

  private final SensorManager mSensorManager;
  private final Sensor mAccelerometer;
  private final Sensor mGyroscope;

  // Dedicated thread so sensor callbacks are delivered independently of the caller's thread.
  private final HandlerThread mSensorThread;
  private final Handler mSensorHandler;

  private volatile boolean mRecording = false;
  // Baseline for the zero-based relative sample times in the JSON. Set lazily from the FIRST sensor
  // event's timestamp so the math stays within a single clock domain — SensorEvent.timestamp is
  // elapsedRealtimeNanos (time since boot), NOT System.nanoTime(); mixing them previously produced a
  // bogus multi-hundred-second durationMs and a large constant per-sample offset. -1 = unset.
  private long mBaseTimestampNs = -1;
  // Absolute capture anchor in the elapsedRealtimeNanos clock, captured at startRecording(). This is
  // the SAME clock Android's camera2 reports in SENSOR_TIMESTAMP when SENSOR_INFO_TIMESTAMP_SOURCE is
  // REALTIME. Recording it lets the phone correlate IMU samples to video frames to sub-ms once the
  // MTK HAL advertises REALTIME frame timestamps. Today the camera reports UNKNOWN, so this is the
  // forward-compatible anchor — the IMU side is already on the correct clock and needs no rework.
  private long mStartElapsedRealtimeNs = 0;

  // Latest values (updated independently by each sensor). Touched only on the sensor thread.
  private final float[] mLatestAccel = new float[3];
  private final float[] mLatestGyro = new float[3];

  // Streaming sink for the in-progress capture. Touched only on the sensor thread.
  private BufferedWriter mStreamWriter;
  private File mPartialFile;
  private File mTargetDir;
  private int mSampleCount;

  public ImuRecorder(Context context) {
    mSensorManager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
    mAccelerometer = mSensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    mGyroscope = mSensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);

    if (mAccelerometer == null) {
      Log.w(TAG, "Accelerometer not available");
    }
    if (mGyroscope == null) {
      Log.w(TAG, "Gyroscope not available");
    }

    mSensorThread = new HandlerThread("ImuRecorder");
    mSensorThread.start();
    mSensorHandler = new Handler(mSensorThread.getLooper());
  }

  /**
   * Start recording IMU data. Call this when photo/video capture begins.
   *
   * @param mediaFilePath Path to the media file being captured; the sidecar is written next to it.
   *     The parent directory must already exist (the media file lives there).
   */
  public void startRecording(String mediaFilePath) {
    if (mRecording) {
      Log.w(TAG, "Already recording");
      return;
    }

    File parentDir = new File(mediaFilePath).getParentFile();
    if (parentDir == null) {
      Log.w(TAG, "Cannot resolve capture directory for " + mediaFilePath + "; IMU not recorded");
      return;
    }

    mTargetDir = parentDir;
    mPartialFile = new File(parentDir, PARTIAL_NAME);
    mSampleCount = 0;
    mBaseTimestampNs = -1; // baselined off the first event below
    mStartElapsedRealtimeNs = SystemClock.elapsedRealtimeNanos();

    try {
      mStreamWriter = new BufferedWriter(new FileWriter(mPartialFile, false));
    } catch (IOException e) {
      Log.e(TAG, "Failed to open IMU stream file", e);
      mStreamWriter = null;
      return;
    }

    mRecording = true;

    if (mAccelerometer != null) {
      mSensorManager.registerListener(this, mAccelerometer, SAMPLING_PERIOD_US, mSensorHandler);
    }
    if (mGyroscope != null) {
      mSensorManager.registerListener(this, mGyroscope, SAMPLING_PERIOD_US, mSensorHandler);
    }

    Log.d(TAG, "IMU recording started (streaming to " + mPartialFile.getAbsolutePath() + ")");
  }

  /**
   * Stop recording and assemble the sidecar JSON file from the streamed samples.
   *
   * @param mediaFilePath Path to the media file (e.g., IMG_xxx.jpg or VID_xxx.mp4)
   * @return Path to the sidecar JSON file, or null on failure
   */
  public String stopRecordingAndSave(String mediaFilePath) {
    mRecording = false;
    mSensorManager.unregisterListener(this);

    // Flush + close the stream on the sensor thread so it can't race with a late onSensorChanged,
    // then continue assembly on the caller's thread once the sink is quiesced.
    flushAndCloseStreamSync();

    File parentDir = new File(mediaFilePath).getParentFile();
    File partial = new File(parentDir, PARTIAL_NAME);
    if (!partial.exists()) {
      Log.w(TAG, "No IMU samples captured");
      return null;
    }

    String sidecarPath = new File(parentDir, SIDECAR_NAME).getAbsolutePath();
    try {
      int written = assembleSidecar(partial, new File(sidecarPath));
      if (written == 0) {
        Log.w(TAG, "No IMU samples captured");
        partial.delete();
        return null;
      }
      partial.delete();
      Log.d(TAG, "IMU sidecar written: " + sidecarPath + " (" + written + " samples)");
      return sidecarPath;
    } catch (JSONException | IOException e) {
      // Leave the partial in place — it still holds the raw samples for later recovery.
      Log.e(TAG, "Failed to assemble IMU sidecar; partial retained at " + partial.getAbsolutePath(), e);
      return null;
    }
  }

  /** Cancel recording without saving; discards the partial stream. */
  public void cancel() {
    mRecording = false;
    mSensorManager.unregisterListener(this);
    flushAndCloseStreamSync();
    if (mPartialFile != null && mPartialFile.exists()) {
      mPartialFile.delete();
    }
  }

  /** Release the sensor thread. Call when the recorder is no longer needed. */
  public void release() {
    cancel();
    mSensorThread.quitSafely();
  }

  @Override
  public void onSensorChanged(SensorEvent event) {
    // Runs on mSensorThread.
    if (!mRecording) return;

    switch (event.sensor.getType()) {
      case Sensor.TYPE_ACCELEROMETER:
        System.arraycopy(event.values, 0, mLatestAccel, 0, 3);
        // Accel drives the sampling rate: emit one combined sample per accel event.
        writeSampleLine(event.timestamp);
        break;
      case Sensor.TYPE_GYROSCOPE:
        System.arraycopy(event.values, 0, mLatestGyro, 0, 3);
        break;
      default:
        break;
    }
  }

  @Override
  public void onAccuracyChanged(Sensor sensor, int accuracy) {
    // Not needed
  }

  /** Append one compact sample line: [relativeTimeMs, ax, ay, az, gx, gy, gz]. Sensor thread only. */
  private void writeSampleLine(long timestampNs) {
    if (mStreamWriter == null) return;
    if (mBaseTimestampNs < 0) {
      // First event seen: this becomes t=0 so relative times start at ~0 within the event clock.
      mBaseTimestampNs = timestampNs;
    }
    try {
      JSONArray sample = new JSONArray();
      sample.put(Math.round((timestampNs - mBaseTimestampNs) / 1_000_000.0));
      sample.put(round4(mLatestAccel[0]));
      sample.put(round4(mLatestAccel[1]));
      sample.put(round4(mLatestAccel[2]));
      sample.put(round4(mLatestGyro[0]));
      sample.put(round4(mLatestGyro[1]));
      sample.put(round4(mLatestGyro[2]));
      mStreamWriter.write(sample.toString());
      mStreamWriter.write('\n');
      mSampleCount++;
    } catch (IOException | JSONException e) {
      Log.e(TAG, "Failed to write IMU sample", e);
    }
  }

  /** Quiesce the sensor sink: run flush+close on the sensor thread and block until done. */
  private void flushAndCloseStreamSync() {
    final Object lock = new Object();
    final boolean[] done = {false};
    boolean posted = mSensorHandler.post(() -> {
      closeStreamOnSensorThread();
      synchronized (lock) {
        done[0] = true;
        lock.notifyAll();
      }
    });
    if (!posted) {
      // Looper already gone; close inline as a best effort.
      closeStreamOnSensorThread();
      return;
    }
    synchronized (lock) {
      while (!done[0]) {
        try {
          lock.wait();
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          return;
        }
      }
    }
  }

  private void closeStreamOnSensorThread() {
    if (mStreamWriter == null) return;
    try {
      mStreamWriter.flush();
      mStreamWriter.close();
    } catch (IOException e) {
      Log.e(TAG, "Failed to close IMU stream", e);
    } finally {
      mStreamWriter = null;
    }
  }

  /**
   * Read the streamed JSONL partial and write the canonical {@code imu.json} object. Keeps the
   * exact same on-disk schema the previous in-memory implementation produced.
   *
   * @return number of samples written.
   */
  private int assembleSidecar(File partial, File sidecar) throws IOException, JSONException {
    JSONArray samples = new JSONArray();
    long lastRelMs = 0;
    try (BufferedReader reader = new BufferedReader(new FileReader(partial))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.isEmpty()) continue;
        JSONArray sample = new JSONArray(line);
        lastRelMs = sample.getLong(0);
        samples.put(sample);
      }
    }

    if (samples.length() == 0) {
      return 0;
    }

    JSONObject root = new JSONObject();
    root.put("version", 2);
    root.put("sampleCount", samples.length());
    root.put("samplingRateHz", 100);
    // clockSource documents the time base of the absolute timestamps below: Android's
    // elapsedRealtimeNanos (boot-monotonic). This is the clock camera2 SENSOR_TIMESTAMP uses when
    // the camera advertises SENSOR_INFO_TIMESTAMP_SOURCE = REALTIME, enabling IMU↔video correlation.
    root.put("clockSource", "elapsedRealtimeNanos");
    // Absolute elapsedRealtimeNanos of each sample's relative t=0 (the first sensor event).
    // sampleAbsoluteNs = startTimeNs + relativeMs * 1_000_000.
    root.put("startTimeNs", mBaseTimestampNs);
    // Absolute elapsedRealtimeNanos captured at startRecording() (≈ MediaRecorder.start()), before
    // the first sensor event arrived. Lets the consumer bound the IMU window against video start.
    root.put("recordingStartElapsedRealtimeNs", mStartElapsedRealtimeNs);
    root.put("durationMs", lastRelMs);
    root.put("samples", samples);

    try (FileWriter writer = new FileWriter(sidecar)) {
      writer.write(root.toString());
    }
    return samples.length();
  }

  private static double round4(float v) {
    return Math.round(v * 10000.0) / 10000.0;
  }
}
