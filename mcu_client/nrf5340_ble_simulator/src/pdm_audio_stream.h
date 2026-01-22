/*
 * Copyright (c) 2025 Mentra
 *
 * SPDX-License-Identifier: Apache-2.0
 * 
 * PDM Audio Stream Module
 * 
 * Provides microphone input capture via PDM and LC3 audio streaming 
 * to mobile app via BLE protobuf messages.
 * 
 * HARDWARE CONFIGURATION:
 * - PDM_CLK: P1.12 (nRF5340 PDM Clock Output)  
 * - PDM_DIN: P1.11 (nRF5340 PDM Data Input)
 * - Microphone: Dual MSM261DCB002 digital PDM microphones connected to P1.11/P1.12
 * 
 * AUDIO SPECIFICATIONS:
 * - Sample Rate: 16 kHz (optimized for voice)
 * - Bit Depth: 16-bit PCM
 * - Channels: Mono (single microphone)
 * - Frame Size: 160 samples (10ms @ 16kHz)
 * 
 * LC3 STREAMING:
 * - Codec: LC3 (Low Complexity Communication Codec)
 * - Frame Duration: 10ms
 * - Bitrate: Configurable (default optimized for voice)
 * - Transport: BLE via protobuf 0xA0 audio chunk messages
 * 
 * INTEGRATION:
 * - MicStateConfig (Tag 20): Enable/disable microphone streaming
 * - Audio Chunk (0xA0): Stream LC3-encoded audio data to mobile app
 * - Real-time streaming with minimal latency
 */

#ifndef PDM_AUDIO_STREAM_H
#define PDM_AUDIO_STREAM_H

#include <stdint.h>
#include <stdbool.h>

#include "mos_components/mos_pdm/include/mos_pdm.h"

/* Audio configuration constants */
#define PDM_SAMPLE_RATE         16000    // 16 kHz voice optimized
#define PDM_BIT_DEPTH           16       // PCM bit depth, measured in bits
#define PDM_CHANNELS            1        // Mono microphone input
#define PDM_FRAME_SIZE_SAMPLES  160      // 10ms frame @ 16kHz
#define PDM_FRAME_SIZE_BYTES    (PDM_FRAME_SIZE_SAMPLES * 2)  // 16-bit samples

/* LC3 encoding configuration */
#define LC3_FRAME_DURATION_US   10000    // 10ms frame duration
#define LC3_MAX_ENCODED_SIZE    100      // Maximum LC3 encoded frame size
#define LC3_BITRATE_DEFAULT     32000    // 32 kbps default bitrate
#define LC3_FRAME_LEN           (LC3_BITRATE_DEFAULT * LC3_FRAME_DURATION_US / 8 / 1000000)

/* Audio streaming state */
typedef enum {
    PDM_AUDIO_STATE_DISABLED = 0,
    PDM_AUDIO_STATE_ENABLED = 1,
    PDM_AUDIO_STATE_STREAMING = 2,
    PDM_AUDIO_STATE_ERROR = 3
} pdm_audio_state_t;

/**
 * @brief Initialize PDM audio streaming system
 * 
 * Sets up PDM driver, LC3 encoder, and audio processing thread.
 * Must be called before any other PDM audio functions.
 * 
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_stream_init(void);

/**
 * @brief Enable/disable microphone audio streaming
 * 
 * Controls microphone capture and LC3 streaming to mobile app.
 * Called in response to MicStateConfig protobuf messages (Tag 20).
 * 
 * @param enabled true to start streaming, false to stop
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_stream_set_enabled(bool enabled);

/**
 * @brief Get current audio streaming state
 * 
 * @return Current streaming state
 */
pdm_audio_state_t pdm_audio_stream_get_state(void);

/**
 * @brief Get current audio streaming statistics
 * 
 * Provides debugging information about streaming performance.
 * 
 * @param frames_captured Output: Number of audio frames captured
 * @param frames_encoded Output: Number of frames successfully LC3 encoded  
 * @param frames_transmitted Output: Number of frames sent via BLE
 * @param errors Output: Number of streaming errors encountered
 */
void pdm_audio_stream_get_stats(uint32_t *frames_captured, uint32_t *frames_encoded,
                                uint32_t *frames_transmitted, uint32_t *errors);

/**
 * @brief Enable/disable I2S audio output (loopback playback)
 * 启用/禁用I2S音频输出（环回播放）
 * 
 * @param enabled true to enable I2S playback, false to disable
 * @return 0 on success, negative error code on failure
 */
int pdm_audio_set_i2s_output(bool enabled);
bool pdm_audio_get_i2s_output(void);

int lc3_decoder_start(void);
int lc3_decoder_stop(void);

/**
 *  @brief Select which PDM channel(s) feed the CPU mixer (left/right/stereo-mix).
 */
int pdm_audio_stream_set_channel(pdm_channel_t channel);

pdm_channel_t pdm_audio_stream_get_channel(void);

bool pdm_audio_stream_is_initialized(void);

#endif /* PDM_AUDIO_STREAM_H */
