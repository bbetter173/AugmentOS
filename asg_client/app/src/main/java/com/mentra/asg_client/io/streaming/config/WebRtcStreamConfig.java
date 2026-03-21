package com.mentra.asg_client.io.streaming.config;

/**
 * Configuration class for WebRTC / WHIP streaming parameters.
 * Mirrors RtmpStreamConfig for a consistent interface.
 */
public class WebRtcStreamConfig {

    public static final int DEFAULT_VIDEO_WIDTH = 1280;
    public static final int DEFAULT_VIDEO_HEIGHT = 720;
    public static final int DEFAULT_VIDEO_FPS = 30;
    public static final int DEFAULT_VIDEO_BITRATE = 2000000; // 2 Mbps

    public static final boolean DEFAULT_ECHO_CANCELLATION = false;
    public static final boolean DEFAULT_NOISE_SUPPRESSION = false;

    // Default STUN server (Google's public STUN)
    public static final String DEFAULT_STUN_SERVER = "stun:stun.l.google.com:19302";

    private int videoWidth = DEFAULT_VIDEO_WIDTH;
    private int videoHeight = DEFAULT_VIDEO_HEIGHT;
    private int videoFps = DEFAULT_VIDEO_FPS;
    private int videoBitrate = DEFAULT_VIDEO_BITRATE;

    private boolean echoCancellation = DEFAULT_ECHO_CANCELLATION;
    private boolean noiseSuppression = DEFAULT_NOISE_SUPPRESSION;

    private String stunServer = DEFAULT_STUN_SERVER;

    public WebRtcStreamConfig() {}

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    // Getters
    public int getVideoWidth() { return videoWidth; }
    public int getVideoHeight() { return videoHeight; }
    public int getVideoFps() { return videoFps; }
    public int getVideoBitrate() { return videoBitrate; }
    public boolean isEchoCancellation() { return echoCancellation; }
    public boolean isNoiseSuppression() { return noiseSuppression; }
    public String getStunServer() { return stunServer; }

    // Setters with validation (fluent API)
    public WebRtcStreamConfig setVideoWidth(int width) {
        this.videoWidth = clamp(width, 320, 1920);
        return this;
    }

    public WebRtcStreamConfig setVideoHeight(int height) {
        this.videoHeight = clamp(height, 240, 1080);
        return this;
    }

    public WebRtcStreamConfig setVideoFps(int fps) {
        this.videoFps = clamp(fps, 10, 60);
        return this;
    }

    public WebRtcStreamConfig setVideoBitrate(int bitrate) {
        this.videoBitrate = clamp(bitrate, 100000, 10000000);
        return this;
    }

    public WebRtcStreamConfig setEchoCancellation(boolean enabled) {
        this.echoCancellation = enabled;
        return this;
    }

    public WebRtcStreamConfig setNoiseSuppression(boolean enabled) {
        this.noiseSuppression = enabled;
        return this;
    }

    public WebRtcStreamConfig setStunServer(String stunServer) {
        this.stunServer = stunServer;
        return this;
    }

    @Override
    public String toString() {
        return "WebRtcStreamConfig{"
                + "video=" + videoWidth + "x" + videoHeight + "@" + videoFps + "fps, "
                + (videoBitrate / 1000) + "kbps"
                + ", echo=" + echoCancellation
                + ", noise=" + noiseSuppression
                + ", stun=" + stunServer
                + '}';
    }
}
