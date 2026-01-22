/**
 * @file task_audio_loopback.h
 * @brief Simple PDM→I2S Audio Loopback System for nRF5340
 * 
 * Based on MentraOS task_lc3_codec.c implementation
 * Provides real-time audio loopback: PDM microphone → I2S output
 * 
 * Hardware Configuration:
 * - PDM: P1.12 (CLK), P1.11 (DIN) 
 * - I2S: P1.06 (LRCK), P1.07 (BCLK), P1.08 (SDIN)
 * 
 * Audio Format:
 * - Sample Rate: 16kHz
 * - Bit Depth: 16-bit
 * - Frame Size: 10ms (160 samples)
 * - Channels: Mono (PDM) → Stereo (I2S)
 */

#ifndef TASK_AUDIO_LOOPBACK_H
#define TASK_AUDIO_LOOPBACK_H

#include <zephyr/kernel.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Audio Configuration - Based on MentraOS implementation */
#define AUDIO_SAMPLE_RATE       16000    // 16kHz sample rate
#define AUDIO_FRAME_DURATION_MS 10       // 10ms frame duration
#define AUDIO_SAMPLES_PER_FRAME (AUDIO_SAMPLE_RATE * AUDIO_FRAME_DURATION_MS / 1000)  // 160 samples
#define AUDIO_PCM_BUFFER_SIZE   AUDIO_SAMPLES_PER_FRAME  // 160 samples

/**
 * @brief Initialize audio loopback task
 * 
 * Creates and starts the audio loopback task that handles:
 * 1. PDM microphone initialization and sampling
 * 2. I2S audio output initialization
 * 3. Real-time audio loopback processing
 */
void task_audio_loopback_init(void);

/**
 * @brief Get audio loopback task status
 * 
 * @return true if audio loopback is running, false otherwise
 */
bool task_audio_loopback_is_running(void);

/**
 * @brief Stop audio loopback task
 */
void task_audio_loopback_stop(void);

#ifdef __cplusplus
}
#endif

#endif // TASK_AUDIO_LOOPBACK_H
